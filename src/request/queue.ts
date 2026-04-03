// src/request/queue.ts
import { getConfig } from "../config.js";
import { getIsLowMemory } from "../memory.js";

export const Priority = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 } as const);
export type PriorityValue = typeof Priority[keyof typeof Priority];

type QueueTask = () => Promise<unknown>;

const queues: QueueTask[][] = [[], [], []]; // HIGH / NORMAL / LOW
let active = 0;

export function enqueue(fn: QueueTask, priority: PriorityValue = Priority.NORMAL): void {
  const cfg = getConfig();
  const maxQ = getIsLowMemory() ? 10 : 20;
  const total = queues.reduce((s, q) => s + q.length, 0);

  if (total >= maxQ) {
    if (queues[Priority.LOW].length > 0) queues[Priority.LOW].pop();
    else if (queues[Priority.NORMAL].length > 0) queues[Priority.NORMAL].pop();
  }

  queues[priority].push(fn);
  _drain(cfg.MAX_CONCURRENT_REQUESTS);
}

function _drain(maxConcurrent: number): void {
  while (active < maxConcurrent) {
    const fn =
      queues[Priority.HIGH].shift() ??
      queues[Priority.NORMAL].shift() ??
      queues[Priority.LOW].shift();
    if (!fn) break;

    active++;
    fn()
      .catch((e: unknown) => console.error("Queue error:", e))
      .finally(() => { active--; queueMicrotask(() => _drain(maxConcurrent)); });
  }
}
