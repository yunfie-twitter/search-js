// src/cache/memory.ts
import { getConfig } from "../config.js";
import { getCurrentCacheMax, getIsCriticalMemory } from "../memory.js";

interface CacheItem {
  time: number;
  data: string | unknown;
  parsed?: unknown;
}

interface CacheHit {
  data: unknown;
  expired: boolean;
}

export const store = new Map<string, CacheItem>();

const _SEP = "\x00";
export function getCacheKey(endpoint: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort();
  let key = endpoint;
  for (const k of sorted) {
    const v = params[k];
    if (v != null) key += _SEP + k + "=" + String(v);
  }
  return key;
}

export function get(key: string): CacheHit | null {
  const item = store.get(key);
  if (!item) return null;
  store.delete(key);
  store.set(key, item);
  if (typeof item.data === "string" && item.parsed === undefined) {
    try { item.parsed = JSON.parse(item.data); }
    catch { item.parsed = item.data; }
  }
  return { data: item.parsed ?? item.data, expired: Date.now() - item.time > getConfig().CACHE_TTL };
}

export function set(key: string, data: unknown): void {
  if (data == null) return;
  const max = getCurrentCacheMax();
  if (store.has(key)) store.delete(key);
  while (store.size >= max) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey as string);
    else break;
  }
  const cfg = getConfig();
  let jsonStr: string;
  try {
    jsonStr = typeof data === "string" ? data : JSON.stringify(data);
  } catch { return; }
  store.set(key, {
    time: Date.now(),
    data: jsonStr.length < cfg.STRINGIFY_SIZE_THRESHOLD ? jsonStr : data,
  });
}

export function evictExpired(): void {
  // #4 fix: イテレート中に Map を変更しないよう削除キーを先に収集する
  const ttl = getConfig().CACHE_TTL;
  const now = Date.now();
  const toDelete: string[] = [];
  for (const [key, item] of store) {
    if (now - item.time > ttl) toDelete.push(key);
  }
  for (const key of toDelete) store.delete(key);
}

export function trimToHalf(): void {
  if (!getIsCriticalMemory()) return;
  const half = Math.ceil(store.size / 2);
  while (store.size > half) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey as string);
    else break;
  }
}

export function clearStore(): void { store.clear(); }
