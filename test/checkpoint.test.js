import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica, Network, VersionVector } from '../src/index.js';
import { idKey } from '../src/id.js';

function syncedPair() {
  const a = new Replica('a');
  const b = new Replica('b');
  return { a, b, net: new Network({ a, b }) };
}

test('checkpoint：丢弃 tombstone 后文本不变、继续编辑与合并正确', () => {
  const { a, b, net } = syncedPair();
  a.localInsert(0, 'hello world');
  net.syncAll();
  a.localDelete(6, 5); // 删 "world"
  net.syncAll();
  assert.equal(a.text(), 'hello ');
  assert.equal(a.tombstoneCount, 5);

  const bar = net.barrierOf();
  const ra = a.checkpoint(bar);
  const rb = b.checkpoint(bar);
  assert.equal(ra.removed, 5);
  assert.equal(rb.removed, 5);
  assert.equal(a.tombstoneCount, 0);
  assert.equal(a.nodes.size, 6);
  assert.equal(a.text(), 'hello ');
  assert.equal(b.text(), 'hello ');

  // 压缩后继续并发编辑
  a.localInsert(a.length, 'A');
  b.localInsert(b.length, 'B');
  net.syncAll();
  assert.equal(a.text(), b.text());
});

test('checkpoint：pending 未清空时拒绝压缩', () => {
  const { a, b } = syncedPair();
  const ins = a.localInsert(0, 'xyz');
  const del = a.localDeleteByIds([ins.id]);
  b.receive(del); // 缓冲
  const bar = VersionVector.barrier([a.vv, b.vv]);
  assert.throws(() => b.checkpoint(bar), /未应用/);
});

test('checkpoint：barrier 未被本副本包含时拒绝压缩（缺口保护）', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const net = new Network({ a, b });
  a.localInsert(0, 'abc');
  // b 完全没有收 a 的操作；barrier 中 a 分量为 0，可压缩；
  // 但人为构造一个 b 未达到的 barrier
  const tooHigh = new VersionVector({ a: 1 });
  assert.throws(() => b.checkpoint(tooHigh), /尚未收齐/);
  net.syncAll();
  assert.doesNotThrow(() => a.checkpoint(net.barrierOf()));
});

test('checkpoint：屏障后插入锚定被丢弃节点，经转发重定位仍收敛', () => {
  const { a, b, net } = syncedPair();
  const first = a.localInsert(0, 'AB');
  net.syncAll();
  // 删除 B 并共同压缩（B 的节点被物理丢弃）
  const bId = a.linearize()[1].id;
  a.localDeleteByIds([bId]);
  net.syncAll();
  a.checkpoint(net.barrierOf());
  b.checkpoint(net.barrierOf());
  assert.equal(a.nodes.has(idKey(bId)), false);

  // 手工构造一个“在已丢弃的 B 后插入”的操作（模拟迟到副本基于旧状态发起）
  a.counter += 1;
  a.lamport += 1;
  const op = {
    type: 'insert',
    id: { ts: a.lamport, origin: 'a', counter: a.counter, seq: 0 },
    ts: a.lamport,
    origin: 'a',
    counter: a.counter,
    anchor: { ...bId },
    chars: ['Z'],
  };
  // 经正常 receive 路径进入（重复检测等照常工作）
  a.receive(op);
  b.receive(op);
  assert.equal(a.text(), 'AZ');
  assert.equal(b.text(), 'AZ');
});

test('checkpoint：迟到的删除（目标已被压缩丢弃）按 no-op 处理且收敛', () => {
  const { a, b, net } = syncedPair();
  const first = a.localInsert(0, 'AB');
  const aId = a.linearize()[0].id;
  const bId = a.linearize()[1].id;
  net.syncAll();
  a.localDeleteByIds([bId]);
  net.syncAll();
  a.checkpoint(net.barrierOf());
  b.checkpoint(net.barrierOf());

  // 一个“屏障前本应存在”的删除，在压缩后才到达（例如离线极久的第三方）
  const lateDel = {
    type: 'delete',
    id: { ts: 500, origin: 'late', counter: 1, seq: 0 },
    ts: 500,
    origin: 'late',
    counter: 1,
    targets: [{ ...bId }],
  };
  const r = a.receive(lateDel);
  assert.equal(r.status, 'applied'); // 不永久缓冲
  assert.equal(a.text(), 'A');

  // 若迟到删除同时还想删一个存活节点 A，也应正确生效
  const mixed = {
    type: 'delete',
    id: { ts: 501, origin: 'late', counter: 2, seq: 0 },
    ts: 501,
    origin: 'late',
    counter: 2,
    targets: [{ ...bId }, { ...aId }],
  };
  a.receive(mixed);
  assert.equal(a.text(), '');
  void first;
});

test('checkpoint：多副本相同 barrier 压缩后结构一致、文本一致', () => {
  const ids = ['p', 'q', 's'];
  const replicas = Object.fromEntries(ids.map((i) => [i, new Replica(i)]));
  const net = new Network(replicas);
  replicas.p.localInsert(0, 'common');
  net.syncAll();
  replicas.p.localDelete(2, 2); // 删 "mm"
  replicas.q.localInsert(replicas.q.length, 'Q');
  replicas.s.localInsert(replicas.s.length, 'S');
  net.syncAll();

  const bar = net.barrierOf();
  for (const id of ids) replicas[id].checkpoint(bar);
  for (const id of ids) {
    assert.equal(replicas[id].text(), replicas.p.text());
    assert.equal(replicas[id].nodes.size, replicas.p.nodes.size);
  }
  // 再次 checkpoint 是幂等安全的
  const bar2 = net.barrierOf();
  for (const id of ids) {
    const res = replicas[id].checkpoint(bar2);
    assert.equal(res.removed, 0);
  }
});
