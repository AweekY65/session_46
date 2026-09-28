import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Replica,
  Network,
  saveSnapshot,
  loadSnapshot,
  appendOps,
  readLog,
  replayFromLog,
} from '../src/index.js';

async function tmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crdt-'));
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('持久化：快照保存/恢复后状态一致（含 tombstone、pending、操作日志）', async () => {
  const dir = await tmpDir();
  const a = new Replica('a');
  const b = new Replica('b');
  a.localInsert(0, 'hello');
  const del = a.localDelete(0, 1);
  b.receive(del); // b 缓冲了一个删除（pending）

  await saveSnapshot(a, path.join(dir, 'a'));
  await saveSnapshot(b, path.join(dir, 'b'));
  await appendOps(path.join(dir, 'a'), a.appliedOps);

  const a2 = await loadSnapshot(path.join(dir, 'a'));
  const b2 = await loadSnapshot(path.join(dir, 'b'));
  assert.equal(a2.text(), a.text());
  assert.equal(a2.tombstoneCount, 1);
  assert.equal(a2.counter, a.counter);
  assert.equal(a2.lamport, a.lamport);
  assert.equal(b2.pending.length, 1);
  assert.equal(b2.hasReceived('a', 2), true);

  // 恢复后的 b 补齐缺失操作，缓冲删除被联动应用
  const ins = a.appliedOps[0];
  assert.equal(b2.receive(ins).status, 'applied');
  assert.equal(b2.text(), 'ello');
});

test('持久化：JSONL 日志可回放重建文档，且乱序日志也能收敛', async () => {
  const dir = await tmpDir();
  const src = new Replica('src');
  const o1 = src.localInsert(0, 'abc');
  const o2 = src.localInsert(3, 'def');
  src.localDelete(2, 2); // 删 cd
  await appendOps(path.join(dir, 'log'), src.appliedOps);

  // 顺序回放
  const r1 = await replayFromLog('reader1', path.join(dir, 'log'));
  assert.equal(r1.text(), 'abef');

  // 读出日志逆序写入新日志，再回放（删除先到，自动缓冲）
  const ops = await readLog(path.join(dir, 'log'));
  const dir2 = await tmpDir();
  await appendOps(path.join(dir2, 'log2'), [...ops].reverse());
  const r2 = await replayFromLog('reader2', path.join(dir2, 'log2'));
  assert.equal(r2.text(), 'abef');
  assert.equal(r2.pending.length, 0);
});

test('状态恢复：重启的副本继续合并，与不中断执行结果一致', async () => {
  const dir = await tmpDir();

  // 参考实现：不中断地跑完整个场景
  const ref = { a: new Replica('a'), b: new Replica('b') };
  const refNet = new Network(ref);

  // 待重启实现：每个“阶段”后保存快照，再从磁盘恢复
  let disk = {
    a: await loadSnapshot(path.join(dir, 'a')).catch(() => null),
    b: await loadSnapshot(path.join(dir, 'b')).catch(() => null),
  };
  const fresh = () => ({
    a: disk.a ?? new Replica('a'),
    b: disk.b ?? new Replica('b'),
  });

  const scenario = [
    () => {
      ref.a.localInsert(0, 'shared-prefix');
      refNet.syncAll();
    },
    () => {
      // 分区编辑
      refNet.partition([['a'], ['b']]);
      ref.a.localInsert(ref.a.length, '-A1');
      ref.b.localInsert(ref.b.length, '-B1');
      ref.a.localDelete(0, 1);
    },
    () => {
      refNet.heal();
      refNet.syncAll();
    },
    () => {
      ref.b.localInsert(ref.b.length, 'B2');
      ref.a.localInsert(0, 'A2');
      refNet.syncAll();
    },
  ];

  // 把场景同样地施加到“可重启”副本：每阶段后落盘并重新加载
  let live = fresh();
  let net = new Network(live);
  const restartable = [
    () => {
      live.a.localInsert(0, 'shared-prefix');
      net.syncAll();
    },
    () => {
      net.partition([['a'], ['b']]);
      live.a.localInsert(live.a.length, '-A1');
      live.b.localInsert(live.b.length, '-B1');
      live.a.localDelete(0, 1);
    },
    () => {
      net.heal();
      net.syncAll();
    },
    async () => {
      // 阶段中途重启（先落盘）
      await saveSnapshot(live.a, path.join(dir, 'a'));
      await saveSnapshot(live.b, path.join(dir, 'b'));
      disk = {
        a: await loadSnapshot(path.join(dir, 'a')),
        b: await loadSnapshot(path.join(dir, 'b')),
      };
      live = { a: disk.a, b: disk.b };
      net = new Network(live);
      live.b.localInsert(live.b.length, 'B2');
      live.a.localInsert(0, 'A2');
      net.syncAll();
    },
  ];

  for (const fn of scenario) fn();
  for (const fn of restartable) await fn();

  assert.equal(live.a.text(), ref.a.text());
  assert.equal(live.b.text(), ref.b.text());
  assert.equal(live.a.text(), live.b.text());
});

test('持久化：快照文件为合法 JSON 且原子写入（临时文件不留存）', async () => {
  const dir = await tmpDir();
  const r = new Replica('r');
  r.localInsert(0, 'xyz');
  await saveSnapshot(r, dir);
  const buf = await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8');
  const parsed = JSON.parse(buf);
  assert.equal(parsed.origin, 'r');
  const files = await fs.readdir(dir);
  assert.deepEqual(files.sort(), ['snapshot.json']);
});
