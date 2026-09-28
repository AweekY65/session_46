import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica, Network, makeRng, VersionVector } from '../src/index.js';

/**
 * 属性测试（固定种子、可复现）：
 * 对同一操作流，无论用何种传递拓扑/顺序，全部副本最终必须收敛；
 * 且与一个“见到全部操作的参考副本”结果相同。
 */
function runFuzz(seed, peerCount, rounds, { restart = false, checkpoint = false } = {}) {
  const rng = makeRng(seed);
  const ids = Array.from({ length: peerCount }, (_, i) => `p${i}`);
  const replicas = Object.fromEntries(ids.map((id) => [id, new Replica(id)]));
  const net = new Network(replicas, { rng });
  const reference = new Replica('reference');

  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];

  for (let round = 0; round < rounds; round++) {
    const r = replicas[pick(ids)];
    if (r.length > 0 && rng.next() < 0.4) {
      const idx = Math.floor(rng.next() * r.length);
      const len = 1 + Math.floor(rng.next() * Math.min(3, r.length - idx));
      const op = r.localDelete(idx, len);
      reference.receive(op);
    } else {
      const ch = String.fromCharCode(97 + Math.floor(rng.next() * 26));
      const idx = Math.floor(rng.next() * (r.length + 1));
      const op =
        rng.next() < 0.5 ? r.localInsert(idx, ch) : r.localInsert(idx, ch + ch.toUpperCase());
      reference.receive(op);
    }

    // 随机连接两个副本交换（制造多跳、延迟、乱序）
    if (rng.next() < 0.75) {
      const [x, y] = [pick(ids), pick(ids)];
      if (x !== y) net.exchange(x, y);
    }
    // 偶发分区 + 恢复（checkpoint 场景保持全连通，专注压缩正确性）
    if (!checkpoint && round > 0 && round % 40 === 0) {
      const cut = 1 + Math.floor(rng.next() * (peerCount - 1));
      const g1 = ids.slice(0, cut);
      const g2 = ids.slice(cut);
      net.partition([g1, g2]);
    }
    if (round > 0 && round % 40 === 20) {
      net.heal();
    }
    // 周期性全量同步 + 压缩（所有副本一致 barrier）
    if (checkpoint && round > 0 && round % 50 === 49) {
      net.syncAll();
      const bar = net.barrierOf();
      for (const id of ids) replicas[id].checkpoint(bar);
    }
  }

  net.heal();
  net.syncAll(500);

  if (restart) {
    // 模拟全部副本在仍有操作在途时同时重启：从快照恢复后继续交换直至收敛
    for (const id of ids) {
      const json = replicas[id].toJSON();
      replicas[id] = Replica.fromJSON(json);
    }
    const net2 = new Network(replicas, { rng });
    net2.heal();
    net2.syncAll(500);
  }

  const expected = reference.text();
  for (const id of ids) {
    assert.equal(replicas[id].pending.length, 0, `${id} 存在未应用操作`);
    assert.equal(replicas[id].text(), expected, `${id} 与参考副本不一致`);
  }
  return expected;
}

test('模糊收敛：3 副本 / 400 轮随机编辑与部分交换', () => {
  runFuzz(1, 3, 400);
});

test('模糊收敛：5 副本 / 600 轮，含周期性分区', () => {
  runFuzz(99, 5, 600);
});

test('模糊收敛：4 副本 + 周期性 checkpoint，压缩后继续合并', () => {
  runFuzz(7, 4, 500, { checkpoint: true });
});

test('模糊收敛：4 副本，最终阶段全体从快照重启', () => {
  runFuzz(123, 4, 300, { restart: true });
});

test('模糊收敛：不同种子批量跑，全部必须收敛', () => {
  for (const seed of [2, 3, 5, 8, 13, 21, 34]) {
    runFuzz(seed, 4, 150, { checkpoint: seed % 2 === 0 });
  }
});

test('操作交换幂等：反复 exchange 不产生重复应用', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const net = new Network({ a, b });
  for (let i = 0; i < 50; i++) a.localInsert(i, String(i % 10));
  for (let i = 0; i < 5; i++) {
    net.exchange('a', 'b');
    net.exchange('b', 'a');
  }
  assert.equal(b.appliedOps.length, 50);
  assert.equal(b.text(), a.text());
  assert.ok(b.vv.dominates(new VersionVector({ a: 50 })));
});
