// src/cache/memory.ts
import { getConfig } from "../config.ts";
import { getCurrentCacheMax } from "../memory.ts";

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

// キャッシュキーの生成: URLSearchParams を避けシンプルな文字列連結にして高速化
const _SEP = "\x00";
export function getCacheKey(endpoint: string, params: Record<string, unknown>): string {
  // キーをソートして問わず同じキーになるようにする
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

  // LRU: delete+set は Map の振る舞い上最新になる
  store.delete(key);
  store.set(key, item);

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
  while (store.size >= max) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
    else break;
  }

  // 小さいデータは JSON 文字列で保持して遅延パースを活用、大きいデータはオブジェクトのまま保持
  const jsonStr = typeof data === "string" ? data : JSON.stringify(data);
  store.set(key, {
    time: Date.now(),
    data: jsonStr.length < cfg.STRINGIFY_SIZE_THRESHOLD ? jsonStr : data,
  });
}

export function clearStore(): void {
  store.clear();
}
