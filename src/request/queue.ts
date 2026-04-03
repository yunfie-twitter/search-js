// src/request/queue.ts
import { getConfig } from "../config.ts";
import { getIsLowMemory } from "../memory.ts";

export const Priority = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 } as const);
export type PriorityValue = typeof Priority[keyof typeof Priority];

type QueueTask = () => Promise<unknown>;

const queues: QueueTask[][] = [[], [], []]; // HIGH / NORMAL / LOW
let active = 0;

export function enqueue(fn: QueueTask, priority: PriorityValue = Priority.NORMAL): void {
  const cfg = getConfig();
  const maxQ = getIsLowMemory() ? 10 : 20;
  const total = queues.reduce((s, q) => s + q.length, 0);

  // キュー上限超過時は優先度の低いタスクから捨てる
  if (total >= maxQ) {
    if (queues[Priority.LOW].length > 0) queues[Priority.LOW].pop();
    else if (queues[Priority.NORMAL].length > 0) queues[Priority.NORMAL].pop();
    else return; // HIGH しかない場合は追加しない（過負荷防止）
  }

  queues[priority].push(fn);
  _drain(cfg.MAX_CONCURRENT_REQUESTS);
}

/** キューを全クリアする（ページ離脱・テスト用） */
export function clearQueues(): void {
  queues[Priority.HIGH].length = 0;
  queues[Priority.NORMAL].length = 0;
  queues[Priority.LOW].length = 0;
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
      .finally(() => {
        active--;
        queueMicrotask(() => _drain(maxConcurrent));
      });
  }
}
