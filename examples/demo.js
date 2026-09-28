#!/usr/bin/env node
/**
 * 端到端演示（纯本地、无外部服务）：
 *   1. 三个离线副本并发编辑同一份文档；
 *   2. 制造乱序、重复投递与网络分区；
 *   3. 恢复后交换操作，三个副本收敛到同一文本；
 *   4. 全部副本确认后做 checkpoint，安全压缩 tombstone。
 *
 * 运行：node examples/demo.js
 */

import { Replica, Network, VersionVector } from '../src/index.js';

const line = (s) => console.log(s);
const NAMES = { a: 'alice', b: 'bob  ', c: 'carol' };
const show = (net) => {
  for (const [id, r] of Object.entries(net.replicas)) {
    line(`  ${NAMES[id] ?? id}: ${JSON.stringify(r.text())}`);
  }
};

const a = new Replica('a');
const b = new Replica('b');
const c = new Replica('c');
const net = new Network({ a, b, c });

line('— 1) alice 建立共同前缀并同步');
a.localInsert(0, 'Meeting notes');
net.syncAll();
show(net);

line('— 2) 分区：alice/bob 一组，carol 单独；各自并发编辑');
net.partition([
  ['a', 'b'],
  ['c'],
]);
a.localInsert(a.text().length, ' @10am');
b.localInsert(b.text().length, ' room A');
c.localInsert(c.text().length, ' (draft)');
net.syncAll(); // 仅分区内同步
show(net);

line('— 3) 分区内消息滞留 + 乱序投递（不影响最终结果）');
net.broadcast('c'); // carol 的消息暂存在不可达目标
net.shuffleDeliver('a', 'b');

line('— 4) 分区恢复，滞留消息补发，全量反熵交换');
net.heal();
net.syncAll();
show(net);
line(`  全部收敛：${net.allConverged()}`);

line('— 5) carol 删除 "(draft)"，同步后共同压缩历史');
const text = c.text();
const idx = text.indexOf('(draft)');
c.localDelete(idx, '(draft)'.length);
net.syncAll();
const before = a.stats();
const barrier = net.barrierOf();
line(`  全局 barrier: ${JSON.stringify(barrier.toJSON())}`);
for (const id of ['a', 'b', 'c']) net.replicas[id].checkpoint(barrier);
const after = a.stats();
show(net);
line(`  alice tombstone：压缩前 ${before.tombstones}，压缩后 ${after.tombstones}`);
line(`  全部收敛：${net.allConverged()}`);
