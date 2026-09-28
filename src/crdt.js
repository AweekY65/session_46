/**
 * crdt.js — 完全本地的协同文本 CRDT 引擎
 *
 * 模型：RGA（Replicated Growable Array，复制可增长数组）+ tombstone（墓碑）
 *   - 文档是一棵以虚拟根 ROOT 为根的有序树；每个存活字符是一个节点，
 *     后插入的字符作为“子节点”挂在其左锚点（插入位置左侧的字符）之下。
 *   - 删除是逻辑删除：节点保留（tombstone），仅置 deleted=true，因此延迟到达、
 *     乱序到达的操作都能被幂等地整合。
 *   - 操作 ID 全局唯一且稳定：{ counter, replicaId }，counter 是该 replica 的
 *     单调递增序号（从 1 开始）。跨副本比较顺序时再辅以 Lamport 时间戳。
 *
 * 本模块只依赖 Node 内置能力（文件读写、crypto），不依赖任何网络服务、
 * 数据库或第三方包。
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// ID：操作 / 字符节点的全局稳定标识
// ---------------------------------------------------------------------------

/** 生成一个全新的副本 ID（仅本地使用的随机字符串）。 */
export function newReplicaId() {
  return randomUUID().slice(0, 8);
}

/** 结构化 ID -> 字符串（用作 Map/Set 的键），形如 "7@r1"。 */
export function idToStr(id) {
  return `${id.counter}@${id.replicaId}`;
}

/** 字符串 -> 结构化 ID。 */
export function idFromStr(s) {
  const at = s.indexOf('@');
  return { counter: Number(s.slice(0, at)), replicaId: s.slice(at + 1) };
}

function idEq(a, b) {
  return a.counter === b.counter && a.replicaId === b.replicaId;
}

/**
 * 同一锚点下并发插入的确定性排序：
 *   1. Lamport 时间戳（lamport）更大的排在更前（后发生的更靠左，RGA 约定）；
 *   2. 时间戳相同则副本 ID 字典序更小的排前（全局确定，与到达顺序无关）。
 * 任何两个副本对同一组兄弟节点都能排得完全一致 —— 收敛性的关键。
 */
function siblingCmp(a, b) {
  if (b.id.lamport !== a.id.lamport) return b.id.lamport - a.id.lamport;
  if (a.id.replicaId < b.id.replicaId) return -1;
  if (a.id.replicaId > b.id.replicaId) return 1;
  return b.id.counter - a.id.counter;
}

// ---------------------------------------------------------------------------
// Replica：一个离线副本
// ---------------------------------------------------------------------------

export class Replica {
  /**
   * @param {string} [replicaId] 不传则自动生成
   * @param {string[]} [peers] 已知全体成员 ID（GC / 压缩判定需要知道“谁算数”）
   */
  constructor(replicaId = newReplicaId(), peers = []) {
    this.replicaId = replicaId;
    this.peers = peers.includes(replicaId) ? [...peers] : [...peers, replicaId];

    this.clock = 0;          // 本副本的 Lamport 逻辑时钟
    this.counter = 0;        // 本副本操作序号（op id 的 counter）
    this.version = {};       // 版本向量：各副本已连续整合的最大 counter

    /** 操作日志：opId 字符串 -> 操作（insert/delete 都在里面）。 */
    this.log = new Map();
    /** 字符节点索引：插入操作的 opId -> 节点。tombstone 也保留。 */
    this.nodes = new Map();
    /** ROOT 虚拟根。key 固定为 null。 */
    this.root = { id: null, char: null, deleted: false, parent: null, children: [] };
    /** 因依赖缺失（锚点未到 / 删除目标未到）而暂缓的操作。 */
    this.pending = new Map();
    /** 已生成 / 已接收操作的稳定有序集合，用于状态持久化与去重调试。 */
    this.seen = new Set();
  }

  // --- 本地编辑 -----------------------------------------------------------

  /**
   * 在 index（基于当前可见文本）处插入文本。
   * 内部按 code point 拆成多个 insert 操作；同批次字符首尾相接（后一个
   * 字符以前一个新字符为锚点），因此多字符插入整块连续，且与把它拆成
   * 多次单字符插入的结果完全一致。
   * @returns 生成的操作数组（可投递到其他副本）
   */
  insertText(index, text) {
    if (text.length === 0) return [];
    const visible = this.visibleNodes();
    if (index < 0) index = 0;
    if (index > visible.length) index = visible.length;

    const left = index === 0 ? null : visible[index - 1].id;
    const ops = [];
    let anchor = left;
    for (const ch of text) {
      const op = this.#makeInsert(ch, anchor);
      ops.push(op);
      anchor = op.id; // 同批次后续字符以前一个新字符为锚点，保持输入顺序
    }
    return ops;
  }

  /** 在末尾追加（便捷方法）。 */
  appendText(text) {
    return this.insertText(this.text().length, text);
  }

  /**
   * 删除从 index 开始的 length 个可见字符（基于 code point）。
   * 已删除的字符不会重复产生 delete 操作（幂等）。
   * @returns 生成的操作数组
   */
  deleteText(index, length) {
    const visible = this.visibleNodes();
    if (index < 0) index = 0;
    const ops = [];
    for (const node of visible.slice(index, index + length)) {
      if (!node.deleted) ops.push(this.#makeDelete(node.id));
    }
    return ops;
  }

  #nextId() {
    this.counter += 1;
    this.clock += 1;
    return { counter: this.counter, replicaId: this.replicaId, lamport: this.clock };
  }

  #makeInsert(char, afterId) {
    const op = {
      type: 'insert',
      id: this.#nextId(),
      afterId, // null = 挂在 ROOT 下（文档最左）
      char,
    };
    this.#deliverLocal(op);
    return op;
  }

  #makeDelete(targetId) {
    const op = {
      type: 'delete',
      id: this.#nextId(),
      target: targetId,
    };
    this.#deliverLocal(op);
    return op;
  }

  #deliverLocal(op) {
    const key = idToStr(op.id);
    // 本地生成的不可能重复，防御性处理。
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.log.set(key, op);
    this.version[op.id.replicaId] = op.id.counter;
    this.#apply(op);
  }

  // --- 远程整合（乱序 / 重复 / 延迟都安全） ---------------------------------

  /**
   * 接收一个远端操作。
   *  - 重复操作：直接忽略（seen 去重 + 版本向量判定）。
   *  - 乱序 / 依赖缺失：进入 pending；依赖补齐后自动补整合。
   *  - 任意投递顺序下最终文本一致（CRDT 收敛性）。
   * @returns {boolean} 该操作是否为“首次整合”（false 表示重复）
   */
  receive(op) {
    op = this.#normalizeOp(op);
    const key = idToStr(op.id);
    if (this.seen.has(key)) return false;

    this.seen.add(key);
    this.clock = Math.max(this.clock, op.id.lamport ?? 0);

    // 版本向量：counter 必须连续才推进（gap 留给后续操作填补）。
    const next = (this.version[op.id.replicaId] ?? 0) + 1;
    if (op.id.counter === next) {
      this.version[op.id.replicaId] = op.id.counter;
    } else if (op.id.counter < next) {
      this.version[op.id.replicaId] = Math.max(this.version[op.id.replicaId], op.id.counter);
    }

    this.log.set(key, op);

    if (!this.#isReady(op)) {
      this.pending.set(key, op);
      return true;
    }
    this.#apply(op);
    this.#drainPending();
    return true;
  }

  /** 批量接收（数组 / 别的副本导出的 envelope 均可）。返回首次整合数。 */
  receiveOps(ops) {
    let n = 0;
    for (const op of ops) if (this.receive(op)) n++;
    return n;
  }

  #normalizeOp(op) {
    // 容忍 JSON 往返后的纯数据对象。
    return {
      type: op.type,
      id: { ...op.id },
      afterId: op.type === 'insert' ? (op.afterId ? { ...op.afterId } : null) : undefined,
      char: op.type === 'insert' ? op.char : undefined,
      target: op.type === 'delete' && op.target ? { ...op.target } : undefined,
    };
  }

  /** 操作所引用的字符（锚点 / 删除目标）当前是否已知。 */
  #isReady(op) {
    if (op.type === 'insert') {
      return op.afterId === null || this.nodes.has(idToStr(op.afterId));
    }
    return this.nodes.has(idToStr(op.target));
  }

  #drainPending() {
    // 反复扫描直到没有新的就绪操作（有向依赖在同一批里可能跨多层）。
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [key, op] of this.pending) {
        if (this.#isReady(op)) {
          this.pending.delete(key);
          this.#apply(op);
          progressed = true;
        }
      }
    }
    // 推进版本向量中可能补齐的连续段。
    for (const rid of Object.keys(this.version)) {
      let c = this.version[rid];
      while (this.log.has(`${c + 1}@${rid}`)) c++;
      this.version[rid] = c;
    }
  }

  #apply(op) {
    if (op.type === 'insert') {
      const node = { id: op.id, char: op.char, deleted: false, parent: null, children: [] };
      const parent = op.afterId === null ? this.root : this.nodes.get(idToStr(op.afterId));
      node.parent = parent;
      parent.children.push(node);
      parent.children.sort(siblingCmp);
      this.nodes.set(idToStr(op.id), node);
    } else {
      const node = this.nodes.get(idToStr(op.target));
      node.deleted = true;
    }
  }

  // --- 读取 ---------------------------------------------------------------

  /** 迭代式 DFS，按 RGA 总序输出全部字符节点（含 tombstone）。 */
  #allNodes() {
    const out = [];
    const stack = [...this.root.children].reverse();
    while (stack.length) {
      const node = stack.pop();
      out.push(node);
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return out;
  }

  /** 按总序输出所有未删除字符节点。 */
  visibleNodes() {
    return this.#allNodes().filter((n) => !n.deleted);
  }

  /** 当前可见文本。 */
  text() {
    return this.visibleNodes().map((n) => n.char).join('');
  }

  /** 节点数（含 tombstone）与存活数 —— 测试/可观测性用。 */
  stats() {
    const all = this.#allNodes();
    return { total: all.length, alive: all.filter((n) => !n.deleted).length };
  }

  // --- 交换（本地消息对象，不经网络） ----------------------------------------

  /** 导出尚未被对方版本向量覆盖的操作 —— 模拟“发消息给某副本”。 */
  opsSince(otherVersionVector = {}) {
    const ops = [];
    for (const op of this.log.values()) {
      const seen = otherVersionVector[op.id.replicaId] ?? 0;
      if (op.id.counter > seen) ops.push(op);
    }
    return ops;
  }

  /** 当前版本向量副本。 */
  versionVector() {
    return { ...this.version };
  }

  /**
   * 单向同步：this 从 other 拉取自己缺的操作（纯本地对象传递，无网络）。
   * 操作会先按 (replicaId, counter) 排好序再投递，但 CRDT 本身不依赖此顺序；
   * 乱序（见测试）同样收敛。
   */
  pullFrom(other) {
    const ops = other.opsSince(this.version).sort((a, b) =>
      a.id.replicaId === b.id.replicaId
        ? a.id.counter - b.id.counter
        : a.id.replicaId < b.id.replicaId ? -1 : 1);
    return this.receiveOps(ops);
  }

  /** 双向同步（模拟重连后的反熵交换）。 */
  sync(other) {
    const a = this.pullFrom(other);
    const b = other.pullFrom(this);
    return { pulled: a, pushed: b };
  }

  // --- 持久化（本地文件） ---------------------------------------------------

  /** 序列化为纯 JSON 数据（可自行保存/拷贝/内存传输）。 */
  toJSON() {
    const dumpNode = (n) => ({
      id: n.id, char: n.char, deleted: n.deleted,
      children: n.children.map((c) => idToStr(c.id)),
    });
    return {
      replicaId: this.replicaId,
      peers: this.peers,
      clock: this.clock,
      counter: this.counter,
      version: this.version,
      log: [...this.log.values()],
      pending: [...this.pending.values()],
      seen: [...this.seen],
      nodes: [...this.nodes.values()].map(dumpNode),
      rootChildren: this.root.children.map((c) => idToStr(c.id)),
    };
  }

  /** 从 toJSON() 的数据恢复：树结构完整重建，之后可继续正常合并。 */
  static fromJSON(data) {
    const r = new Replica(data.replicaId, data.peers);
    r.clock = data.clock;
    r.counter = data.counter;
    r.version = { ...data.version };

    // 先恢复所有节点（不连边），再连父子边。
    for (const nd of data.nodes) {
      r.nodes.set(idToStr(nd.id), {
        id: nd.id, char: nd.char, deleted: nd.deleted,
        parent: null, children: [],
      });
    }
    const link = (parent, childIds) => {
      for (const cid of childIds) {
        const child = r.nodes.get(cid);
        child.parent = parent;
        parent.children.push(child);
      }
      parent.children.sort(siblingCmp);
    };
    link(r.root, data.rootChildren);
    for (const nd of data.nodes) {
      link(r.nodes.get(idToStr(nd.id)), nd.children);
    }

    for (const op of data.log) r.log.set(idToStr(op.id), op);
    for (const s of data.seen) r.seen.add(s);
    // pending 中只保留确实仍缺依赖的（正常保存时全部保留即可，这里做自愈）。
    for (const op of data.pending) {
      if (!r.#isReady(op)) r.pending.set(idToStr(op.id), op);
    }
    return r;
  }

  /** 保存到本地 JSON 文件。 */
  async save(filePath) {
    await fs.writeFile(filePath, JSON.stringify(this.toJSON()), 'utf8');
  }

  /** 从本地 JSON 文件恢复。 */
  static async load(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return Replica.fromJSON(JSON.parse(raw));
  }

  // --- 历史压缩（tombstone GC） ---------------------------------------------

  /**
   * 判断某个 tombstone（删除节点）当前是否可安全回收。
   *
   * 充分条件（全部满足才可）：
   *   1. 节点已被删除；
   *   2. 存在一个已知“检查点”版本向量 C，使得：
   *        - 本副本的版本向量 dominates C（本副本确实已到达检查点之后）；
   *        - peers 中每个成员的版本向量都 dominates C（全员已见到 ≤C 的所有
   *          操作 —— 包括该字符的 insert 和 delete）；
   *        - 该 insert 与 delete 的操作 ID 都 ≤ C（即 C 已覆盖它们）。
   * 含义：任何现存或未来到达的引用（锚点/删除目标）都不可能再依赖此节点
   * —— 因为能引用它的操作一定“先于”它发生，而全员早已见过那些操作。
   *
   * 实践中由协调方（见 {@link computeCheckpoint}）算出全员共同前沿 C，
   * 各副本在同一 C 上各自执行相同的 GC，结果一致。
   */
  canGarbageCollect(nodeId, checkpoint) {
    const node = this.nodes.get(idToStr(nodeId));
    if (!node || !node.deleted) return false;
    if (!this.#opCovered(node.id, checkpoint)) return false;
    // 删除操作（最后一次把它置为删除状态的操作）也必须被检查点覆盖。
    for (const op of this.log.values()) {
      if (op.type === 'delete' && idEq(op.target, node.id) &&
          !this.#opCovered(op.id, checkpoint)) {
        return false;
      }
    }
    return true;
  }

  #opCovered(id, vv) {
    return id.counter <= (vv[id.replicaId] ?? 0);
  }

  /**
   * 在检查点 checkpoint 下执行压缩：物理移除满足条件的 tombstone。
   *
   * 为保证可见文本与 RGA 总序不变，采用“整棵死子树”规则：仅当一个 tombstone
   * 的全部后裔也都是满足 GC 条件的 tombstone（子树中不存在任何存活节点）时，
   * 才把整棵子树一次性移除。这样没有任何存活节点被挪动，顺序天然保持不变。
   * 死节点下若仍挂着存活后裔（别人曾在该位置继续插入），则保留该 tombstone，
   * 等后裔也被删除且被后续检查点覆盖后再回收。
   *
   * 注意：协调要求所有 peers 都在同一个检查点 C 上执行压缩（见
   * {@link computeCheckpoint}）。压缩后新产生的本地操作只可能以可见字符或
   * ROOT 为锚点，而 ≤C 的旧操作全员已收，因此不会再出现对被回收节点的引用。
   *
   * @returns {{removed:number, remainingTombstones:number}}
   */
  compact(checkpoint) {
    if (!checkpoint) {
      throw new Error('compact 需要一个安全检查点版本向量（见 computeCheckpoint）');
    }
    // 防御：本副本版本向量必须 dominate 检查点。
    for (const [rid, v] of Object.entries(checkpoint)) {
      if ((this.version[rid] ?? 0) < v) {
        throw new Error('检查点超出本副本已知范围，尚不能压缩');
      }
    }

    const removable = (node) => {
      if (node === this.root || !node.deleted) return false;
      if (!this.canGarbageCollect(node.id, checkpoint)) return false;
      return node.children.every(removable);
    };

    const removedKeys = [];
    const prune = (parent) => {
      const kept = [];
      for (const kid of parent.children) {
        if (removable(kid)) {
          // 整棵子树丢弃；收集其中所有节点 key。
          const stack = [kid];
          while (stack.length) {
            const n = stack.pop();
            removedKeys.push(idToStr(n.id));
            stack.push(...n.children);
          }
        } else {
          prune(kid); // 递归清理内部死子树
          kept.push(kid);
        }
      }
      parent.children = kept;
    };
    prune(this.root);

    for (const key of removedKeys) {
      const node = this.nodes.get(key);
      this.nodes.delete(key);
      // 连同针对这些节点的 insert / delete 操作一起从日志移除；
      // seen 集合保留（作为去重屏障，防止旧操作被再次应用）。
      for (const op of [...this.log.values()]) {
        if (idToStr(op.id) === key ||
            (op.type === 'delete' && idToStr(op.target) === key)) {
          this.log.delete(idToStr(op.id));
        }
      }
    }
    return {
      removed: removedKeys.length,
      remainingTombstones: this.#allNodes().filter((n) => n.deleted).length,
    };
  }
}

/**
 * 根据一组副本各自的版本向量，计算“全员共同前沿”检查点：
 *   C[rid] = min(各副本 VV[rid])。
 * C 被每个副本的 VV dominates，意味着所有成员都已收到 ≤C 的全部操作。
 * 这是无需任何网络、仅靠交换版本向量即可得到的安全 GC 屏障。
 */
export function computeCheckpoint(replicasOrVVs, peers) {
  const vvs = replicasOrVVs.map((x) => (x instanceof Replica ? x.versionVector() : x));
  const members = peers ?? [...new Set(vvs.flatMap((v) => Object.keys(v)))];
  const cp = {};
  for (const rid of members) {
    const vals = vvs.map((v) => v[rid] ?? 0);
    cp[rid] = vals.length ? Math.min(...vals) : 0;
  }
  return cp;
}
