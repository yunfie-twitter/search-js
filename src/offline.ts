// src/offline.ts
import { emit } from "./events.ts";

type RetryTask = () => Promise<void>;

const _pendingRetries: RetryTask[] = [];
let _isOnline = true;
let _initialized = false;

export function getIsOnline(): boolean {
  return _isOnline;
}

export function initOfflineMonitor(): void {
  if (_initialized || typeof window === "undefined") return;
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
  // 捨てずにクリアする（リーク防止）
  _pendingRetries.length = 0;
}

export function addRetryTask(task: RetryTask): void {
  // 上限を設けて際限なく溢れるのを防ぐ
  if (_pendingRetries.length < 50) _pendingRetries.push(task);
}

function _handleOnline(): void {
  _isOnline = true;
  emit("online");
  const tasks = _pendingRetries.splice(0);
  for (const task of tasks) {
    // 各タスクのエラーは独立して処理し、後続タスクをブロックしない
    task().catch(() => {});
  }
}

function _handleOffline(): void {
  _isOnline = false;
  emit("offline");
}
