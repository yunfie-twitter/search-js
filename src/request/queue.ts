// src/request/queue.ts
import { getConfig } from "../config.ts";
import { getIsLowMemory } from "../memory.ts";

export const Priority = Object.freeze({
  HIGH: 0,
  NORMAL: 1,
  LOW: 2,
} as const);

export type PriorityValue = typeof Priority[keyof typeof Priority];

type QueueTask = () => Promise<unknown>;

class RingQueue<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _size = 0;
  private readonly mask: number;

  constructor(cap: number) {
    // capは2のべき乗チェック（安全性UP）
    if ((cap & (cap - 1)) !== 0) {
      throw new Error("RingQueue capacity must be a power of 2");
    }
    this.mask = cap - 1;
    this.buf = new Array<T | undefined>(cap);
  }

  get size(): number {
    return this._size;
  }

  get capacity(): number {
    return this.buf.length;
  }

  push(item: T): boolean {
    if (this._size >= this.buf.length) return false;
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) & this.mask;
    this._size++;
    return true;
  }

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

// ---- config ----
const QUEUE_CAP = 64;

// ---- queues ----
const queues = [
  new RingQueue<QueueTask>(QUEUE_CAP), // HIGH
  new RingQueue<QueueTask>(QUEUE_CAP), // NORMAL
  new RingQueue<QueueTask>(QUEUE_CAP), // LOW
] as const;

let active = 0;
let draining = false; // 再入防止（重要）

export function enqueue(
  fn: QueueTask,
  priority: PriorityValue = Priority.NORMAL
): boolean {
  const cfg = getConfig();
  const lowMem = getIsLowMemory();

  // ---- low memory guard ----
  if (lowMem && priority === Priority.LOW) return false;

  const maxQ = lowMem ? 10 : 20;
  const total =
    queues[0].size + queues[1].size + queues[2].size;

  if (total >= maxQ) {
    // eviction（低優先度から削除）
    if (queues[Priority.LOW].size > 0) {
      queues[Priority.LOW].popBack();
    } else if (queues[Priority.NORMAL].size > 0) {
      queues[Priority.NORMAL].popBack();
    } else {
      return false; // HIGHしかない場合は拒否
    }
  }

  if (!queues[priority].push(fn)) return false;

  _scheduleDrain();
  return true;
}

export function clearQueues(): void {
  queues[0].clear();
  queues[1].clear();
  queues[2].clear();
}

// ---- drain制御 ----
function _scheduleDrain(): void {
  if (draining) return;
  draining = true;

  queueMicrotask(() => {
    draining = false;

    const maxConcurrent = getIsLowMemory()
      ? getConfig().MAX_CONCURRENT_LOW_MEMORY
      : getConfig().MAX_CONCURRENT_REQUESTS;

    _drain(maxConcurrent);
  });
}

function _drain(maxConcurrent: number): void {
  while (active < maxConcurrent) {
    const fn =
      queues[Priority.HIGH].shift() ??
      queues[Priority.NORMAL].shift() ??
      queues[Priority.LOW].shift();

    if (!fn) break;

    active++;

    let finished = false;

    const done = (): void => {
      if (finished) return;
      finished = true;

      active--;

      const nextMax = getIsLowMemory()
        ? getConfig().MAX_CONCURRENT_LOW_MEMORY
        : getConfig().MAX_CONCURRENT_REQUESTS;

      _scheduleDrain();
      if (active < nextMax) {
        _drain(nextMax);
      }
    };

    try {
      const p = fn();

      // Promiseじゃない事故防止
      if (!p || typeof p.then !== "function") {
        console.error("[queue] Task did not return Promise");
        done();
        continue;
      }

      p.then(done)
        .catch((e: unknown) => {
          console.error("[queue] Task error:", e);
          done();
        });

    } catch (e) {
      console.error("[queue] Sync error:", e);
      done();
    }
  }
}
