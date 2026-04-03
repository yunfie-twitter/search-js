// src/index.ts
import { configure, getConfig, type Config } from "./config.ts";
import { store as memStore, clearStore, evictExpired, trimToHalf } from "./cache/memory.ts";
import { getCacheKey, get as memGet, set as memSet } from "./cache/memory.ts";
import { getP, setP, cleanup, destroyDB } from "./cache/persistent.ts";
import { initMemoryMonitor, getIsLowMemory, getIsCriticalMemory, destroyMemoryMonitor } from "./memory.ts";
import { enqueue, Priority, clearQueues, type PriorityValue } from "./request/queue.ts";
import { fetchWithRetry, cancel as cancelRequest, cancelAll, type FetchResult } from "./request/retry.ts";
import { debounce } from "./utils.ts";
import {
  extractMeta, extractDetail, chunkToMeta,
  type ResultMeta, type ResultDetail, type ParsedResponse,
} from "./parser.ts";
import {
  getSuggest as _getSuggest,
  getSuggestDebounced,
  clearSuggestCache,
  type SuggestItem,
  type SuggestResult,
} from "./suggest.ts";

export { configure, debounce, cancelRequest, cancelAll, getSuggestDebounced };
export type { Config, FetchResult, ResultMeta, ResultDetail, ParsedResponse, SuggestItem, SuggestResult };

// ---- 型定義 -------------------------------------------------------

export type SearchType = "web" | "image" | "video" | "news" | "panel";
// ※ suggest は SearchType から除外。専用 API (getSuggest) を使う。

const HEAVY_TYPES: ReadonlySet<SearchType> = new Set(["image", "video"]);

export interface SearchOptions {
  q: string;
  page?: number;
  type?: SearchType;
  safesearch?: 0 | 1 | 2;
  lang?: string;
  enableStreaming?: boolean;
  onChunk?: (chunk: unknown) => void;
  usePersistentCache?: boolean;
  metaOnly?: boolean;
}

export interface RequestOptions {
  useCache?: boolean;
  priority?: PriorityValue;
  onChunk?: ((chunk: unknown) => void) | null;
  usePersistentCache?: boolean;
}

// ---- 初期化・破棄 ---------------------------------------------------

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function init(options: Partial<Config> = {}): void {
  configure(options);
  initMemoryMonitor(memStore);
  if (_cleanupTimer !== null) clearInterval(_cleanupTimer);
  _cleanupTimer = setInterval(cleanup, getConfig().PERSISTENT_CLEANUP_INTERVAL);
}

export async function destroy(): Promise<void> {
  cancelAll();
  clearQueues();
  inFlight.clear();
  clearStore();
  clearSuggestCache();
  await destroyDB();
  destroyMemoryMonitor();
  if (_cleanupTimer !== null) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ---- In-flight 重複排除 -----------------------------------------------

const inFlight = new Map<string, Promise<FetchResult>>();

function _requestKey(endpoint: string, params: Record<string, unknown>): string {
  const p = params as { q?: string; page?: number; type?: string };
  return endpoint + "\x00" + (p.q ?? "") + "\x00" + (p.page ?? 1) + "\x00" + (p.type ?? "web");
}

// ---- 内部 request() --------------------------------------------------

async function request(
  endpoint: string,
  params: Record<string, unknown> = {},
  {
    useCache = true,
    priority = Priority.NORMAL,
    onChunk,
    usePersistentCache = false,
  }: RequestOptions = {}
): Promise<FetchResult> {
  const cfg = getConfig();
  const lowMem = getIsLowMemory();

  if (getIsCriticalMemory()) {
    evictExpired();
    trimToHalf();
  } else if (lowMem) {
    evictExpired();
  }

  const url = new URL(cfg.API_BASE + endpoint);
  const sp = url.searchParams;
  for (const k in params) {
    const v = params[k];
    if (v != null) sp.append(k, String(v));
  }

  const cacheKey = getCacheKey(endpoint, params);
  const reqKey   = _requestKey(endpoint, params);

  if (useCache) {
    const hit = memGet(cacheKey);
    if (hit) {
      if (hit.expired && !lowMem) {
        enqueue(async () => {
          const r = await fetchWithRetry(url.toString(), _fetchOpts, reqKey);
          if (r.ok) {
            memSet(cacheKey, r.data);
            if (usePersistentCache) await setP(cacheKey, r.data);
          }
        }, priority);
      }
      return { ok: true, data: hit.data, cached: true, stale: hit.expired };
    }

    if (usePersistentCache) {
      const pData = await getP(cacheKey);
      if (pData) {
        if (!lowMem) memSet(cacheKey, pData);
        return { ok: true, data: pData, cached: true, persistent: true };
      }
    }
  }

  const existing = inFlight.get(reqKey);
  if (existing) return existing;

  const promise = new Promise<FetchResult>((resolve, reject) => {
    enqueue(async () => {
      try {
        const result = await fetchWithRetry(
          url.toString(),
          _fetchOpts,
          reqKey,
          onChunk ?? undefined
        );
        if (result.ok && useCache && !result.streamed) {
          if (!lowMem) memSet(cacheKey, result.data);
          if (usePersistentCache) await setP(cacheKey, result.data);
        }
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        inFlight.delete(reqKey);
      }
    }, priority);
  });

  inFlight.set(reqKey, promise);
  return promise;
}

const _fetchOpts: RequestInit = Object.freeze({
  method: "GET",
  headers: Object.freeze({ Accept: "application/json" }),
});

function _prefetch(endpoint: string, params: Record<string, unknown>): void {
  if (getIsLowMemory()) return;
  const cacheKey = getCacheKey(endpoint, params);
  const hit = memGet(cacheKey);
  if (hit && !hit.expired) return;
  if (inFlight.has(_requestKey(endpoint, params))) return;
  request(endpoint, params, { priority: Priority.LOW }).catch(() => {});
}

// ---- パブリック API ─────────────────────────────────────

export async function search({
  q,
  page = 1,
  type = "web",
  safesearch = 0,
  lang = "ja",
  enableStreaming = false,
  onChunk,
  usePersistentCache = false,
  metaOnly = false,
}: SearchOptions): Promise<FetchResult> {
  if (!q?.trim()) return { ok: false, error: "empty_query" };

  const lowMem  = getIsLowMemory();
  const isHeavy = HEAVY_TYPES.has(type);
  const forceStream = isHeavy && lowMem;

  const params = { q: q.trim(), page, type, safesearch, lang };

  if (page < 10 && !lowMem) {
    _prefetch("/search", { ...params, page: page + 1 });
  }

  if (forceStream || (enableStreaming && onChunk)) {
    return request("/search", params, {
      priority: Priority.NORMAL,
      onChunk: onChunk ?? undefined,
      usePersistentCache,
    });
  }

  const result = await request("/search", params, {
    priority: Priority.NORMAL,
    onChunk: null,
    usePersistentCache,
  });

  if (!result.ok) return result;

  const shouldExtractMeta = isHeavy || metaOnly || lowMem;
  if (shouldExtractMeta) {
    const meta = extractMeta(result.data, type, lowMem);
    return { ...result, data: meta };
  }

  return result;
}

/**
 * メタ情報のみを先に取得。
 */
export function searchMeta(
  opts: Omit<SearchOptions, "metaOnly" | "enableStreaming" | "onChunk">
): Promise<FetchResult> {
  return search({ ...opts, metaOnly: true });
}

/**
 * キャッシュから詳細データを取得する。
 */
export async function fetchDetail(
  opts: Omit<SearchOptions, "metaOnly" | "enableStreaming" | "onChunk">,
  idx: number
): Promise<ResultDetail | null> {
  const { q, page = 1, type = "web", safesearch = 0, lang = "ja", usePersistentCache = false } = opts;
  if (!q?.trim()) return null;

  const params   = { q: q.trim(), page, type, safesearch, lang };
  const cacheKey = getCacheKey("/search", params);

  const hit = memGet(cacheKey);
  if (hit) return extractDetail(hit.data, idx);

  if (usePersistentCache) {
    const pData = await getP(cacheKey);
    if (pData) return extractDetail(pData, idx);
  }

  const result = await request("/search", params, {
    priority: Priority.NORMAL,
    usePersistentCache,
  });
  return result.ok ? extractDetail(result.data, idx) : null;
}

/**
 * サジェスト取得（即座式）。
 * 入力イベントで連打ちされる場合は getSuggestDebounced を使う。
 */
export function getSuggest(q: string): Promise<SuggestResult> {
  return _getSuggest(q);
}

// ---- タイプ別ショートハンド -------------------------------------------

export const searchWeb   = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "web" });
export const searchImage = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "image" });
export const searchVideo = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "video" });
export const searchNews  = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "news" });
export const searchPanel = (q: string): Promise<FetchResult>           => search({ q, type: "panel" });
