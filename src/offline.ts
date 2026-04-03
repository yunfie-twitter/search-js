// src/offline.ts
// オフライン検知・復帺時 SWR 再試行

import { emit } from "./events.ts";

type RetryTask = () => Promise<void>;

const _pendingRetries: RetryTask[] = [];
let _isOnline = true;
let _initialized = false;

export function getIsOnline(): boolean {
  return _isOnline;
}

/**
 * オフラインモニターを起動する。
 * init() 内から呼ぶ。SSR 環境では何もしない。
 */
export function initOfflineMonitor(): void {
  if (_initialized || typeof window === "undefined") return;
  _initialized = true;
  _isOnline = navigator.onLine;

  window.addEventListener("online", _handleOnline);
  window.addEventListener("offline", _handleOffline);
}

export function destroyOfflineMonitor(): void {
  if (!_initialized) return;
  _initialized = false;
  if (typeof window === "undefined") return;
  window.removeEventListener("online", _handleOnline);
  window.removeEventListener("offline", _handleOffline);
  _pendingRetries.length = 0;
}

/**
 * オフライン時に実行できなかった処理を登録する。
 * オンライン復帺時に自動実行される。
 */
export function addRetryTask(task: RetryTask): void {
  _pendingRetries.push(task);
}

function _handleOnline(): void {
  _isOnline = true;
  emit("online");
  // 溞留中のタスクを順次実行（エラーは無視して続行）
  const tasks = _pendingRetries.splice(0);
  for (const task of tasks) {
    task().catch(() => {});
  }
}

function _handleOffline(): void {
  _isOnline = false;
  emit("offline");
}
