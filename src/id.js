/**
 * 操作 / 字符节点的全局唯一标识与确定性排序。
 *
 * Id 字段:
 *   ts      — Lamport 逻辑时间戳（所有副本之间可比）
 *   origin  — 产生该操作的副本 ID（打破 Lamport 平局）
 *   counter — 该副本本地单调递增计数（与 origin 一起构成版本向量的键空间）
 *   seq     — 一次文本片段插入内的字符序号；单字符插入恒为 0
 *
 * 同一 (ts, origin) 下 counter 唯一、seq 只出现在批量插入中，
 * 因此 (ts, origin, counter, seq) 在全局无碰撞。
 */

/**
 * 两个 Id 的确定性全序比较，返回标准数组排序约定的结果（负值 => a 排前）。
 * 这是 RGA 中“同一左锚点下并发插入”的仲裁规则：
 *   1. Lamport 时间戳大者排前（DF 遍历先访问 -> 在文本中更靠左）；
 *   2. 时间戳相同（并发产生）时 origin 字典序小者排前；
 *   3. 同一操作内的片段字符按 counter、seq 小者排前。
 */
export function compareId(a, b) {
  if (a.ts !== b.ts) return b.ts - a.ts; // ts 大的优先
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.seq - b.seq;
}

/** 数组排序用：id 排在前面的元素在前。 */
export function sortByIds(list) {
  return list.sort((x, y) => compareId(x.id, y.id));
}

/** Id 的稳定字符串键，用作 Map / 去重集合的 key。 */
export function idKey(id) {
  return `${id.ts}:${id.origin}:${id.counter}:${id.seq}`;
}

/** 去掉 seq（片段内偏移）的“操作级”键，用于版本向量粒度。 */
export function opKey(id) {
  return `${id.origin}:${id.counter}`;
}

export function sameId(a, b) {
  return (
    a.ts === b.ts &&
    a.origin === b.origin &&
    a.counter === b.counter &&
    a.seq === b.seq
  );
}

/** 深拷贝一个 Id。 */
export function cloneId(id) {
  return { ts: id.ts, origin: id.origin, counter: id.counter, seq: id.seq ?? 0 };
}
