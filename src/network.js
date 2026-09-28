/**
 * Network —— 纯本地的“不可靠网络”模拟器，用于测试与离线协同演示。
 *
 * 不打开任何 socket、不访问任何外部服务：操作只是在内存队列里传递。
 * 可模拟：
 *   - 任意顺序 / 乱序投递（shuffle）
 *   - 重复投递（duplicate）
 *   - 网络分区（partition / heal，分区期间消息滞留，恢复后补发）
 *   - 部分连通组播（deliver）
 *   - 反熵同步（exchange：按版本向量差集交换双方知晓的操作）
 */

import { VersionVector } from './version-vector.js';

/**
 * @typedef {object} Rng 极简随机源接口
 * @property {() => number} next 返回 [0,1)
 */

/** 确定性 PRNG（mulberry32），让测试可复现。 */
export function makeRng(seed) {
  let s = seed >>> 0;
  return {
    next() {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export class Network {
  /**
   * @param {Record<string, import('./replica.js').Replica>} replicas origin -> Replica
   * @param {{rng?: Rng}} [opts]
   */
  constructor(replicas, opts = {}) {
    this.replicas = { ...replicas };
    this.rng = opts.rng ?? makeRng(1);
    /** origin -> origin -> [op] 滞留消息（分区期间暂存） */
    this.held = new Map();
    /** 当前分区组：origin -> 组 id；同组可达 */
    this.groups = new Map();
    for (const origin of Object.keys(this.replicas)) this.groups.set(origin, 'all');
    for (const origin of Object.keys(this.replicas)) this.held.set(origin, new Map());
  }

  /** 划分分区，例如 partition([['a','b'], ['c']])。未列出的副本各自成组。 */
  partition(groups) {
    this.groups = new Map();
    const grouped = new Set();
    groups.forEach((g, i) => {
      for (const origin of g) {
        if (!this.replicas[origin]) throw new Error(`未知副本: ${origin}`);
        this.groups.set(origin, `g${i}`);
        grouped.add(origin);
      }
    });
    for (const origin of Object.keys(this.replicas)) {
      if (!grouped.has(origin)) this.groups.set(origin, `solo:${origin}`);
    }
  }

  /** 恢复全连通，并把分区期间滞留的消息按入队顺序补发。 */
  heal() {
    for (const origin of Object.keys(this.replicas)) this.groups.set(origin, 'all');
    const results = [];
    for (const [to, byFrom] of this.held) {
      for (const [from, ops] of byFrom) {
        for (const op of ops) results.push(this._deliverOne(to, op));
      }
      byFrom.clear();
    }
    return results;
  }

  canReach(from, to) {
    return this.groups.get(from) === this.groups.get(to);
  }

  _deliverOne(to, op) {
    return { to, op, result: this.replicas[to].receive(op) };
  }

  /** 分区期间滞留在 from（面向不可达目标）的消息条数。 */
  heldCount(from) {
    let n = 0;
    for (const byFrom of this.held.values()) {
      const q = byFrom.get(from);
      if (q) n += q.length;
    }
    return n;
  }

  /**
   * 把一个副本知晓的操作发往可达的其他副本（默认排除自身）。
   * 分区内不可达时消息滞留，heal() 后补发。
   * @param {string} from
   * @param {{to?: string|string[], duplicate?: boolean}} [opts]
   *        duplicate:true 时每个操作额外再投递一次（模拟重复消息）
   */
  broadcast(from, opts = {}) {
    const sender = this.replicas[from];
    if (!sender) throw new Error(`未知副本: ${from}`);
    const targets = opts.to
      ? Array.isArray(opts.to)
        ? opts.to
        : [opts.to]
      : Object.keys(this.replicas).filter((o) => o !== from);
    const results = [];
    for (const op of sender.knownOps()) {
      for (const to of targets) {
        if (to === from) continue;
        if (!this.replicas[to]) throw new Error(`未知副本: ${to}`);
        const copies = opts.duplicate ? 2 : 1;
        for (let i = 0; i < copies; i++) {
          if (this.canReach(from, to)) {
            results.push(this._deliverOne(to, op));
          } else {
            const bucket = this.held.get(to);
            if (!bucket.has(from)) bucket.set(from, []);
            bucket.get(from).push(op);
          }
        }
      }
    }
    return results;
  }

  /** 随机乱序投递 from 知晓的操作给 to（仅限可达）。 */
  shuffleDeliver(from, to) {
    if (!this.canReach(from, to)) return [];
    const ops = [...this.replicas[from].knownOps()];
    for (let i = ops.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [ops[i], ops[j]] = [ops[j], ops[i]];
    }
    return ops.map((op) => this._deliverOne(to, op));
  }

  /**
   * 两个可达副本之间做一轮反熵交换：按版本向量差集互发对方没有的操作。
   * @returns 本轮投递记录数
   */
  exchange(a, b) {
    let delivered = 0;
    if (this.canReach(a, b)) delivered += this._pushMissing(a, b);
    if (this.canReach(b, a)) delivered += this._pushMissing(b, a);
    return delivered;
  }

  _pushMissing(from, to) {
    const receiver = this.replicas[to];
    let n = 0;
    for (const op of this.replicas[from].knownOps()) {
      if (!receiver.hasReceived(op.origin, op.counter)) {
        receiver.receive(op);
        n += 1;
      }
    }
    return n;
  }

  /**
   * 反复对所有同组副本做反熵交换直到不动点（有界轮数保护）。
   * 分区组之间互不影响；返回执行轮数。
   */
  syncAll(maxRounds = 100) {
    const origins = Object.keys(this.replicas);
    let round = 0;
    while (round < maxRounds) {
      let any = false;
      for (let i = 0; i < origins.length; i++) {
        for (let j = i + 1; j < origins.length; j++) {
          const before = this._totalApplied();
          this.exchange(origins[i], origins[j]);
          if (this._totalApplied() !== before) any = true;
        }
      }
      round += 1;
      if (!any) break;
    }
    return round;
  }

  _totalApplied() {
    let n = 0;
    for (const r of Object.values(this.replicas)) n += r.appliedOps.length;
    return n;
  }

  /** 所有副本的文本是否已收敛一致。 */
  allConverged() {
    const texts = Object.values(this.replicas).map((r) => r.text());
    return texts.every((t) => t === texts[0]);
  }

  /** 计算全局 barrier（用于安全压缩）。要求传入“参与集合”，默认全部副本。 */
  barrierOf(members = Object.keys(this.replicas)) {
    return VersionVector.barrier(members.map((o) => this.replicas[o].vv));
  }
}
