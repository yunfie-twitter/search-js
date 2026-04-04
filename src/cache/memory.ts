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

/** エンドポイントとパラメータからキャッシュキーを生成する。 */
export function getCacheKey(endpoint: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort();
  let key = endpoint;
  for (const k of sorted) {
    const v = params[k];
    if (v != null) key += _SEP + k + "=" + String(v);
  }
  return key;
}

/** キャッシュから取得する。ヒット時はエントリを LRU 末尾に移動する。 */
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

/** キャッシュにデータを書き込む。上限超過時は LRU 先頭から削除する。 */
export function set(key: string, data: unknown): void {
  if (data == null) return;
  const max = getCurrentCacheMax();
  // [QUALITY fix] max が 0 以下の場合は何もしない（無限ループ防止）
  if (max <= 0) return;
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

/** TTL 切れエントリを一括削除する。イテレート中の Map 変更を避けるため削除は二段階。 */
export function evictExpired(): void {
  const ttl = getConfig().CACHE_TTL;
  const now = Date.now();
  const toDelete: string[] = [];
  for (const [key, item] of store) {
    if (now - item.time > ttl) toDelete.push(key);
  }
  for (const key of toDelete) store.delete(key);
}

/** Critical メモリ状態時にキャッシュを半分に切り捨てる。 */
export function trimToHalf(): void {
  if (!getIsCriticalMemory()) return;
  const half = Math.ceil(store.size / 2);
  while (store.size > half) {
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey as string);
    else break;
  }
}

/** キャッシュを全削除する。 */
export function clearStore(): void { store.clear(); }
