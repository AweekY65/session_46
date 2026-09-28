import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica, computeCheckpoint, idToStr, idFromStr } from '../src/crdt.js';

// ---------------------------------------------------------------------------
// 1. 基础操作：插入 / 删除 / 追加
// ---------------------------------------------------------------------------

test('单副本：插入、追加、删除得到正确文本', () => {
  const r = new Replica('r1');
  r.insertText(0, 'Hello');
  assert.equal(r.text(), 'Hello');

  r.insertText(5, ' World');
  assert.equal(r.text(), 'Hello World');

  r.insertText(5, ',');
  assert.equal(r.text(), 'Hello, World');

  r.deleteText(5, 1); // 删除刚插入的逗号
  assert.equal(r.text(), 'Hello World');

  r.deleteText(0, 6); // 删除 "Hello "
  assert.equal(r.text(), 'World');
});

test('删除越界位置被钳制，空字符串插入不产生操作', () => {
  const r = new Replica('r1');
  r.appendText('abc');
  assert.deepEqual(r.insertText(0, ''), []);
  r.deleteText(100, 5); // 越界：什么都不删
  assert.equal(r.text(), 'abc');
  r.deleteText(-10, 100); // 负位置钳到 0，长度超界截断
  assert.equal(r.text(), '');
});

test('支持多字节字符（emoji / 中文）按 code point 正确处理', () => {
  const r = new Replica('r1');
  r.appendText('你好🌟世界');
  assert.equal(r.text(), '你好🌟世界');
  r.deleteText(2, 1); // 删除 🌟
  assert.equal(r.text(), '你好世界');
  r.insertText(2, '🌟');
  assert.equal(r.text(), '你好🌟世界');
});

test('ID 字符串序列化往返稳定', () => {
  const id = { counter: 42, replicaId: 'r1' };
  assert.equal(idToStr(id), '42@r1');
  assert.deepEqual(idFromStr('42@r1'), id);
});

// ---------------------------------------------------------------------------
// 2. 双副本并发
// ---------------------------------------------------------------------------

test('双副本：同一文档独立编辑后合并收敛', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a); // 初始同步：两者都是 abc

  // 离线并发编辑
  a.insertText(3, 'X');   // a: abcX
  b.insertText(3, 'Y');   // b: abcY

  a.sync(b);
  assert.equal(a.text(), b.text());
  // 确定性规则：lamport 相同 -> replicaId 字典序 r1 < r2，r1 的 X 排前
  assert.equal(a.text(), 'abcXY');
});

test('双副本：并发插入同一位置（中间）顺序确定且与投递顺序无关', () => {
  // 场景：基线 AC，r1 在 A 后插 X，r2 在 A 后插 Y（同一锚点，真正并发）。
  const build = () => {
    const a = new Replica('r1');
    const b = new Replica('r2');
    a.appendText('AC');
    b.pullFrom(a);
    const opsA = a.insertText(1, 'X'); // AX C
    const opsB = b.insertText(1, 'Y'); // AY C
    return { a, b, opsA, opsB };
  };

  // 顺序 1：A 的操作先到达
  let { a, b, opsA, opsB } = build();
  a.receiveOps(opsB);
  b.receiveOps(opsA);
  assert.equal(a.text(), b.text());
  assert.equal(a.text(), 'AXYC'); // r1 < r2 字典序决胜

  // 顺序 2：B 的操作先到达（反向投递，结果必须相同）
  ({ a, b, opsA, opsB } = build());
  b.receiveOps(opsA);
  a.receiveOps(opsB);
  assert.equal(a.text(), b.text());
  assert.equal(a.text(), 'AXYC');
});

test('双副本：并发插入与删除', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);

  // a 删除 'b'；b 在 'b' 后面插入 'X'
  a.deleteText(1, 1);  // ac
  b.insertText(2, 'X'); // abXc —— 以 b 为左锚点

  a.sync(b);
  assert.equal(a.text(), b.text());
  // b 是墓碑，但 X 以 b 为锚点仍保留在结构里，位于 a 和 c 之间
  assert.equal(a.text(), 'aXc');
});

test('双副本：两边删除不同字符', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abcde');
  b.pullFrom(a);
  a.deleteText(0, 1); // 删除 a
  b.deleteText(4, 1); // 删除 e
  a.sync(b);
  assert.equal(a.text(), 'bcd');
});

test('双副本：两边删除同一字符（幂等，不会出错）', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  const da = a.deleteText(1, 1);
  const db = b.deleteText(1, 1);
  a.receiveOps(db);
  b.receiveOps(da);
  assert.equal(a.text(), 'ac');
  assert.equal(b.text(), 'ac');
});

// ---------------------------------------------------------------------------
// 3. 重复操作
// ---------------------------------------------------------------------------

test('重复接收同一操作不会被重复应用', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  const ops = a.opsSince({});

  assert.equal(ops.length, 3);            // appendText('abc') 拆成 3 个 insert
  assert.equal(b.receiveOps(ops), 3);     // 首次全部整合
  assert.equal(b.text(), 'abc');

  const again = b.receiveOps(ops);        // 再来一遍
  assert.equal(again, 0);
  assert.equal(b.text(), 'abc');

  // 单条重复
  for (const op of ops) assert.equal(b.receive(op), false);
  assert.equal(b.text(), 'abc');
});

test('重复接收删除操作不会重复删除其他字符', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  const del = a.deleteText(1, 1);
  b.receiveOps(del);
  b.receiveOps(del);
  b.receiveOps(del);
  assert.equal(b.text(), 'ac');
});
