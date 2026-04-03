// src/cache/memory.ts
import { getConfig } from "../config.ts";
import { getCurrentCacheMax } from "../memory.ts";

interface CacheItem {
  time: number;
  /** 小さいデータは JSON 文字列で保持、大きいデータはオブジェクトのまま */
  data: string | unknown;
  parsed?: unknown;
}

interface CacheHit {
  data: unknown;
  expired: boolean;
}

export const store = new Map<string, CacheItem>();

export function getCacheKey(endpoint: string, params: Record<string, unknown>): string {
  return endpoint + "?" + new URLSearchParams(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    )
  ).toString();
}

export function get(key: string): CacheHit | null {
  const item = store.get(key);
  if (!item) return null;

  // LRU 更新
  store.delete(key);
  store.set(key, item);

  // 遅延 JSON パース（パース済みなら再利用）
  if (typeof item.data === "string" && item.parsed === undefined) {
    try {
      item.parsed = JSON.parse(item.data);
    } catch {
      item.parsed = item.data;
    }
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

  // 上限を超えたら古いエントリを削除（LRU eviction）
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

/** キャッシュを完全にクリアする（メモリ解放・テスト用） */
export function clearStore(): void {
  store.clear();
}
