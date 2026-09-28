/**
 * local-crdt-text —— 完全本地的协同文本 CRDT 引擎。
 * 无 WebSocket、无数据库、无云服务；状态仅存在于内存与本地文件。
 */

export { Replica } from './replica.js';
export { VersionVector } from './version-vector.js';
export { compareId, idKey, opKey, sameId } from './id.js';
export {
  saveSnapshot,
  loadSnapshot,
  appendOps,
  readLog,
  replayFromLog,
  SNAPSHOT_FILE,
  LOG_FILE,
} from './storage.js';
export { Network, makeRng } from './network.js';
