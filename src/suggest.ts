// src/suggest.ts
import { getConfig } from "./config.js";
import { getIsLowMemory } from "./memory.js";
import { fetchWithRetry, type FetchResult } from "./request/retry.js";
import { enqueue, Priority } from "./request/queue.js";

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
  _cache.delete(key);
  _cache.set(key, entry);
  return entry;
}

function _cacheSet(key: string, items: SuggestItem[]): void {
  if (_cache.has(key)) _cache.delete(key);
  while (_cache.size >= SUGGEST_CACHE_MAX) {
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first as string);
    else break;
  }
  _cache.set(key, { items, time: Date.now() });
}

function _cacheFindPrefix(q: string): SuggestCacheEntry | null {
  const key = _cacheKey(q);
  const exact = _cacheGet(key);
  if (exact) return exact;

  const now = Date.now();
  const ttl = getConfig().SUGGEST_TTL;
  const expired: string[] = [];

  for (const [k, entry] of _cache) {
    if (now - entry.time > ttl) { expired.push(k); continue; }
    if (key.startsWith(k)) {
      const filtered = entry.items.filter((item) => item.lower.includes(key));
      if (filtered.length > 0) {
        for (const ek of expired) _cache.delete(ek);
        _cache.delete(k);
        _cache.set(k, { items: entry.items, time: entry.time });
        return { items: filtered, time: entry.time };
      }
    }
  }
  for (const ek of expired) _cache.delete(ek);
  return null;
}

/** サジェストキャッシュを全削除する。 */
export function clearSuggestCache(): void {
  _cache.clear();
}

const _inFlight = new Map<string, Promise<SuggestResult>>();

const _fetchOpts: RequestInit = Object.freeze({
  method: "GET",
  headers: Object.freeze({ Accept: "application/json" }),
});

async function _fetchSuggest(q: string): Promise<SuggestResult> {
  const key = _cacheKey(q);

  const cached = _cacheFindPrefix(q);
  if (cached) return { ok: true, query: q, items: cached.items, cached: true };

  const existing = _inFlight.get(key);
  if (existing) return existing;

  const cfg = getConfig();
  const url = new URL(cfg.API_BASE + "/search");
  url.searchParams.set("q", q.trim());
  url.searchParams.set("type", "suggest");

  const promise = new Promise<SuggestResult>((resolve) => {
    let resolved = false;

    const _resolve = (result: SuggestResult): void => {
      if (resolved) return;
      resolved = true;
      _inFlight.delete(key);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      _resolve({ ok: false, query: q, items: [], error: "timeout" });
    }, 5000);

    enqueue(async () => {
      if (resolved) { clearTimeout(timeout); return; }
      try {
        const result: FetchResult = await fetchWithRetry(
          url.toString(),
          _fetchOpts,
          "suggest\x00" + key
        );
        if (!result.ok) {
          _resolve({ ok: false, query: q, items: [], error: result.error });
          return;
        }
        const items = _parse(result.data);
        _cacheSet(key, items);
        _resolve({ ok: true, query: q, items });
      } catch {
        _resolve({ ok: false, query: q, items: [], error: "unknown_error" });
      } finally {
        clearTimeout(timeout);
      }
    }, Priority.HIGH);
  });

  _inFlight.set(key, promise);
  return promise;
}

function _parse(data: unknown): SuggestItem[] {
  return _toArray(data).reduce<SuggestItem[]>((acc, item) => {
    const title = _title(item);
    if (title) acc.push({ title, lower: title.toLowerCase() });
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

/** サジェストを取得する。低メモリ時はキャッシュを半分に削減してから取得する。 */
export function getSuggest(q: string): Promise<SuggestResult> {
  if (!q.trim()) return Promise.resolve({ ok: true, query: q, items: [] });
  if (getIsLowMemory()) {
    const half = Math.ceil(SUGGEST_CACHE_MAX / 2);
    while (_cache.size > half) {
      const first = _cache.keys().next().value;
      if (first !== undefined) _cache.delete(first as string);
      else break;
    }
  }
  return _fetchSuggest(q);
}

/* =========================
 * createSuggestDebouncer
 *
 * 呼び出しごとに独立したタイマー状態を持つクロージャを返す。
 * コンポーネントごとに debouncer を作成し、unmount 時に cancel() を呼ぶだけでよい。
 *
 * 使い方 (React):
 *   const debouncer = useMemo(() => createSuggestDebouncer(), []);
 *   useEffect(() => () => debouncer.cancel(), [debouncer]);
 *   // 入力時: debouncer.fetch(q, setSuggestions);
 * ========================= */

export interface SuggestDebouncer {
  /** クエリを debounce して getSuggest を呼び出し、結果を callback に渡す。 */
  fetch(q: string, callback: (result: SuggestResult) => void): void;
  /** 保留中のタイマーをキャンセルする。 */
  cancel(): void;
}

/**
 * コンポーネントごとに独立した SuggestDebouncer を生成する。
 * @param wait - デバウンス待機時間(ms)。省略時は config の SUGGEST_DEBOUNCE_MS を使用。
 */
export function createSuggestDebouncer(wait?: number): SuggestDebouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    fetch(q: string, callback: (result: SuggestResult) => void): void {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }

      if (!q.trim()) {
        callback({ ok: true, query: q, items: [] });
        return;
      }

      const delay = wait ?? getConfig().SUGGEST_DEBOUNCE_MS;
      timer = setTimeout(() => {
        timer = undefined;
        getSuggest(q)
          .then(callback)
          .catch(() => callback({ ok: false, query: q, items: [], error: "unknown" }));
      }, delay);
    },
    cancel(): void {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    },
  };
}

/* =========================
 * getSuggestDebounced (後方互換 API)
 *
 * グローバルな debouncer を delay ごとに1つ保持する。
 * 単一コンポーネントでの使用に限り後方互換を維持。
 * 複数コンポーネントで使う場合は createSuggestDebouncer() を使うこと。
 * ========================= */
// [QUALITY fix] Map のキーは整数に統一。float の delay が来ても同一 debouncer を再利用できる。
const _globalDebouncers = new Map<number, SuggestDebouncer>();

/**
 * グローバルな debouncer を使ってサジェストを取得する(後方互換)。
 * 戻り値のキャンセル関数を useEffect の return に渡すことで cleanup できる。
 */
export function getSuggestDebounced(
  q: string,
  callback: (result: SuggestResult) => void,
  wait?: number
): () => void {
  // [QUALITY fix] Math.floor で整数キーに正規化し、float 値による重複 debouncer を防ぐ
  const delay = Math.floor(wait ?? getConfig().SUGGEST_DEBOUNCE_MS);

  let debouncer = _globalDebouncers.get(delay);
  if (!debouncer) {
    debouncer = createSuggestDebouncer(delay);
    _globalDebouncers.set(delay, debouncer);
  }

  debouncer.fetch(q, callback);

  return () => debouncer!.cancel();
}

/** 全グローバル debouncer をキャンセルして破棄する。destroy() から呼ぶこと。 */
export function clearSuggestDebouncers(): void {
  for (const d of _globalDebouncers.values()) d.cancel();
  _globalDebouncers.clear();
}
