import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica } from '../src/index.js';
import { idKey } from '../src/id.js';

test('本地编辑：插入、片段插入、删除与幂等删除', () => {
  const r = new Replica('r1');
  r.localInsert(0, 'hello');
  assert.equal(r.text(), 'hello');
  r.localInsert(5, ' world'); // 片段（多字符一次操作，链内保序）
  assert.equal(r.text(), 'hello world');
  r.localDelete(0, 6); // 删除 "hello "
  assert.equal(r.text(), 'world');
  // 再次删除同一批 id 仍然安全
  const ids = r.linearize().filter((n) => !n.deleted).map((n) => n.id);
  const op = r.localDeleteByIds(ids);
  assert.equal(r.text(), '');
  r.receive(op); // 自己重放自己的删除 -> duplicate
  assert.equal(r.text(), '');
});

test('本地编辑：位置越界抛错', () => {
  const r = new Replica('r1');
  r.localInsert(0, 'ab');
  assert.throws(() => r.localInsert(5, 'x'), RangeError);
  assert.throws(() => r.localDelete(1, 2), RangeError);
  assert.throws(() => r.localInsert(0, ''), /非空/);
});

test('操作 ID：全局唯一稳定，片段内 seq 递增', () => {
  const r = new Replica('r1');
  const op = r.localInsert(0, 'abc');
  assert.equal(op.origin, 'r1');
  assert.equal(op.counter, 1);
  const keys = r.linearize().map((n) => idKey(n.id));
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys.map((k) => Number(k.split(':')[3])), [0, 1, 2]);
  assert.equal(keys[0].startsWith('1:r1:1:'), true);
});

test('远程合并：重复操作不重复应用（含 gap 场景）', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const o1 = a.localInsert(0, 'xy'); // counter 1
  const o2 = a.localInsert(2, 'z');  // counter 2
  // #2 先到 -> 缓冲
  assert.equal(b.receive(o2).status, 'buffered');
  // #2 立刻重放 -> duplicate，不产生第二条缓冲
  assert.equal(b.receive(o2).status, 'duplicate');
  assert.equal(b.pending.length, 1);
  // #1 到达 -> #2 联动应用
  assert.equal(b.receive(o1).status, 'applied');
  assert.equal(b.text(), 'xyz');
  // 之后两者重放都 duplicate
  assert.equal(b.receive(o1).status, 'duplicate');
  assert.equal(b.receive(o2).status, 'duplicate');
  assert.equal(b.text(), 'xyz');
});

test('延迟删除：删除操作先于目标插入到达，补齐后状态正确', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const ins = a.localInsert(0, 'hello');
  const del = a.localDeleteByIds([ins.id]); // 删除 'h'
  // 逆序投递：del 先到
  assert.equal(b.receive(del).status, 'buffered');
  assert.equal(b.pending.length, 1);
  assert.equal(b.receive(ins).status, 'applied'); // 补齐并联动应用 del
  assert.equal(b.pending.length, 0);
  assert.equal(b.text(), 'ello');
});

test('延迟删除：多目标部分缺失时整体缓冲，逐个补齐', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const o1 = a.localInsert(0, 'abc');
  const o2 = a.localInsert(3, 'def');
  // 删除两个片段里各一个字符
  const nodes = a.linearize();
  const target1 = nodes[0].id; // a
  const target6 = nodes[5].id; // f
  const del = a.localDeleteByIds([target1, target6]);
  assert.equal(b.receive(del).status, 'buffered');
  b.receive(o1); // 只补了 target1，仍应缓冲
  assert.equal(b.pending.length, 1);
  b.receive(o2);
  assert.equal(b.pending.length, 0);
  assert.equal(b.text(), 'bcde');
});

test('并发同位置插入：Lamport 规则下确定性排序，双方收敛', () => {
  const a = new Replica('alice');
  const b = new Replica('bob');
  // 共同前缀
  const base = a.localInsert(0, '|');
  b.receive(base);
  // 都在 '|' 之后（index 1）并发插入：
  // a 没接收过其他操作，ts=2；b 接收过 base，本地 ts=max(1,1)+1=2，
  // 随后本地插入取 lamport+1=3 —— b 的插入 Lamport 时间戳更大，排前
  const x = a.localInsert(1, 'X');
  const y = b.localInsert(1, 'Y');
  b.receive(x);
  a.receive(y);
  assert.equal(a.text(), b.text());
  assert.equal(a.text(), '|YX');
});

test('并发同位置插入：同 Lamport 时间戳时按 origin 字典序平局仲裁', () => {
  // 构造真正的 ts 平局：双方都只基于同一状态各产生一个操作
  const make = (origin, ch, base) => {
    const r = new Replica(origin);
    r.receive(base);
    return { r, op: r.localInsert(1, ch) };
  };
  const seed = new Replica('seed');
  const base = seed.localInsert(0, '|');
  const { r: a, op: x } = make('alice', 'X', base);
  const { r: b, op: y } = make('bob', 'Y', base);
  assert.equal(x.ts, y.ts); // 真正的并发：时间戳相同
  a.receive(y);
  b.receive(x);
  assert.equal(a.text(), b.text());
  assert.equal(a.text(), '|XY'); // origin 字典序 alice < bob -> X 在前
});

test('确定性：同样操作集合，不同到达顺序，结果相同', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const c = new Replica('c');
  a.localInsert(0, 'aaa');
  b.localInsert(0, 'bbb');
  c.localInsert(0, 'ccc');
  const ops = [
    ...a.appliedOps,
    ...b.appliedOps,
    ...c.appliedOps,
  ];
  const r1 = new Replica('m1');
  const r2 = new Replica('m2');
  const r3 = new Replica('m3');
  for (const op of ops) r1.receive(op); // 原顺序
  for (const op of [...ops].reverse()) r2.receive(op); // 完全逆序
  // 交错乱序（ops 共 3 个，每个为 3 字符片段）
  const shuffled = [ops[1], ops[2], ops[0]];
  for (const op of shuffled) r3.receive(op);
  assert.equal(r1.text(), r2.text());
  assert.equal(r2.text(), r3.text());
});

test('并发插入 + 删除交叉：收敛且删除语义一致', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const base = a.localInsert(0, 'AB');
  b.receive(base);
  // a 删除 B；b 同时在 B 后面插入 C
  const nodesA = a.linearize();
  const delB = a.localDeleteByIds([nodesA[1].id]);
  const insC = b.localInsert(2, 'C');
  a.receive(insC);
  b.receive(delB);
  assert.equal(a.text(), 'AC');
  assert.equal(b.text(), 'AC');
});

test('Unicode：按码点处理 emoji 片段', () => {
  const r = new Replica('u');
  r.localInsert(0, 'a😀b');
  assert.equal(r.length, 3);
  assert.equal(r.text(), 'a😀b');
  r.localDelete(1, 1);
  assert.equal(r.text(), 'ab');
});

test('已知操作集合包含缓冲中的操作，可用于反熵传播', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const c = new Replica('c');
  const ins = a.localInsert(0, 'hi');
  const del = a.localDeleteByIds([ins.id]);
  b.receive(del); // b 缓冲了 del
  // c 从 b 拿到 del（仍缓冲），再从 a 拿到 ins，联动应用
  for (const op of b.knownOps()) c.receive(op);
  assert.equal(c.pending.length, 1);
  c.receive(ins);
  assert.equal(c.text(), 'i');
});
