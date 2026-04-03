// src/suggest.ts
import { getConfig } from "./config.js";
import { getIsLowMemory } from "./memory.js";
import { fetchWithRetry, type FetchResult } from "./request/retry.js";
import { enqueue, Priority } from "./request/queue.js";
import { debounce } from "./utils.js";

/* =========================
 * 型
 * ========================= */

export interface SuggestItem {
  title: string;
  lower: string;
}

export interface SuggestResult {
  ok: boolean;
  query: string;
  items: SuggestItem[];
  cached?: boolean;
  error?: string;
}

interface SuggestCacheEntry {
  items: SuggestItem[];
  time: number;
}

/* =========================
 * キャッシュ
 * ========================= */

const _cache = new Map<string, SuggestCacheEntry>();
const SUGGEST_CACHE_MAX = 50;

function _cacheKey(q: string): string {
  return q.trim().toLowerCase();
}

function _cacheGet(key: string): SuggestCacheEntry | null {
  const entry = _cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.time > getConfig().SUGGEST_TTL) {
    _cache.delete(key);
    return null;
  }

  // LRU更新
  _cache.delete(key);
  _cache.set(key, entry);

  return entry;
}

function _cacheSet(key: string, items: SuggestItem[]): void {
  if (_cache.has(key)) _cache.delete(key);

  while (_cache.size >= SUGGEST_CACHE_MAX) {
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
    else break;
  }

  _cache.set(key, { items, time: Date.now() });
}

/**
 *  フリーズ対策済 prefix検索
 */
function _cacheFindPrefix(q: string): SuggestCacheEntry | null {
  const key = _cacheKey(q);
  const exact = _cacheGet(key);
  if (exact) return exact;

  const now = Date.now();
  const ttl = getConfig().SUGGEST_TTL;

  let hitKey: string | null = null;
  let hitItems: SuggestItem[] | null = null;

  for (const [k, entry] of _cache) {
    if (now - entry.time > ttl) continue;

    if (key.startsWith(k)) {
      const filtered = entry.items.filter((item) =>
        item.lower.includes(key)
      );

      if (filtered.length > 0) {
        hitKey = k;
        hitItems = filtered;
        break;
      }
    }
  }

  if (hitKey && hitItems) {
    const entry = { items: hitItems, time: now };
    _cache.delete(hitKey);
    _cache.set(hitKey, entry);
    return entry;
  }

  return null;
}

export function clearSuggestCache(): void {
  _cache.clear();
}

/* =========================
 * 通信制御
 * ========================= */

const _inFlight = new Map<string, Promise<SuggestResult>>();

const _fetchOpts: RequestInit = Object.freeze({
  method: "GET",
  headers: Object.freeze({ Accept: "application/json" }),
});

/**
 *  フリーズ対策済 fetch
 */
async function _fetchSuggest(q: string): Promise<SuggestResult> {
  const key = _cacheKey(q);

  const cached = _cacheFindPrefix(q);
  if (cached) {
    return { ok: true, query: q, items: cached.items, cached: true };
  }

  const existing = _inFlight.get(key);
  if (existing) return existing;

  const cfg = getConfig();
  const url = new URL(cfg.API_BASE + "/search");
  url.searchParams.set("q", q.trim());
  url.searchParams.set("type", "suggest");

  const promise = new Promise<SuggestResult>((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        ok: false,
        query: q,
        items: [],
        error: "timeout",
      });
    }, 5000);

    enqueue(async () => {
      try {
        const result: FetchResult = await fetchWithRetry(
          url.toString(),
          _fetchOpts,
          "suggest\x00" + key
        );

        if (!result.ok) {
          resolve({
            ok: false,
            query: q,
            items: [],
            error: result.error,
          });
          return;
        }

        const items = _parse(result.data);
        _cacheSet(key, items);

        resolve({
          ok: true,
          query: q,
          items,
        });
      } catch {
        resolve({
          ok: false,
          query: q,
          items: [],
          error: "unknown_error",
        });
      } finally {
        clearTimeout(timeout);
        _inFlight.delete(key);
      }
    }, Priority.HIGH);
  });

  _inFlight.set(key, promise);
  return promise;
}

/* =========================
 * パース
 * ========================= */

function _parse(data: unknown): SuggestItem[] {
  return _toArray(data).reduce<SuggestItem[]>((acc, item) => {
    const title = _title(item);
    if (title) {
      acc.push({
        title,
        lower: title.toLowerCase(),
      });
    }
    return acc;
  }, []);
}

function _title(item: unknown): string | undefined {
  if (typeof item === "string" && item.length > 0) return item;

  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const v = obj.title ?? obj.text ?? obj.value ?? obj.query;
    if (typeof v === "string" && v.length > 0) return v;
  }

  return undefined;
}

function _toArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["results", "items", "suggestions", "data"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }

  return [];
}

/* =========================
 * 公開API
 * ========================= */

export function getSuggest(q: string): Promise<SuggestResult> {
  if (!q.trim()) {
    return Promise.resolve({ ok: true, query: q, items: [] });
  }

  if (getIsLowMemory()) {
    const half = Math.ceil(SUGGEST_CACHE_MAX / 2);

    while (_cache.size > half) {
      const first = _cache.keys().next().value;
      if (first !== undefined) _cache.delete(first);
      else break;
    }
  }

  return _fetchSuggest(q);
}

/* =========================
 * debounce
 * ========================= */

// delay ごとに getSuggest の debounce済み関数をキャッシュする
// コールバックは debounce の外で受け取ることで、関数の同一性を保ちフリーズを防ぐ
const _debouncedFetchers = new Map<
  number,
  ((q: string) => Promise<SuggestResult>) & {
    cancel: () => void;
    flush: () => Promise<SuggestResult> | undefined;
  }
>();

export function getSuggestDebounced(
  q: string,
  callback: (result: SuggestResult) => void,
  wait?: number
): void {
  const delay = wait ?? getConfig().SUGGEST_DEBOUNCE_MS;

  if (!_debouncedFetchers.has(delay)) {
    // getSuggest だけを debounce 化する（cb は外側で受け取る）
    // usePromise: true（デフォルト）で正しくオブジェクト形式で渡す
    _debouncedFetchers.set(
      delay,
      debounce(getSuggest, { delay, usePromise: true })
    );
  }

  const debouncedFetch = _debouncedFetchers.get(delay)!;

  // debounce が返す Promise に対してコールバックを接続する
  // 古い呼び出しのコールバックは新しい呼び出しで上書きされるため競合しない
  const result = debouncedFetch(q);
  if (result) {
    result
      .then(callback)
      .catch(() =>
        callback({
          ok: false,
          query: q,
          items: [],
          error: "unknown",
        })
      );
  }
}
