/**
 * 版本向量（Version Vector）。
 *
 * 记录每个 origin 已见该副本的操作计数上界：
 *   vv[origin] = n  表示已收到该 origin counter ∈ [1, n] 的全部操作。
 * 用途：
 *   - 重复操作检测（counter 已被覆盖则该操作是重放）；
 *   - 反熵同步时交换操作集合的差集；
 *   - 计算全局 barrier，作为安全压缩 tombstone 的条件。
 */
export class VersionVector {
  /** @param {Record<string, number>=} entries */
  constructor(entries = {}) {
    /** @type {Record<string, number>} */
    this.counts = {};
    for (const [k, v] of Object.entries(entries)) this.counts[k] = v;
  }

  get(origin) {
    return this.counts[origin] ?? 0;
  }

  /** 记录“见到某操作”（counter 必须为正整数，乱序到达也安全）。 */
  observe(origin, counter) {
    const cur = this.counts[origin] ?? 0;
    if (counter > cur) this.counts[origin] = counter;
  }

  /** 是否已经见过该操作（同 origin 的该 counter）。 */
  hasSeen(origin, counter) {
    return counter <= (this.counts[origin] ?? 0);
  }

  /** 逐分量取最大值并集，返回新向量。 */
  merge(other) {
    const out = new VersionVector(this.counts);
    for (const [k, v] of Object.entries(other.counts)) {
      if (v > (out.counts[k] ?? 0)) out.counts[k] = v;
    }
    return out;
  }

  /** this 是否“包含” other（other 中每个分量都不大于 this）。 */
  dominates(other) {
    for (const [k, v] of Object.entries(other.counts)) {
      if (v > (this.counts[k] ?? 0)) return false;
    }
    return true;
  }

  /** 逐分量取最小值（全局 barrier）。 */
  static barrier(vectors) {
    if (vectors.length === 0) return new VersionVector();
    const keys = new Set();
    for (const v of vectors) for (const k of Object.keys(v.counts)) keys.add(k);
    const out = new VersionVector();
    for (const k of keys) {
      out.counts[k] = Math.min(...vectors.map((v) => v.get(k)));
    }
    return out;
  }

  clone() {
    return new VersionVector(this.counts);
  }

  toJSON() {
    return { ...this.counts };
  }

  static fromJSON(json) {
    return new VersionVector(json ?? {});
  }
}
