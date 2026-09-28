import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionVector } from '../src/index.js';

test('版本向量：观察、已见判断与乱序安全', () => {
  const vv = new VersionVector();
  vv.observe('a', 3);
  assert.equal(vv.get('a'), 3);
  assert.equal(vv.get('b'), 0);
  vv.observe('a', 2); // 旧值不回退
  assert.equal(vv.get('a'), 3);
  vv.observe('a', 5);
  assert.equal(vv.get('a'), 5);
});

test('版本向量：merge 逐分量取最大', () => {
  const a = new VersionVector({ x: 2, y: 4 });
  const b = new VersionVector({ y: 3, z: 7 });
  const m = a.merge(b);
  assert.deepEqual(m.toJSON(), { x: 2, y: 4, z: 7 });
  assert.deepEqual(a.toJSON(), { x: 2, y: 4 }); // 不修改原向量
});

test('版本向量：dominates 偏序关系', () => {
  const a = new VersionVector({ x: 3, y: 2 });
  assert.ok(a.dominates(new VersionVector({ x: 3, y: 1 })));
  assert.ok(a.dominates(new VersionVector({ x: 2 })));
  assert.ok(a.dominates(new VersionVector({})));
  assert.ok(!new VersionVector({ x: 2 }).dominates(a));
  assert.ok(!a.dominates(new VersionVector({ x: 3, y: 3 })));
});

test('版本向量：barrier 取逐分量最小（全局已确认下界）', () => {
  const bar = VersionVector.barrier([
    new VersionVector({ a: 3, b: 2 }),
    new VersionVector({ a: 5, b: 1 }),
    new VersionVector({ a: 4, b: 2, c: 9 }),
  ]);
  assert.deepEqual(bar.toJSON(), { a: 3, b: 1, c: 0 });
});

test('版本向量：barrier 在成员新增时自动包含（分量为 0）', () => {
  const bar = VersionVector.barrier([
    new VersionVector({ a: 9 }),
    new VersionVector({ b: 9 }),
  ]);
  assert.deepEqual(bar.toJSON(), { a: 0, b: 0 });
});

test('版本向量：clone 与 JSON 往返', () => {
  const vv = new VersionVector({ a: 1, b: 2 });
  const back = VersionVector.fromJSON(vv.clone().toJSON());
  assert.deepEqual(back.toJSON(), vv.toJSON());
});
