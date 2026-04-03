// src/cache/memory.ts
import { getConfig } from "../config.ts";
import { getCurrentCacheMax, getIsCriticalMemory } from "../memory.ts";

interface CacheItem {
  time: number;
  /** 小さいデータは JSON 文字列で保持（遅延パース）、大きいデータはオブジェクトのまま */
  data: string | unknown;
  parsed?: unknown;
}

interface CacheHit {
  data: unknown;
  expired: boolean;
}

export const store = new Map<string, CacheItem>();

// null バイト区切りでキー生成（URLSearchParams より高速）
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

  // LRU 更新（delete → set で末尾へ移動）
  store.delete(key);
  store.set(key, item);

  // 遅延 JSON パース（パース済みなら再利用）
  if (typeof item.data === "string" && item.parsed === undefined) {
    try { item.parsed = JSON.parse(item.data); }
    catch { item.parsed = item.data; }
  }

  return {
    data: item.parsed ?? item.data,
    expired: Date.now() - item.time > getConfig().CACHE_TTL,
  };
}

export function set(key: string, data: unknown): void {
  const cfg = getConfig();
  const max = getCurrentCacheMax();

  if (store.has(key)) store.delete(key);

  // LRU eviction（上限超過分を古い順に削除）
  while (store.size >= max) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
    else break;
  }

  const jsonStr = typeof data === "string" ? data : JSON.stringify(data);
  store.set(key, {
    time: Date.now(),
    data: jsonStr.length < cfg.STRINGIFY_SIZE_THRESHOLD ? jsonStr : data,
  });
}

/**
 * LowMemory 時に期限切れエントリを即削除して空き容量を確保する。
 * index.ts の request() から呼ばれる。
 */
export function evictExpired(): void {
  const ttl = getConfig().CACHE_TTL;
  const now = Date.now();
  for (const [key, item] of store) {
    if (now - item.time > ttl) store.delete(key);
  }
}

/**
 * Critical 時にキャッシュを半分まで強制削減。
 */
export function trimToHalf(): void {
  if (!getIsCriticalMemory()) return;
  const half = Math.ceil(store.size / 2);
  while (store.size > half) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
    else break;
  }
}

/** キャッシュ完全クリア（destroy 用） */
export function clearStore(): void {
  store.clear();
}
