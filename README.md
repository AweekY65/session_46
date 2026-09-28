# local-crdt-text — 完全本地的协同文本 CRDT 引擎

一个**零网络、零数据库、零外部服务**的协同文本 CRDT 模拟引擎，用于研究和测试多个离线副本并发编辑同一文档时的最终一致性。所有操作日志、副本状态、版本向量、文档数据只存在于**内存与本地文件**（JSON 快照 + JSONL 日志），不依赖 WebSocket、数据库、云协同平台或任何网络连接。

零第三方依赖，仅使用 Node.js 内置模块（`node:test`），测试全部在终端运行。

## 运行环境

- Node.js ≥ 18（内置 test runner、ESM、fs/promises）

```bash
npm test        # 运行全部自动化测试（node --test）
npm run demo    # 三副本分区/恢复/收敛/压缩的端到端演示
```

## 一分钟上手

```js
import { Replica, Network } from './src/index.js';

const a = new Replica('alice');
const b = new Replica('bob');
const net = new Network({ a, b });

// 离线并发编辑：双方都在文档开头插入
a.localInsert(0, 'Hello from Alice');
b.localInsert(0, 'Hi, ');

// 任意顺序、重复、延迟交换都安全，最终收敛
net.syncAll(); // 反熵交换直到不动点
console.log(a.text() === b.text()); // true
console.log(a.text());              // 确定性的同一文本
```

## CRDT 模型：RGA（Replicated Growable Array）

文档是一棵以虚拟节点 root 为根的树。每个字符（或文本片段中的一个码点）是一个**不可变节点**：

```ts
Node {
  id:     Id      // 全局唯一且稳定的身份
  char:   string  // 单个 Unicode 码点
  left:   Id|null // 左锚点（父指针）；null 表示挂在文档开头 root 下
  deleted: boolean // tombstone 标记
}
```

- **插入** `{anchor, chars}`：把新字符挂在锚点节点之下；片段插入的字符以 `left` 链串联，天然保持相邻与顺序。
- **删除** `{targets: Id[]}`：只把目标节点标记为 `deleted`（tombstone），不立即摘除结构。删除是幂等的，重复应用无副作用。
- **线性文本** = 该树的 **DFS 先序遍历**，跳过 `deleted` 节点。

### 稳定的全局操作 ID

```ts
Id { ts, origin, counter, seq }
```

| 字段 | 含义 |
|---|---|
| `ts` | Lamport 逻辑时钟：本地操作 `ts = lamport + 1`；接收操作时 `lamport = max(lamport, op.ts) + 1` |
| `origin` | 产生该操作的副本 ID（全局唯一字符串），用于打破时间戳平局 |
| `counter` | 副本本地单调递增计数，是版本向量的计数单位 |
| `seq` | 一次片段插入内的字符序号；单字符插入恒为 0 |

`(ts, origin, counter, seq)` 在全局无碰撞：同一 `(ts, origin)` 下 counter 唯一，seq 只在批量插入内出现。身份**永不复用、永不回收**，这是删除与乱序合并正确性的基础。

## 操作排序规则（收敛的关键）

同一左锚点下可能挂着多个**并发**插入（兄弟节点）。所有副本必须按同一个**确定性全序**排列它们：

```
compareId(a, b)：
  1. Lamport 时间戳 ts 更大者排前（在文本中更靠左）；
  2. ts 相同（真正并发）时，origin 字典序更小者排前；
  3. 同一操作内按 counter、seq 小者排前。
```

该规则只依赖操作自身携带的信息（无需中心协调），因此：**只要两个副本见过的操作集合相同，无论操作以什么顺序到达，线性化文本必然相同**。测试 `确定性：同样操作集合，不同到达顺序，结果相同` 显式验证了正序/逆序/乱序三种投递的等价性。

## 合并规则与乱序处理

`replica.receive(op)` 的完整流程：

1. **校验**操作结构；更新 Lamport 时钟。
2. **去重**：以显式集合记录“已接收（含缓冲中）/已应用”的 `(origin, counter)`。重复收到同一操作直接返回 `duplicate`，绝不二次应用。
3. **依赖检查**：
   - 插入的 `anchor` 尚未到达；
   - 删除的某个 `target` 尚未到达；

   则操作进入 **pending 缓冲区**（`buffered`）。每应用一个新操作后自动重试缓冲队列直到不动点——这就是**延迟删除**：删除先到、被删字符后到时，删除会在补齐瞬间正确生效。
4. 依赖满足则应用，并记录到操作日志。

**反熵交换**（`Network.exchange(a,b)` / `syncAll()`）：双方按已接收操作集合互发对方缺少的操作，可多跳传播；反复进行直到全部收敛。

### 版本向量与“连续前缀”语义

每个副本持有两个集合：已接收集合与已应用集合（`origin -> Set<counter>`）。对外暴露的**版本向量**取每个 origin 从 1 起**连续无缺口**的最大计数：

```
vv[origin] = 最大的 n，使得 counter 1..n 全部已见
```

这比“取见过的最大 counter”更严格，却是乱序安全的关键：若 counter #3 先到而 #1 未到，向量只计到缺口之前，不会谎称 #1/#2 已见。版本向量用于：

- `dominates(other)`：判断操作集合的 happens-before 包含关系；
- 反熵时的差集交换（实现中直接用已接收集合，允许带缺口判断）；
- 计算**全局 barrier**：所有参与副本向量逐分量取最小值。

## 安全压缩 tombstone 的条件

Tombstone 不能随意丢弃——一个迟到的删除/插入可能仍引用它。`replica.checkpoint(barrier)` 在以下**全部条件**满足时才允许物理删除 tombstone：

1. `barrier = min(VV_1, …, VV_n)`（逐分量最小，由 `Network.barrierOf()` 计算）：表示 barrier 覆盖的每个操作**所有参与副本都已收到**，此后不会再有“迟到的、引用这些节点”的操作；
2. 本副本**没有未应用的缓冲操作**（pending 为空）；
3. 本副本版本向量**包含** barrier（`vv.dominates(barrier)`）。

压缩时：

- 存活节点按当前线性顺序**拍平为同序链表**，文本不变；
- 为被丢弃的 id 保留轻量**转发指针**（指向前一个存活节点或 root）。极少数“屏障之后才发起、却锚定屏障前已删除节点”的操作可据此确定性重定位；
- 被丢弃 id 记入 `dropped`，迟到的删除按 **no-op** 处理而不是永久缓冲。

再次 checkpoint 是幂等安全的（无可删内容时 `removed = 0`）。

## 本地状态保存与恢复

```js
import { saveSnapshot, loadSnapshot, appendOps, replayFromLog } from './src/index.js';

await saveSnapshot(replica, './data/alice');   // 原子写 snapshot.json
const r = await loadSnapshot('./data/alice');  // 重启后恢复，继续 receive/合并
await appendOps('./data/alice', ops);          // 追加 JSONL 操作日志
const rebuilt = await replayFromLog('alice', './data/alice'); // 从日志重建
```

- `snapshot.json`：完整状态（节点、版本集合、pending、操作日志、barrier、转发表、dropped），原子写入（临时文件 + rename）。
- `operations.log`：每行一个操作的 JSONL 追加日志，乱序日志也能回放（缺失依赖自动缓冲）。
- **重启等价性**：恢复出的副本继续合并，结果与从不中断执行完全一致（测试 `状态恢复：重启的副本继续合并，与不中断执行结果一致`，以及模糊测试的 restart 场景）。

## “不可靠网络”模拟器（纯内存）

`src/network.js` 的 `Network` 不开任何 socket，操作只在内存队列传递，用于模拟：

| 能力 | API |
|---|---|
| 分区 / 恢复 | `partition([['a','b'],['c']])` / `heal()`（分区期消息滞留，恢复后补发） |
| 乱序投递 | `shuffleDeliver(from, to)`（固定种子 PRNG，可复现） |
| 重复投递 | `broadcast(from, { duplicate: true })` |
| 反熵交换 | `exchange(a,b)` / `syncAll()` |
| 收敛断言 | `allConverged()` |
| 全局 barrier | `barrierOf()` |

## 目录结构

```
src/
  id.js              # 全局 ID 与确定性全序 compareId
  version-vector.js  # 版本向量：observe/merge/dominates/barrier
  replica.js         # RGA 副本：编辑、合并、缓冲、checkpoint、快照
  network.js         # 本地网络模拟器（分区/乱序/重复/反熵）
  storage.js         # JSON 快照 + JSONL 日志（原子写、回放）
  index.js           # 统一导出
test/                # node:test 自动化测试（42 个用例）
examples/demo.js     # 端到端演示
```

## 测试覆盖

全部测试仅依赖 Node.js 内置 test runner，终端直接运行：

```bash
npm test          # 或 node --test
```

覆盖场景：

- **版本向量**：观察/合并/偏序/barrier/JSON 往返；
- **双副本与多副本并发**（2、3、4、5 个副本）、多跳反熵传播；
- **乱序传递**：固定种子 shuffle、完全逆序、交错投递；
- **重复操作**：重放不二次应用（含先到高 counter 的 gap 场景）；
- **并发同位置插入**：Lamport 排序与 origin 平局仲裁；
- **并发插入/删除交叉**：删除与插入在同一位置竞争（删除胜出，语义确定）；
- **延迟删除**：删除先于目标到达，补齐后联动应用；部分缺失逐补齐；
- **网络分区**：分区期间各自编辑、消息滞留、heal 后补发收敛；
- **tombstone 压缩**：barrier 保护、pending/未收齐时拒绝压缩、压缩后锚点重定位、迟到删除 no-op、多副本压缩一致与幂等；
- **状态恢复**：快照/日志往返、重启后继续合并与不中断执行结果一致、原子写；
- **最终收敛模糊测试**：多种子、随机编辑/删除/交换/分区、周期 checkpoint、全体快照重启，并与“见过全部操作的参考副本”逐字符比对。

## 设计边界（刻意为之）

- 这是**本地模拟/研究引擎**，传输层被刻意省略：`Network` 只做内存消息传递，演示“如果网络可以乱序、重复、分区，CRDT 如何收敛”。接入真实传输时只需把 `replica.receive(op)` 接到任意信道（操作是可 JSON 序列化的普通对象）。
- 每个节点一个字符（码点），未做字符串区间压缩（RGA String）；长文本可在此模型上叠加区间节点优化。
