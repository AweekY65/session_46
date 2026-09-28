/**
 * Replica —— 单个离线副本上的 RGA（Replicated Growable Array）文本 CRDT。
 *
 * 模型概述
 * --------
 * 每个字符是一个不可变节点 Node { id, char, left }：
 *   - id    全局唯一且稳定：(lamport 时间戳, origin, counter, seq)
 *   - left  左锚点：插入位置前一个字符的 id，文档开头为 null
 *   - deleted 删除标记（tombstone）
 * 所有节点构成一棵以虚拟 root（left === null）为根的树：
 * left 即父指针。线性文本 = 该树的 DFS 先序遍历，
 * 同一父节点下的“并发兄弟”按 compareId 做确定性排序
 * （Lamport 时间戳大者在前，origin 字典序小者在前，再按 counter/seq）。
 * 因此无论操作以何种顺序到达，只要操作集合相同，文本必然相同（收敛）。
 *
 * 乱序与延迟删除
 * --------------
 * 插入的锚点或删除的目标尚未到达时，操作进入 pending 缓冲区；
 * 每当新操作补齐依赖，自动重试缓冲操作，直到全部可应用。
 *
 * 重复操作与版本向量
 * * ------------------
 * 用显式集合记录已接收（含缓冲中）与已应用的操作，重放的操作直接忽略；
 * 版本向量分量取“从 1 起连续无缺口”的最大计数（prefix-complete），
 * 这保证基于版本向量 barrier 的 tombstone 压缩在乱序传递下依然安全。
 */

import { compareId, idKey, cloneId } from './id.js';
import { VersionVector } from './version-vector.js';

const ROOT_KEY = '\0root';

/** 在 Map<origin, Set<counter>> 结构上记录见到一个操作。 */
function observeOp(map, origin, counter) {
  let set = map.get(origin);
  if (!set) {
    set = new Set();
    map.set(origin, set);
  }
  set.add(counter);
}

function hasOp(map, origin, counter) {
  return map.has(origin) && map.get(origin).has(counter);
}

/**
 * 由“已见操作集合”计算连续前缀版本向量：
 * counts[origin] = 最大的 n，使得 1..n 全部在集合中。
 * 乱序到达（如先见 3 后见 1/2）时分量只计到缺口之前。
 * @param {Map<string, Set<number>>} map
 */
function prefixVV(map) {
  const vv = new VersionVector();
  for (const [origin, set] of map) {
    let n = 0;
    while (set.has(n + 1)) n += 1;
    if (n > 0) vv.counts[origin] = n;
  }
  return vv;
}

function cloneOpMap(map) {
  const out = new Map();
  for (const [origin, set] of map) out.set(origin, new Set(set));
  return out;
}

function opMapToJSON(map) {
  const out = {};
  for (const [origin, set] of map) out[origin] = [...set].sort((a, b) => a - b);
  return out;
}

function opMapFromJSON(json) {
  const map = new Map();
  for (const [origin, counters] of Object.entries(json ?? {})) {
    map.set(origin, new Set(counters));
  }
  return map;
}

export class Replica {
  /**
   * @param {string} origin 副本 ID（需全局唯一且为确定性字符串，用于排序平局仲裁）
   */
  constructor(origin) {
    if (!origin || typeof origin !== 'string') {
      throw new Error('Replica 需要一个非空字符串 origin 作为副本 ID');
    }
    this.formatVersion = 1;
    this.origin = origin;
    /** Lamport 时钟 */
    this.lamport = 0;
    /** 本副本操作计数器（版本向量分量） */
    this.counter = 0;
    /** 已成功应用操作集合：origin -> Set<counter> */
    this.appliedSet = new Map();
    /** 已接收（含缓冲中）操作集合：origin -> Set<counter>，用于重复检测 */
    this.receivedSet = new Map();
    /** idKey -> Node，全部存活节点（checkpoint 后 tombstone 被丢弃） */
    this.nodes = new Map();
    /** 依赖未满足、等待补齐的操作 */
    this.pending = [];
    /** 已应用操作日志（用于反熵交换与本地审计） */
    this.appliedOps = [];
    /** 最近一次 checkpoint 的 barrier（null 表示从未压缩） */
    this.barrier = null;
    /** 压缩时被丢弃节点 id -> 重定位锚点 key（ROOT_KEY 表示文档开头） */
    this.forward = new Map();
    /** 已被压缩丢弃的节点 idKey 集合（迟到的删除按 no-op 处理） */
    this.dropped = new Set();
  }

  /** 已应用操作的连续前缀版本向量。 */
  get vv() {
    return prefixVV(this.appliedSet);
  }

  /** 已接收（含缓冲）操作的连续前缀版本向量。 */
  get receivedVV() {
    return prefixVV(this.receivedSet);
  }

  /** 原始已见计数上界（允许缺口），仅供统计/调试。 */
  get rawAppliedMax() {
    const out = {};
    for (const [origin, set] of this.appliedSet) {
      out[origin] = set.size ? Math.max(...set) : 0;
    }
    return out;
  }

  /** 是否已经收到过该操作（即使因缺口导致版本向量尚未体现）。 */
  hasReceived(origin, counter) {
    return hasOp(this.receivedSet, origin, counter);
  }

  // ---------------------------------------------------------------- 基本读取

  /** 构造 parentKey -> Node[] 索引。 */
  _childrenIndex() {
    const children = new Map();
    for (const node of this.nodes.values()) {
      const key = node.left ? idKey(node.left) : ROOT_KEY;
      let arr = children.get(key);
      if (!arr) {
        arr = [];
        children.set(key, arr);
      }
      arr.push(node);
    }
    for (const arr of children.values()) arr.sort((a, b) => compareId(a.id, b.id));
    return children;
  }

  /** 完整 DFS 先序序列（含已删除节点，保留其结构位置）。 */
  linearize() {
    const children = this._childrenIndex();
    const out = [];
    const visit = (parentKey) => {
      const arr = children.get(parentKey);
      if (!arr) return;
      for (const node of arr) {
        out.push(node);
        visit(idKey(node.id));
      }
    };
    visit(ROOT_KEY);
    return out;
  }

  /** 当前可见文本。 */
  text() {
    let s = '';
    for (const node of this.linearize()) if (!node.deleted) s += node.char;
    return s;
  }

  /** 当前可见字符数。 */
  get length() {
    let n = 0;
    for (const node of this.nodes.values()) if (!node.deleted) n++;
    return n;
  }

  /** tombstone 数量。 */
  get tombstoneCount() {
    let n = 0;
    for (const node of this.nodes.values()) if (node.deleted) n++;
    return n;
  }

  stats() {
    return {
      origin: this.origin,
      nodes: this.nodes.size,
      alive: this.length,
      tombstones: this.tombstoneCount,
      pending: this.pending.length,
      appliedOps: this.appliedOps.length,
      lamport: this.lamport,
    };
  }

  // ---------------------------------------------------------------- 本地编辑

  _nextOpMeta() {
    this.lamport += 1;
    this.counter += 1;
    const ts = this.lamport;
    const counter = this.counter;
    return {
      ts,
      counter,
      id: { ts, origin: this.origin, counter, seq: 0 },
    };
  }

  /**
   * 在可见位置 index 处插入文本片段（单字符与多字符统一处理）。
   * 片段内字符以 left 链串联，保证作为整体保持相邻与顺序。
   * @returns 产生的操作（已本地应用，可交换给其他副本）
   */
  localInsert(index, text) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('插入内容必须是非空字符串');
    }
    const alive = this.linearize().filter((n) => !n.deleted);
    if (index < 0 || index > alive.length) {
      throw new RangeError(`插入位置越界: ${index}（文档长度 ${alive.length}）`);
    }
    const meta = this._nextOpMeta();
    const anchor = index === 0 ? null : cloneId(alive[index - 1].id);
    /** @type {any} */
    const op = {
      type: 'insert',
      id: meta.id,
      ts: meta.ts,
      origin: this.origin,
      counter: meta.counter,
      anchor,
      chars: [...text].map((ch) => ch), // 以 Unicode 码点切分
    };
    this._applyLocal(op);
    return op;
  }

  /** 删除从可见位置 index 开始的 length 个字符，返回删除操作。 */
  localDelete(index, length) {
    if (length <= 0) throw new Error('删除长度必须为正数');
    const alive = this.linearize().filter((n) => !n.deleted);
    if (index < 0 || index + length > alive.length) {
      throw new RangeError(`删除范围越界: ${index}+${length}（文档长度 ${alive.length}）`);
    }
    const targets = alive.slice(index, index + length).map((n) => cloneId(n.id));
    return this.localDeleteByIds(targets);
  }

  /** 按节点 id 批量删除（跨范围、内部去重，幂等）。 */
  localDeleteByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error('删除目标不能为空');
    }
    const meta = this._nextOpMeta();
    const seen = new Set();
    const targets = [];
    for (const id of ids) {
      const key = idKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(cloneId(id));
    }
    /** @type {any} */
    const op = {
      type: 'delete',
      id: meta.id,
      ts: meta.ts,
      origin: this.origin,
      counter: meta.counter,
      targets,
    };
    this._applyLocal(op);
    return op;
  }

  _applyLocal(op) {
    this._apply(op);
    observeOp(this.appliedSet, op.origin, op.counter);
    observeOp(this.receivedSet, op.origin, op.counter);
    this.appliedOps.push(op);
  }

  // ---------------------------------------------------------------- 远程合并

  /**
   * 接收来自其他副本的操作（或重放的旧操作）。
   * @returns {{status: 'duplicate'|'applied'|'buffered'}}
   */
  receive(op) {
    this._validate(op);
    // Lamport 时钟在接收时刻更新（即便操作要缓冲，happens-before 已建立）
    this.lamport = Math.max(this.lamport, op.ts) + 1;

    if (hasOp(this.receivedSet, op.origin, op.counter)) {
      return { status: 'duplicate' };
    }
    observeOp(this.receivedSet, op.origin, op.counter);

    if (this._missingDeps(op).length > 0) {
      this.pending.push(op);
      return { status: 'buffered' };
    }
    this._apply(op);
    observeOp(this.appliedSet, op.origin, op.counter);
    this.appliedOps.push(op);
    this._flushPending();
    return { status: 'applied' };
  }

  _validate(op) {
    if (!op || typeof op !== 'object') throw new Error('非法操作: 不是对象');
    if (op.type !== 'insert' && op.type !== 'delete') {
      throw new Error(`非法操作类型: ${op.type}`);
    }
    if (typeof op.origin !== 'string' || !Number.isInteger(op.counter) || op.counter < 1) {
      throw new Error('非法操作: origin/counter 缺失');
    }
    if (!Number.isInteger(op.ts) || op.ts < 1) throw new Error('非法操作: ts 缺失');
  }

  /** 操作尚未到达的依赖 id 列表（锚点 / 删除目标）。 */
  _missingDeps(op) {
    const missing = [];
    if (op.type === 'insert') {
      if (op.anchor !== null && op.anchor !== undefined) {
        const key = idKey(op.anchor);
        if (!this.nodes.has(key) && !this.dropped.has(key) && this._resolveForward(op.anchor) === undefined) {
          missing.push(op.anchor);
        }
      }
    } else {
      for (const t of op.targets) {
        const key = idKey(t);
        // 节点已被 checkpoint 丢弃：该删除视为 no-op，不再等待
        if (!this.nodes.has(key) && !this.dropped.has(key)) missing.push(t);
      }
    }
    return missing;
  }

  /**
   * 查询被压缩丢弃的锚点应重定位到何处。
   * @returns 现存节点的 key、ROOT_KEY（文档开头），或 undefined（确实缺失）
   */
  _resolveForward(id) {
    let key = idKey(id);
    const guard = new Set();
    while (true) {
      if (key === ROOT_KEY) return ROOT_KEY;
      if (this.nodes.has(key)) return key;
      if (guard.has(key)) return undefined;
      guard.add(key);
      const next = this.forward.get(key);
      if (next === undefined) return undefined;
      key = next;
    }
  }

  _apply(op) {
    if (op.type === 'insert') {
      let prev = null;
      if (op.anchor !== null && op.anchor !== undefined) {
        if (this.nodes.has(idKey(op.anchor))) {
          prev = cloneId(op.anchor);
        } else {
          // 锚点已在某次 checkpoint 中被丢弃，按转发记录重定位
          const fk = this._resolveForward(op.anchor);
          if (fk && fk !== ROOT_KEY) {
            const target = this.nodes.get(fk);
            prev = target ? cloneId(target.id) : null;
          }
        }
      }
      const chars = op.chars;
      for (let i = 0; i < chars.length; i++) {
        const id = { ts: op.ts, origin: op.origin, counter: op.counter, seq: i };
        const node = { id, char: chars[i], deleted: false, left: prev };
        this.nodes.set(idKey(id), node);
        prev = cloneId(id);
      }
    } else {
      for (const t of op.targets) {
        const node = this.nodes.get(idKey(t));
        if (node) node.deleted = true; // 重复删除幂等
      }
    }
  }

  /** 依赖补齐后反复尝试缓冲操作，直到不动点。 */
  _flushPending() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.pending.length; i++) {
        const op = this.pending[i];
        if (this._missingDeps(op).length === 0) {
          this.pending.splice(i, 1);
          i -= 1;
          this._apply(op);
          observeOp(this.appliedSet, op.origin, op.counter);
          this.appliedOps.push(op);
          progressed = true;
        }
      }
    }
  }

  // ---------------------------------------------------------------- 反熵交换

  /** 本副本知晓的全部操作（已应用 + 缓冲中），供副本间交换。 */
  knownOps() {
    return [...this.appliedOps, ...this.pending];
  }

  // ---------------------------------------------------------------- 历史压缩

  /**
   * 安全压缩 tombstone 的条件：
   *   1. 所有参与副本共同确认的全局 barrier（各副本版本向量的逐分量最小值）；
   *   2. 本副本没有未应用的缓冲操作；
   *   3. 本副本已见集合包含 barrier。
   * barrier 语义：barrier[origin]=n 表示每个参与副本都已收到
   * origin 的前 n 个操作 —— 此后不会再有“迟到的、引用这些节点”的操作，
   * 被删除节点可以物理丢弃。存活节点被拍平为同序链表；
   * 被丢弃 id 保留轻量转发指针，供极少数“屏障后插入锚定屏障前节点”的操作重定位。
   *
   * @param {VersionVector} barrier 由 VersionVector.barrier(所有副本 VV) 计算
   * @returns {{removed: number, barrier: object}}
   */
  checkpoint(barrier) {
    if (!(barrier instanceof VersionVector)) {
      throw new Error('checkpoint 需要 VersionVector 类型的 barrier');
    }
    if (this.pending.length > 0) {
      throw new Error(`存在 ${this.pending.length} 个未应用的缓冲操作，不能压缩`);
    }
    if (!this.vv.dominates(barrier)) {
      throw new Error('本副本尚未收齐 barrier 覆盖的操作，不能压缩');
    }

    const order = this.linearize();
    const survivors = order.filter((n) => !n.deleted);

    // 记录被丢弃节点 -> 其前面最近的存活节点（供锚点重定位）
    let prevKey = ROOT_KEY;
    const newForward = new Map();
    for (const node of order) {
      const key = idKey(node.id);
      if (node.deleted) {
        newForward.set(key, prevKey);
      } else {
        prevKey = key;
      }
    }
    // 与历史转发记录合并（沿链最终都能走到现存节点或 root）
    for (const [k, v] of this.forward) newForward.set(k, v);

    const removed = this.nodes.size - survivors.length;
    for (const node of order) {
      if (node.deleted) this.dropped.add(idKey(node.id));
    }
    const rebuilt = new Map();
    let prevId = null;
    for (const node of survivors) {
      const fresh = { id: cloneId(node.id), char: node.char, deleted: false, left: prevId };
      rebuilt.set(idKey(fresh.id), fresh);
      prevId = cloneId(fresh.id);
    }
    this.nodes = rebuilt;
    this.forward = newForward;
    this.barrier = barrier.clone();
    return { removed, barrier: barrier.toJSON() };
  }

  // ---------------------------------------------------------------- 持久化

  toJSON() {
    return {
      formatVersion: this.formatVersion,
      origin: this.origin,
      lamport: this.lamport,
      counter: this.counter,
      appliedSet: opMapToJSON(this.appliedSet),
      receivedSet: opMapToJSON(this.receivedSet),
      barrier: this.barrier ? this.barrier.toJSON() : null,
      nodes: this.linearize().map((n) => ({
        id: n.id,
        char: n.char,
        deleted: n.deleted,
        left: n.left,
      })),
      pending: this.pending,
      appliedOps: this.appliedOps,
      forward: [...this.forward.entries()],
      dropped: [...this.dropped],
    };
  }

  static fromJSON(json) {
    if (!json || json.formatVersion !== 1) {
      throw new Error('不支持的快照格式（需要 formatVersion=1）');
    }
    const r = new Replica(json.origin);
    r.lamport = json.lamport;
    r.counter = json.counter;
    r.appliedSet = opMapFromJSON(json.appliedSet);
    r.receivedSet = opMapFromJSON(json.receivedSet);
    r.barrier = json.barrier ? VersionVector.fromJSON(json.barrier) : null;
    r.pending = json.pending ?? [];
    r.appliedOps = json.appliedOps ?? [];
    r.nodes = new Map();
    for (const n of json.nodes ?? []) {
      r.nodes.set(idKey(n.id), {
        id: cloneId(n.id),
        char: n.char,
        deleted: !!n.deleted,
        left: n.left ? cloneId(n.left) : null,
      });
    }
    r.forward = new Map(json.forward ?? []);
    r.dropped = new Set(json.dropped ?? []);
    return r;
  }
}
