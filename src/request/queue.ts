// src/request/queue.ts
import { getConfig } from "../config.ts";
import { getIsLowMemory } from "../memory.ts";

export const Priority = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 } as const);
export type PriorityValue = typeof Priority[keyof typeof Priority];

type QueueTask = () => Promise<unknown>;

// 3優先度のリングバッファキュー（固定サイズで shift() O(1) で高速）
const QUEUE_CAP = 64; // 2のべき乗にするとマスク演算が利く
nerg
class RingQueue<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _size = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
    this.buf = new Array<T | undefined>(cap);
  }

  get size(): number { return this._size; }

  push(item: T): boolean {
    if (this._size >= this.cap) return false;
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) & (this.cap - 1);
    this._size++;
    return true;
  }

  /** 最後の要素を捨てる（LOW キューの eviction 用） */
  popBack(): T | undefined {
    if (this._size === 0) return undefined;
    this.tail = (this.tail - 1 + this.cap) & (this.cap - 1);
    const item = this.buf[this.tail];
    this.buf[this.tail] = undefined;
    this._size--;
    return item;
  }

  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const item = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) & (this.cap - 1);
    this._size--;
    return item;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }
}

const queues = [
  new RingQueue<QueueTask>(QUEUE_CAP),
  new RingQueue<QueueTask>(QUEUE_CAP),
  new RingQueue<QueueTask>(QUEUE_CAP),
] as const;

let active = 0;

export function enqueue(fn: QueueTask, priority: PriorityValue = Priority.NORMAL): void {
  const cfg = getConfig();
  const maxQ = getIsLowMemory() ? 10 : 20;
  const total = queues[0].size + queues[1].size + queues[2].size;

  if (total >= maxQ) {
    if (queues[Priority.LOW].size > 0) queues[Priority.LOW].popBack();
    else if (queues[Priority.NORMAL].size > 0) queues[Priority.NORMAL].popBack();
    else return;
  }

  queues[priority].push(fn);
  _drain(cfg.MAX_CONCURRENT_REQUESTS);
}

export function clearQueues(): void {
  queues[0].clear();
  queues[1].clear();
  queues[2].clear();
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
