import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica, Network, makeRng } from '../src/index.js';

function makePeers(ids) {
  const replicas = Object.fromEntries(ids.map((id) => [id, new Replica(id)]));
  return replicas;
}

test('双副本：并发编辑后交换操作收敛', () => {
  const { a, b } = makePeers(['a', 'b']);
  const net = new Network({ a, b });

  const base = a.localInsert(0, 'Hello');
  net.broadcast('a');
  a.localInsert(5, ', A');
  b.localInsert(5, ', B');
  b.localInsert(b.length, '!');

  net.syncAll();
  assert.equal(a.text(), b.text());
  assert.equal(a.text().startsWith('Hello'), true);
  assert.equal(a.text().includes('A'), true);
  assert.equal(a.text().includes('B'), true);
});

test('多副本（4 个）：全连接反熵最终一致', () => {
  const ids = ['r1', 'r2', 'r3', 'r4'];
  const replicas = makePeers(ids);
  const net = new Network(replicas, { rng: makeRng(42) });

  // 各自在本地做插入与删除
  replicas.r1.localInsert(0, 'one-');
  replicas.r2.localInsert(0, 'two-');
  replicas.r3.localInsert(0, 'three-');
  replicas.r4.localInsert(0, 'four-');

  // 只做两两部分交换（信息靠多跳传播）
  net.exchange('r1', 'r2');
  net.exchange('r3', 'r4');
  net.exchange('r2', 'r3');
  net.exchange('r1', 'r4');
  net.exchange('r2', 'r4');

  assert.equal(net.allConverged(), true);
  for (const id of ['one-', 'two-', 'three-', 'four-']) {
    assert.equal(replicas.r1.text().includes(id), true);
  }
});

test('乱序传递：shuffle 随机投递仍收敛（固定种子可复现）', () => {
  const { a, b, c } = makePeers(['a', 'b', 'c']);
  const net = new Network({ a, b, c }, { rng: makeRng(7) });

  for (let i = 0; i < 20; i++) {
    const r = [a, b, c][i % 3];
    r.localInsert(r.length, String.fromCharCode(97 + i));
  }
  // 以随机乱序把 a 的操作喂给 b，b 的操作喂给 c ...
  net.shuffleDeliver('a', 'b');
  net.shuffleDeliver('b', 'c');
  net.shuffleDeliver('c', 'a');
  net.shuffleDeliver('a', 'c');
  net.shuffleDeliver('b', 'a');
  net.shuffleDeliver('c', 'b');
  net.syncAll();

  assert.equal(net.allConverged(), true);
  assert.equal(a.text().length, 20);
});

test('重复投递：duplicate 广播不改变结果', () => {
  const { a, b } = makePeers(['a', 'b']);
  const net = new Network({ a, b });
  for (let i = 0; i < 10; i++) a.localInsert(i, 'x');
  net.broadcast('a', { duplicate: true }); // 每个操作投递两次
  assert.equal(b.text(), 'xxxxxxxxxx');
  assert.equal(b.appliedOps.length, 10);
  // 再来一轮仍稳定
  net.broadcast('a', { duplicate: true });
  assert.equal(b.text(), 'xxxxxxxxxx');
  assert.equal(b.appliedOps.length, 10);
});

test('网络分区：分区期间各自编辑，heal 后滞留消息补发并收敛', () => {
  const { a, b, c } = makePeers(['a', 'b', 'c']);
  const net = new Network({ a, b, c });

  // 共同历史
  a.localInsert(0, 'doc');
  net.syncAll();

  // 分区：{a,b} | {c}
  net.partition([
    ['a', 'b'],
    ['c'],
  ]);
  a.localInsert(a.length, '-AB-side');
  b.localInsert(b.length, '-AB-edit');
  c.localInsert(c.length, '-C-side');

  // 分区内同步
  net.syncAll();
  assert.equal(a.text(), b.text());
  assert.notEqual(a.text(), c.text());

  // 分区内广播发给不可达方：消息滞留（broadcast 对不可达目标返回空，但入队）
  net.broadcast('c'); // c -> a/b 不可达
  assert.ok(net.heldCount('c') > 0);
  assert.equal(a.text().includes('C-side'), false);

  // 恢复：滞留消息自动补发，再全量同步
  net.heal();
  net.syncAll();
  assert.equal(net.allConverged(), true);
  assert.equal(a.text().includes('AB-side'), true);
  assert.equal(a.text().includes('AB-edit'), true);
  assert.equal(a.text().includes('C-side'), true);
});

test('网络分区：分区两侧并发删除不同字符，合并后收敛', () => {
  const { a, b } = makePeers(['a', 'b']);
  const net = new Network({ a, b });
  a.localInsert(0, 'ABCDEF');
  net.syncAll();

  net.partition([['a'], ['b']]);
  a.localDelete(0, 2); // 删 AB
  b.localDelete(4, 2); // 删 EF
  net.heal();
  net.syncAll();

  assert.equal(a.text(), 'CD');
  assert.equal(a.text(), b.text());
});

test('网络分区：同一字符两侧分别删除/在其后插入，合并语义确定', () => {
  const { a, b } = makePeers(['a', 'b']);
  const net = new Network({ a, b });
  const base = a.localInsert(0, 'X');
  net.syncAll();
  const xId = a.linearize()[0].id;

  net.partition([['a'], ['b']]);
  a.localDeleteByIds([xId]);      // a 侧删掉 X
  b.localInsert(1, 'Y');         // b 侧在 X 后插入 Y
  net.heal();
  net.syncAll();

  // 删除胜出（tombstone），Y 保留：结果确定地为 'Y'
  assert.equal(a.text(), 'Y');
  assert.equal(b.text(), 'Y');
});

test('最终收敛：长时随机编辑 + 间歇同步（谣言传播风格）', () => {
  const ids = ['n0', 'n1', 'n2', 'n3', 'n4'];
  const replicas = makePeers(ids);
  const rng = makeRng(2024);
  const net = new Network(replicas, { rng });

  for (let round = 0; round < 300; round++) {
    const r = replicas[ids[Math.floor(rng.next() * ids.length)]];
    if (r.length > 0 && rng.next() < 0.35) {
      const idx = Math.floor(rng.next() * r.length);
      const len = Math.min(r.length - idx, 1 + Math.floor(rng.next() * 2));
      r.localDelete(idx, len);
    } else {
      r.localInsert(r.length, String.fromCharCode(97 + Math.floor(rng.next() * 26)));
    }
    // 随机与另一个副本交换
    const other = replicas[ids[Math.floor(rng.next() * ids.length)]];
    if (other !== r) net.exchange(r.origin, other.origin);
  }
  net.syncAll(500);
  assert.equal(net.allConverged(), true);
});
