import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica, computeCheckpoint, idToStr } from '../src/crdt.js';
import { makeRng, shuffle } from './helpers.js';

// ---------------------------------------------------------------------------
// 4. 乱序投递与延迟删除（依赖缺失 -> pending -> 补齐）
// ---------------------------------------------------------------------------

test('乱序投递：插入操作先于其锚点到达，补齐后自动整合', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');

  // a 依次产生 'a' -> 'b'(锚a) -> 'c'(锚b)
  a.appendText('abc');
  const ops = a.opsSince({});

  // 把 c 先发给 b：锚点 b 尚不存在
  const [opA, opB, opC] = ops;
  assert.equal(b.receive(opC), true);
  assert.equal(b.text(), '');
  assert.equal(b.pending.size, 1);

  b.receive(opA); // 只有 a，c 仍缺 b
  assert.equal(b.text(), 'a');
  assert.equal(b.pending.size, 1);

  b.receive(opB); // b 到齐 -> 触发 drain，c 自动整合
  assert.equal(b.pending.size, 0);
  assert.equal(b.text(), 'abc');
});

test('延迟删除：删除操作先于目标插入到达，补齐插入后删除生效', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');

  a.appendText('ab');
  b.pullFrom(a);

  // a 再插入 X 并删除它（delete 引用 insert X）
  const ins = a.insertText(2, 'X');
  const del = a.deleteText(2, 1);
  assert.equal(a.text(), 'ab');

  // 只把 delete 先发给 b：目标 X 未知
  assert.equal(b.receive(del[0]), true);
  assert.equal(b.pending.size, 1);
  assert.equal(b.text(), 'ab');

  // 再发 insert：两者齐备，X 出现即为墓碑
  b.receiveOps(ins);
  assert.equal(b.pending.size, 0);
  assert.equal(b.text(), 'ab');
  assert.equal(b.stats().alive, 2);
  assert.equal(b.stats().total, 3); // 墓碑 X 仍在
});

test('多层 pending 链：多级锚点依赖按逆序到达后一次补齐', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abcdef'); // 每个字符锚在前一个上：b->a, c->b, ...
  const ops = a.opsSince({});

  // 完全逆序投递：f, e, d, c, b（保留 a 最后到）
  for (const op of ops.slice(1).reverse()) b.receive(op);
  assert.equal(b.text(), '');
  assert.equal(b.pending.size, 5); // b..f 全部挂起（连 b 的锚点 a 都没到）

  // 最后一个依赖（a）到达，整链级联整合
  b.receive(ops[0]);
  assert.equal(b.pending.size, 0);
  assert.equal(b.text(), 'abcdef');
});

test('完全乱序（洗牌）批量投递仍与顺序投递结果一致', () => {
  const rng = makeRng(1234);
  const source = new Replica('src');
  source.appendText('convergence');
  source.insertText(5, '!!');
  source.deleteText(0, 3);
  const ops = source.opsSince({});

  const ordered = new Replica('dst1');
  ordered.receiveOps(ops);

  const shuffled = new Replica('dst2');
  shuffled.receiveOps(shuffle(rng, ops));

  assert.equal(shuffled.text(), ordered.text());
  assert.equal(shuffled.text(), source.text());
});

// ---------------------------------------------------------------------------
// 5. 多副本（3 方及以上）并发
// ---------------------------------------------------------------------------

test('三副本并发：各自插入，任意合并拓扑最终一致', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  const c = new Replica('r3');
  a.appendText('go');
  b.pullFrom(a);
  c.pullFrom(a);

  a.insertText(2, '1');
  b.insertText(2, '2');
  c.insertText(2, '3');

  // 非对称合并：a<->b，然后 b<->c，最后 a<->c（环形）
  a.sync(b);
  b.sync(c);
  a.sync(c);

  assert.equal(a.text(), b.text());
  assert.equal(b.text(), c.text());
  // lamport 相同（都基于同一时钟基线 +1），按副本 ID 决胜：r1,r2,r3
  assert.equal(a.text(), 'go123');
});

test('三副本：Lamport 决胜——时钟更高的并发插入排在前', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  const c = new Replica('r3');
  a.appendText('xy');
  b.pullFrom(a); // b 时钟 = 2
  c.pullFrom(a); // c 时钟 = 2

  // c 额外做一次本地操作，使其 Lamport 时钟领先
  c.appendText('z'); // c: xyz，时钟 = 3（不影响 x 锚点下的并发）

  // b 与 c 都在 x 之后插入同一位置；c 的 lamport 更大
  const opB = b.insertText(1, 'B'); // lamport 3
  const opC = c.insertText(1, 'C'); // lamport 4

  a.receiveOps(opB);
  a.receiveOps(opC);
  // 不同的接收顺序在另一个副本上再验一次（先 C 后 B）
  const a2 = new Replica('r4');
  a2.pullFrom(a);
  a2.receiveOps(opC);
  a2.receiveOps(opB);

  // 同锚点 x：lamport 高的 C 排前，与到达顺序、副本 ID 均无关
  assert.equal(a.text(), 'xCBy');
  assert.equal(a2.text(), 'xCBy');
});

test('多副本多轮并发编辑，任意合并顺序收敛（fuzz）', () => {
  const rng = makeRng(20260926);
  const N = 4;
  const replicas = Array.from({ length: N }, (_, i) => new Replica(`r${i}`));
  replicas[0].appendText('seed');
  for (let i = 1; i < N; i++) replicas[i].pullFrom(replicas[0]);

  const letters = 'ABCDEFGH';
  // 每副本各自做若干轮离线编辑
  for (let round = 0; round < 6; round++) {
    for (const r of replicas) {
      const t = r.text();
      const pos = Math.floor(rng() * (t.length + 1));
      r.insertText(pos, letters[Math.floor(rng() * letters.length)]);
      if (t.length > 2 && rng() < 0.5) {
        const dpos = Math.floor(rng() * Math.min(t.length, 4));
        r.deleteText(dpos, 1);
      }
    }
  }

  // 用一个“收集者”以随机顺序逐条收到所有操作（最强乱序场景）
  const allOps = new Map();
  for (const r of replicas) for (const op of r.log.values()) allOps.set(idToStr(op.id), op);
  const collector = new Replica('collector');
  collector.receiveOps(shuffle(rng, [...allOps.values()]));

  // 各副本间做随机两两合并直到无法再传播
  for (let k = 0; k < 20; k++) {
    const i = Math.floor(rng() * N);
    const j = Math.floor(rng() * N);
    if (i !== j) replicas[i].sync(replicas[j]);
  }
  for (let i = 1; i < N; i++) replicas[0].sync(replicas[i]);
  for (let i = 1; i < N; i++) replicas[i].pullFrom(replicas[0]);

  for (const r of replicas) assert.equal(r.text(), collector.text());
});

// ---------------------------------------------------------------------------
// 6. 网络分区模拟
// ---------------------------------------------------------------------------

test('网络分区：分裂期间两侧各自编辑，恢复后合并收敛', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('the document');
  b.pullFrom(a);

  // —— 分区开始 ——
  a.insertText(0, '[LEFT] ');
  a.deleteText(8, 1); // 左组删掉一个字符（索引基于左组视图）

  b.appendText(' [RIGHT]');
  b.insertText(3, 'X');

  // 分区期间互不可见
  assert.ok(!a.text().includes('RIGHT'));
  assert.ok(!b.text().includes('LEFT'));

  // —— 分区恢复，交换全部操作 ——
  a.sync(b);
  assert.equal(a.text(), b.text());
  assert.match(a.text(), /LEFT/);
  assert.match(a.text(), /RIGHT/);
});

test('网络分区：三区轮辐式合并（A-B、B-C 间接传播）', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  const c = new Replica('r3');
  a.appendText('=');
  b.pullFrom(a);
  c.pullFrom(a);

  a.appendText('a');
  b.appendText('b');
  c.appendText('c');

  a.sync(b);       // a,b 互知
  b.sync(c);       // c 经 b 间接得到 a 的操作
  c.sync(a);       // 补全
  a.sync(c);

  assert.equal(a.text(), b.text());
  assert.equal(b.text(), c.text());
});

// ---------------------------------------------------------------------------
// 7. 版本向量
// ---------------------------------------------------------------------------

test('版本向量正确反映已见操作，乱序时不跨越空洞', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc'); // r1:1,2,3
  const [op1, op2, op3] = a.opsSince({});

  b.receive(op3);
  assert.deepEqual(b.versionVector(), {}); // 空洞：1、2 未到，VV 不推进
  b.receive(op1);
  assert.deepEqual(b.versionVector(), { r1: 1 });
  b.receive(op2);
  assert.deepEqual(b.versionVector(), { r1: 3 }); // 连续段补齐
});

test('opsSince 基于版本向量只传缺口', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  a.appendText('de');
  const missing = a.opsSince(b.versionVector());
  assert.equal(missing.length, 2);
});

test('computeCheckpoint 取全员共同前沿', () => {
  const cp = computeCheckpoint([
    { r1: 5, r2: 3 },
    { r1: 4, r2: 7 },
    { r1: 6, r2: 2 },
  ]);
  assert.deepEqual(cp, { r1: 4, r2: 2 });
});

// ---------------------------------------------------------------------------
// 8. tombstone GC / 历史压缩
// ---------------------------------------------------------------------------

test('未达全员检查点时不能压缩；压缩仅移除安全 tombstone', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  const target = a.visibleNodes()[2].id; // 末尾的 c（叶子节点，无后裔）
  a.deleteText(2, 1); // ab

  // b 还不知道删除操作
  assert.equal(a.canGarbageCollect(target, computeCheckpoint([a, b], ['r1', 'r2'])), false);

  b.pullFrom(a);
  const cp = computeCheckpoint([a, b], ['r1', 'r2']);
  assert.equal(a.canGarbageCollect(target, cp), true);

  const before = a.stats().total;
  const res = a.compact(cp);
  assert.ok(res.removed >= 1);
  assert.equal(a.text(), 'ab');       // 可见文本不变
  assert.equal(a.stats().total, before - res.removed);
});

test('非叶子 tombstone（链上仍挂着后续字符）在整条链全死之前保留', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  // 删除中间的 b：b 下挂着 c（c 是 b 的孩子，存活）
  a.deleteText(1, 1);
  b.pullFrom(a);
  const cp = computeCheckpoint([a, b], ['r1', 'r2']);

  const deadB = [...a.nodes.values()].find((n) => n.char === 'b');
  // 知识层面 b 已可回收，但结构层面 b 仍有存活后裔 c，compact 必须保留它
  assert.equal(deadB.deleted, true);
  assert.equal(a.canGarbageCollect(deadB.id, cp), true);
  let res = a.compact(cp);
  assert.equal(res.removed, 0);
  assert.equal(a.text(), 'ac');

  // 把 c 也删掉并全员同步后，整条死链 b->c 可以一起回收（a 为根孩子）
  a.deleteText(1, 1); // 删 c
  b.pullFrom(a);
  const cp2 = computeCheckpoint([a, b], ['r1', 'r2']);
  res = a.compact(cp2);
  assert.ok(res.removed >= 1);
  assert.equal(a.text(), 'a');
});

test('压缩后文本不变，且两副本压缩结果一致、仍可继续合并', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('hello world');
  b.pullFrom(a);
  a.deleteText(5, 1); // 删空格
  a.deleteText(0, 2); // 删 he
  b.appendText('!');  // b 也产生操作，保证检查点之后仍有新编辑
  a.sync(b);

  const cp = computeCheckpoint([a, b], ['r1', 'r2']);
  const textBefore = a.text();
  const resA = a.compact(cp);
  const resB = b.compact(cp);
  assert.deepEqual(resA, resB);
  assert.equal(a.text(), textBefore);
  assert.equal(a.text(), b.text());

  // 压缩后继续协同
  a.insertText(a.text().length, 'Z');
  b.insertText(0, 'Q');
  a.sync(b);
  assert.equal(a.text(), b.text());
});

test('tombstone 下仍有存活后裔时不会被压缩，后裔删除后才可回收', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('ab');
  b.pullFrom(a);

  // a 删 b；b 侧在 b 之后插入 X（X 的锚点是即将成为墓碑的 b）
  a.deleteText(1, 1); // a 视图 a
  b.insertText(2, 'X');

  a.sync(b);
  // 基线 ab：b 被删，X 以 b 为锚 -> a X
  assert.equal(a.text(), 'aX');

  const cp = computeCheckpoint([a, b], ['r1', 'r2']);
  // 被删的 b 仍有存活后裔 X：知识上可回收，但结构上 compact 必须保留它
  const deadB = [...a.nodes.values()].find((n) => n.char === 'b');
  assert.equal(deadB.deleted, true);
  assert.equal(a.canGarbageCollect(deadB.id, cp), true);
  let res = a.compact(cp);
  assert.equal(res.removed, 0);
  assert.equal(a.text(), 'aX');

  // 再把 X 删掉、全员同步后，死子树 b->X 才被一起物理移除
  a.deleteText(1, 1); // 删 X
  b.pullFrom(a);
  a.pullFrom(b);
  const cp2 = computeCheckpoint([a, b], ['r1', 'r2']);
  res = a.compact(cp2);
  assert.ok(res.removed >= 1);
  assert.equal(a.text(), 'a');
});

test('在未覆盖自己的检查点上压缩会抛错', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  a.appendText('zz'); // a 领先
  const cp = computeCheckpoint([a, b], ['r1', 'r2']); // r1 位 = 3，b 也是 3，合法
  assert.doesNotThrow(() => a.compact(cp));
  // 伪造一个超前检查点
  assert.throws(() => b.compact({ r1: 99, r2: 99 }), /超出本副本已知范围/);
});

// ---------------------------------------------------------------------------
// 9. 本地状态保存 / 恢复
// ---------------------------------------------------------------------------

test('内存快照 toJSON/fromJSON：恢复后继续合并与未中断一致', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  b.pullFrom(a);
  a.insertText(3, 'X');
  b.insertText(0, 'Y');

  // a 在“中途”（尚未收到 b 的 Y）做快照并恢复
  const snapshot = a.toJSON();
  const restored = Replica.fromJSON(snapshot);
  assert.equal(restored.text(), 'abcX');

  restored.sync(b);
  a.sync(b); // 未中断的 a 同样合并
  assert.equal(restored.text(), a.text());
});

test('pending 操作随快照持久化，恢复后依赖补齐仍能整合', () => {
  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('abc');
  const [opA, opB, opC] = a.opsSince({});

  b.receive(opC); // 只有 c，挂起
  const restored = Replica.fromJSON(b.toJSON());
  assert.equal(restored.pending.size, 1);
  restored.receive(opA);
  restored.receive(opB);
  assert.equal(restored.text(), 'abc');
});

test('文件保存/恢复：重启副本继续合并结果一致', async (t) => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'crdt-'));

  const a = new Replica('r1');
  const b = new Replica('r2');
  a.appendText('persist me');
  b.pullFrom(a);

  const file = path.join(tmp, 'replica-a.json');
  await a.save(file); // “关闭进程”

  // “重启”
  const a2 = await Replica.load(file);
  assert.equal(a2.text(), 'persist me');

  // 重启后并发编辑再合并
  a2.insertText(0, 'R:');
  b.appendText(' live');
  a2.sync(b);
  assert.equal(a2.text(), b.text());

  // 再保存再重启一次，文本保持
  await a2.save(file);
  const a3 = await Replica.load(file);
  assert.equal(a3.text(), a2.text());
  await fsp.rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 10. 最终收敛综合 fuzz：随机编辑 + 随机乱序 + 随机分区 + 重启
// ---------------------------------------------------------------------------

test('综合 fuzz：四副本随机编辑/随机投递/中途快照恢复，最终全部收敛', () => {
  const rng = makeRng(424242);
  const mk = (id) => new Replica(id);
  let a = mk('r1'), b = mk('r2'), c = mk('r3'), d = mk('r4');
  const peers = ['r1', 'r2', 'r3', 'r4'];
  a.appendText('start');
  for (const r of [b, c, d]) r.pullFrom(a);

  const alphabet = 'xy-';
  const edit = (r) => {
    const t = r.text();
    if (rng() < 0.65) {
      r.insertText(Math.floor(rng() * (t.length + 1)),
        alphabet[Math.floor(rng() * alphabet.length)]);
    } else if (t.length > 1) {
      r.deleteText(Math.floor(rng() * t.length), 1);
    }
  };

  const restart = (r) => Replica.fromJSON(r.toJSON()); // 模拟进程重启

  for (let round = 0; round < 10; round++) {
    for (const r of [a, b, c, d]) edit(r);
    // 随机投递：每个操作独立、可能延迟到下一轮
    let everyone = [a, b, c, d];
    for (const src of everyone) {
      for (const op of shuffle(rng, src.opsSince({}))) {
        if (rng() < 0.4) continue; // 丢包 / 延迟
        for (const dst of everyone) {
          if (dst !== src && rng() < 0.7) dst.receive(op);
        }
      }
    }
    if (round === 4) {
      // 中途全部重启
      [a, b, c, d] = [a, b, c, d].map(restart);
    }
  }

  // 反熵：全连接同步直到收敛
  for (let k = 0; k < 6; k++) for (const x of [a, b, c, d]) for (const y of [a, b, c, d]) x.sync(y);

  assert.equal(a.text(), b.text());
  assert.equal(b.text(), c.text());
  assert.equal(c.text(), d.text());
});
