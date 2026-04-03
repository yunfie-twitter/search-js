// src/suggest.ts
import { getConfig } from "./config.js";
import { getIsLowMemory } from "./memory.js";
import { fetchWithRetry, type FetchResult } from "./request/retry.js";
import { enqueue, Priority } from "./request/queue.js";
import { debounce } from "./utils.js";

export interface SuggestItem { title: string; }

export interface SuggestResult {
  ok: boolean;
  query: string;
  items: SuggestItem[];
  cached?: boolean;
  error?: string;
}

interface SuggestCacheEntry { items: SuggestItem[]; time: number; }

const _cache = new Map<string, SuggestCacheEntry>();
const SUGGEST_CACHE_MAX = 50;

function _cacheKey(q: string): string { return q.trim().toLowerCase(); }

function _cacheGet(key: string): SuggestCacheEntry | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > getConfig().SUGGEST_TTL) { _cache.delete(key); return null; }
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
  for (const [k, entry] of _cache) {
    if (now - entry.time > ttl) { _cache.delete(k); continue; }
    if (key.startsWith(k)) {
      _cache.delete(k);
      _cache.set(k, entry);
      const filtered = entry.items.filter((item) => item.title.toLowerCase().includes(key));
      if (filtered.length > 0) return { items: filtered, time: entry.time };
    }
  }
  return null;
}

export function clearSuggestCache(): void { _cache.clear(); }

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
    enqueue(async () => {
      try {
        const result: FetchResult = await fetchWithRetry(
          url.toString(), _fetchOpts, "suggest\x00" + key
        );
        if (!result.ok) { resolve({ ok: false, query: q, items: [], error: result.error }); return; }
        const items = _parse(result.data);
        _cacheSet(key, items);
        resolve({ ok: true, query: q, items });
      } catch {
        resolve({ ok: false, query: q, items: [], error: "unknown_error" });
      } finally {
        _inFlight.delete(key);
      }
    }, Priority.HIGH);
  });

  _inFlight.set(key, promise);
  return promise;
}

function _parse(data: unknown): SuggestItem[] {
  return _toArray(data).reduce<SuggestItem[]>((acc, item) => {
    const title = _title(item);
    if (title) acc.push({ title });
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

export function getSuggestDebounced(
  q: string,
  callback: (result: SuggestResult) => void,
  wait?: number
): void {
  _debouncedInner(q, callback, wait ?? getConfig().SUGGEST_DEBOUNCE_MS);
}

const _debouncedFns = new Map<number, (q: string, cb: (r: SuggestResult) => void) => void>();

function _debouncedInner(
  q: string,
  callback: (result: SuggestResult) => void,
  wait: number
): void {
  if (!_debouncedFns.has(wait)) {
    // debounce に渡すラッパーを明示的に unknown[] 型にする
    const fn = (innerQ: unknown, cb: unknown): void => {
      getSuggest(innerQ as string)
        .then(cb as (r: SuggestResult) => void)
        .catch(() => (cb as (r: SuggestResult) => void)({ ok: false, query: innerQ as string, items: [], error: "unknown" }));
    };
    _debouncedFns.set(wait, debounce(fn, { delay: wait, usePromise: false }) as unknown as
      (q: string, cb: (r: SuggestResult) => void) => void);
  }
  _debouncedFns.get(wait)!(q, callback);
}
