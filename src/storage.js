/**
 * 本地持久化：全部数据只写入本地文件系统，无任何网络/数据库依赖。
 *
 * 每个副本使用一个目录：
 *   snapshot.json  —— 完整状态快照（节点、版本向量、缓冲操作、日志、转发表）
 *   operations.log —— 已应用操作的 JSONL 追加日志（每行一个操作）
 *
 * 典型恢复方式：loadSnapshot()；也可从空副本回放 JSONL 重建。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Replica } from './replica.js';

export const SNAPSHOT_FILE = 'snapshot.json';
export const LOG_FILE = 'operations.log';

/** 保存快照（原子写：先写临时文件再 rename）。 */
export async function saveSnapshot(replica, dir) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${SNAPSHOT_FILE}.${process.pid}.tmp`);
  const payload = JSON.stringify(replica.toJSON(), null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, path.join(dir, SNAPSHOT_FILE));
}

/** 从快照恢复副本；快照不存在时返回 null。 */
export async function loadSnapshot(dir) {
  const buf = await fs
    .readFile(path.join(dir, SNAPSHOT_FILE), 'utf8')
    .catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  if (buf === null) return null;
  return Replica.fromJSON(JSON.parse(buf));
}

/** 追加一批操作到 JSONL 日志。 */
export async function appendOps(dir, ops) {
  await fs.mkdir(dir, { recursive: true });
  const lines = ops.map((op) => JSON.stringify(op)).join('\n');
  await fs.appendFile(path.join(dir, LOG_FILE), lines + '\n', 'utf8');
}

/** 读取 JSONL 日志（空文件返回空数组；跳过空行）。 */
export async function readLog(dir) {
  const buf = await fs
    .readFile(path.join(dir, LOG_FILE), 'utf8')
    .catch((e) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    });
  const ops = [];
  for (const line of buf.split('\n')) {
    const t = line.trim();
    if (t) ops.push(JSON.parse(t));
  }
  return ops;
}

/**
 * 在一个新的空副本上完整回放日志，用于重建/审计。
 * 乱序日志也可处理（缺失依赖的操作会缓冲）。
 */
export async function replayFromLog(origin, dir) {
  const ops = await readLog(dir);
  const replica = new Replica(origin);
  for (const op of ops) replica.receive(op);
  return replica;
}
