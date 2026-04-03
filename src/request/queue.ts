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

export function enqueue(task: Task, priority: PriorityValue = Priority.NORMAL): void {
  _queues[priority].push(task);
  _drain();
}

export function clearQueues(): void {
  _queues[0].length = 0;
  _queues[1].length = 0;
  _queues[2].length = 0;
  // [MEDIUM #5 fix] destroy→init 後に _running が残っているとキューが詰まるのでリセット
  _running = 0;
}

function _drain(): void {
  const cfg = getConfig();
  const max = getIsLowMemory() ? cfg.MAX_CONCURRENT_LOW_MEMORY : cfg.MAX_CONCURRENT_REQUESTS;
  while (_running < max) {
    const task = _queues[2].shift() ?? _queues[1].shift() ?? _queues[0].shift();
    if (!task) break;
    _running++;
    // 同期 throw も finally で捕捉できるよう Promise.resolve() でラップ
    Promise.resolve()
      .then(() => task())
      .finally(() => { _running--; _drain(); });
  }
}
