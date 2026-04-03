// src/request/queue.ts
import { getConfig } from "../config.ts";
import { getIsLowMemory } from "../memory.ts";

export const Priority = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 } as const);
export type PriorityValue = typeof Priority[keyof typeof Priority];

type QueueTask = () => Promise<unknown>;

/**
 * O(1) の push / shift / popBack を持つリングバッファキュー。
 * cap は必ず 2 のべき乗にすること（ビットマスク最適化のため）。
 */
class RingQueue<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _size = 0;
  private readonly mask: number;

  constructor(cap: number) {
    this.mask = cap - 1;
    this.buf = new Array<T | undefined>(cap);
  }

  get size(): number { return this._size; }

  push(item: T): boolean {
    if (this._size >= this.buf.length) return false;
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) & this.mask;
    this._size++;
    return true;
  }

  /** 末尾（最後に追加した要素）を捨てる ― LOW キューの eviction 用 */
  popBack(): T | undefined {
    if (this._size === 0) return undefined;
    this.tail = (this.tail - 1 + this.buf.length) & this.mask;
    const item = this.buf[this.tail];
    this.buf[this.tail] = undefined;
    this._size--;
    return item;
  }

  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const item = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
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

const QUEUE_CAP = 64; // 2^6
const queues = [
  new RingQueue<QueueTask>(QUEUE_CAP), // HIGH
  new RingQueue<QueueTask>(QUEUE_CAP), // NORMAL
  new RingQueue<QueueTask>(QUEUE_CAP), // LOW
] as const;

let active = 0;

export function enqueue(fn: QueueTask, priority: PriorityValue = Priority.NORMAL): void {
  const cfg = getConfig();
  const lowMem = getIsLowMemory();

  // LowMemory 時は LOW 優先度タスクを受け付けない
  if (lowMem && priority === Priority.LOW) return;

  const maxQ = lowMem ? 10 : 20;
  const total = queues[0].size + queues[1].size + queues[2].size;

  if (total >= maxQ) {
    // キュー満杯: 優先度の低いものから捨てる
    if (queues[Priority.LOW].size > 0) queues[Priority.LOW].popBack();
    else if (queues[Priority.NORMAL].size > 0) queues[Priority.NORMAL].popBack();
    else return; // HIGH しかない場合は追加しない
  }

  queues[priority].push(fn);

  // LowMemory 時は並列数を制限して drain する
  const maxConcurrent = lowMem
    ? cfg.MAX_CONCURRENT_LOW_MEMORY
    : cfg.MAX_CONCURRENT_REQUESTS;
  _drain(maxConcurrent);
}

/** 全キューを破棄（destroy 用） */
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
      .catch((e: unknown) => console.error("[search-js] Queue error:", e))
      .finally(() => {
        active--;
        // LowMemory が変化している可能性があるため毎回評価
        const maxC = getIsLowMemory()
          ? getConfig().MAX_CONCURRENT_LOW_MEMORY
          : getConfig().MAX_CONCURRENT_REQUESTS;
        queueMicrotask(() => _drain(maxC));
      });
  }
}
