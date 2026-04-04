// src/request/queue.ts
import { getConfig } from "../config.js";
import { getIsLowMemory } from "../memory.js";

export type PriorityValue = 0 | 1 | 2;

export const Priority = {
  LOW: 0 as PriorityValue,
  NORMAL: 1 as PriorityValue,
  HIGH: 2 as PriorityValue,
} as const;

type Task = () => Promise<void>;

const _queues: [Task[], Task[], Task[]] = [[], [], []];
let _running = 0;
// [FREEZE #3 fix] スケジュール済み drain が多重発火しないよう管理するフラグ
let _drainScheduled = false;

export function enqueue(task: Task, priority: PriorityValue = Priority.NORMAL): void {
  _queues[priority].push(task);
  _scheduleDrain();
}

export function clearQueues(): void {
  _queues[0].length = 0;
  _queues[1].length = 0;
  _queues[2].length = 0;
  // [MEDIUM #5 fix] destroy→init 後に _running が残っているとキューが詰まるのでリセット
  _running = 0;
  _drainScheduled = false;
}

// [FREEZE #3 fix]
// 旧実装: _drain() が finally から直接 _drain() を再帰呼び出し
//   → 大量タスクがある場合に Promise マイクロタスクが連鎖し
//     マイクロタスクキューを占有してUIスレッドをブロック(フリーズ)する
//
// 新実装: queueMicrotask を使わず setTimeout(0) で次の「タスク」にスケジュール
//   → ブラウザがレンダリングや入力イベントを処理する機会を確保する
//   → _drainScheduled フラグで多重 setTimeout が積まれるのを防ぐ
function _scheduleDrain(): void {
  if (_drainScheduled) return;
  _drainScheduled = true;
  setTimeout(_drainNow, 0);
}

function _drainNow(): void {
  _drainScheduled = false;
  const cfg = getConfig();
  const max = getIsLowMemory() ? cfg.MAX_CONCURRENT_LOW_MEMORY : cfg.MAX_CONCURRENT_REQUESTS;
  while (_running < max) {
    const task = _queues[2].shift() ?? _queues[1].shift() ?? _queues[0].shift();
    if (!task) break;
    _running++;
    Promise.resolve()
      .then(() => task())
      .finally(() => {
        _running--;
        // タスク完了後はキューに残りがあれば再スケジュール
        _scheduleDrain();
      });
  }
}
