#!/usr/bin/env node
/**
 * demo.js — 端到端演示：三个离线副本并发编辑、网络分区、乱序投递、
 * 延迟删除、状态保存/恢复与历史压缩。纯本地运行：node examples/demo.js
 */
import { Replica, computeCheckpoint } from '../src/crdt.js';

const line = (s) => console.log(`\n=== ${s} ===`);

// 1) 三个副本共享基线文档
const r1 = new Replica('r1');
const r2 = new Replica('r2');
const r3 = new Replica('r3');
const peers = ['r1', 'r2', 'r3'];
r1.appendText('Hello CRDT');
r2.pullFrom(r1);
r3.pullFrom(r1);
line('基线文档（三方同步后）');
console.log('r1:', JSON.stringify(r1.text()));

// 2) 网络分区：各自离线并发编辑（包括在同一位置插入）
line('分区：三方各自离线编辑（注意 r2/r3 在同一位置插入）');
r1.insertText(5, ',');                 // Hello, CRDT
r1.deleteText(12, 1);                  // 删掉末尾 T
r2.insertText(11, '!');                // Hello CRDT!
r3.insertText(11, '?');                // Hello CRDT?
console.log('r1 视图:', JSON.stringify(r1.text()));
console.log('r2 视图:', JSON.stringify(r2.text()));
console.log('r3 视图:', JSON.stringify(r3.text()));

// 3) 乱序投递：把 r1 的操作洗牌后交给 r3（含先到的 delete）
line('恢复连接：r1 的操作洗牌后投递给 r3');
const shuffled = [...r1.log.values()].reverse();
r3.receiveOps(shuffled);
console.log('r3 合并 r1 后:', JSON.stringify(r3.text()));
console.log('r3 暂缓队列已清空:', r3.pending.size === 0);

// 4) 全连接反熵同步
line('全连接同步');
r1.sync(r2);
r2.sync(r3);
r1.sync(r3);
console.log('r1:', JSON.stringify(r1.text()));
console.log('r2:', JSON.stringify(r2.text()));
console.log('r3:', JSON.stringify(r3.text()));
console.log('收敛:', r1.text() === r2.text() && r2.text() === r3.text());
console.log('版本向量 r3:', JSON.stringify(r3.versionVector()));

// 5) 延迟删除：删除操作先于目标插入到达
line('延迟删除：删除先到、插入后到');
const fresh = new Replica('fresh');
fresh.pullFrom(r1); // 先取得当前基线（注意：在下面的 Z 操作之前）
const insertPos = r1.text().length;
const insOps = r1.insertText(insertPos, 'Z');
const delOps = r1.deleteText(insertPos, 1); // 立刻删掉 Z
fresh.receiveOps(delOps); // 删除目标 Z 还没到 -> 暂缓
console.log('仅收到删除时文本:', JSON.stringify(fresh.text()), '| pending:', fresh.pending.size);
fresh.receiveOps(insOps); // 插入补齐 -> 删除自动生效
console.log('补齐插入后文本:', JSON.stringify(fresh.text()), '| pending:', fresh.pending.size);

// 6) 重复操作幂等
line('重复操作');
r3.pullFrom(r1); // 先确保 r3 已收齐 r1（含第 5 步的 Z 插入/删除）
const dup = r3.receiveOps([...r1.log.values()]); // 全部都是已见操作
console.log('重复投递 r1 全部操作给 r3，新整合数 =', dup);

// 7) 持久化：保存到本地文件再恢复
line('状态保存 / 恢复（本地 JSON 文件）');
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const file = path.join(os.tmpdir(), 'crdt-demo-r2.json');
await r2.save(file);
const restarted = await Replica.load(file);
console.log('重启后文本:', JSON.stringify(restarted.text()));
restarted.appendText(' [after-restart]');
r2.pullFrom(restarted);
console.log('重启副本继续编辑并合并:', JSON.stringify(r2.text()));

// 8) 历史压缩：全员共同前沿检查点
line('历史压缩（tombstone GC）');
for (const r of [r1, r2, r3]) r.sync(restarted);
const cp = computeCheckpoint([r1, r2, r3, restarted], peers);
const before = r1.stats();
const res = r1.compact(cp);
console.log(`节点 ${before.total} -> ${r1.stats().total}（移除 ${res.removed}，` +
  `剩余 tombstone ${res.remainingTombstones}）`);
console.log('压缩后文本不变:', JSON.stringify(r1.text()));

await fs.rm(file, { force: true });
line('完成');
