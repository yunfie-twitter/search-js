// src/offline.ts
import { emit } from "./events.js";

type RetryTask = () => Promise<void>;

const _pendingRetries: RetryTask[] = [];
let _isOnline = true;
let _initialized = false;

export function getIsOnline(): boolean { return _isOnline; }

export function initOfflineMonitor(): void {
  // [FREEZE #6 fix]
  // 旧実装: _initialized チェックのみで、destroy() → init() の高速呼び出し時に
  //   _initialized = false になる前に initOfflineMonitor() が再入し
  //   イベントリスナーが二重登録されて _handleOnline/_handleOffline が2回発火
  //   → emit("online") が2回 → 積まれていたリトライタスクが2重実行されフリーズ
  //
  // 新実装: 初期化前に必ず既存リスナーを除去してから再登録する
  //   これにより destroy→init の競合状態でもリスナーは常に1本だけになる
  if (typeof window === "undefined") return;
  // 前回登録分を先に除去（二重登録防止）
  window.removeEventListener("online",  _handleOnline);
  window.removeEventListener("offline", _handleOffline);
  _initialized = true;
  _isOnline = navigator.onLine;
  window.addEventListener("online",  _handleOnline);
  window.addEventListener("offline", _handleOffline);
}

export function destroyOfflineMonitor(): void {
  if (typeof window !== "undefined") {
    window.removeEventListener("online",  _handleOnline);
    window.removeEventListener("offline", _handleOffline);
  }
  _initialized = false;
  _isOnline = true;
  _pendingRetries.length = 0;
}

export function addRetryTask(task: RetryTask): void {
  // #10 fix: destroy 後は孤立タスクを追加しない
  if (!_initialized) return;
  if (_pendingRetries.length < 50) _pendingRetries.push(task);
}

function _handleOnline(): void {
  _isOnline = true;
  emit("online");
  const tasks = _pendingRetries.splice(0);
  for (const task of tasks) task().catch(() => {});
}

function _handleOffline(): void {
  _isOnline = false;
  emit("offline");
}
