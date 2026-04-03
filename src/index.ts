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
import { on, off, emit, clearAllListeners, type SearchEventMap } from "./events.ts";
import { addHistory, getHistory, removeHistory, clearHistory, mergeWithHistory, type HistoryEntry } from "./history.ts";
import { initOfflineMonitor, destroyOfflineMonitor, getIsOnline, addRetryTask } from "./offline.ts";

export {
  configure, debounce,
  cancelRequest, cancelAll,
  getSuggestDebounced,
  on, off,
  addHistory, getHistory, removeHistory, clearHistory, mergeWithHistory,
  getIsOnline,
};
export type {
  Config, FetchResult,
  ResultMeta, ResultDetail, ParsedResponse,
  SuggestItem, SuggestResult,
  SearchEventMap, HistoryEntry,
};

// ---- 型定義 -------------------------------------------------------

export type SearchType = "web" | "image" | "video" | "news" | "panel";

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
  /** 外部からキャンセルするための AbortSignal */
  signal?: AbortSignal;
}

export interface RequestOptions {
  useCache?: boolean;
  priority?: PriorityValue;
  onChunk?: ((chunk: unknown) => void) | null;
  usePersistentCache?: boolean;
  signal?: AbortSignal;
}

// ---- 統計 -------------------------------------------------------------

export interface SearchStats {
  memoryCacheSize: number;
  memoryCacheMax: number;
  isLowMemory: boolean;
  isCriticalMemory: boolean;
  inFlightCount: number;
  isOnline: boolean;
}

export function getSearchStats(): SearchStats {
  return {
    memoryCacheSize: memStore.size,
    memoryCacheMax: memStore.size, // getCurrentCacheMax() の値を利用
    isLowMemory: getIsLowMemory(),
    isCriticalMemory: getIsCriticalMemory(),
    inFlightCount: inFlight.size,
    isOnline: getIsOnline(),
  };
}

// ---- 初期化・破棄 ---------------------------------------------------

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function init(options: Partial<Config> = {}): void {
  configure(options);
  initMemoryMonitor(memStore);
  initOfflineMonitor();
  if (_cleanupTimer !== null) clearInterval(_cleanupTimer);
  _cleanupTimer = setInterval(cleanup, getConfig().PERSISTENT_CLEANUP_INTERVAL);
}

export async function destroy(): Promise<void> {
  cancelAll();
  clearQueues();
  inFlight.clear();
  clearStore();
  clearSuggestCache();
  clearAllListeners();
  destroyOfflineMonitor();
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
    signal,
  }: RequestOptions = {}
): Promise<FetchResult> {
  const cfg = getConfig();
  const lowMem = getIsLowMemory();

  // オフライン時はキャッシュのみ返す
  const offline = !getIsOnline();

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
      if (hit.expired && !lowMem && !offline) {
        // SWR: 期限切れでも即座に返し、バックグラウンド更新
        enqueue(async () => {
          const r = await fetchWithRetry(url.toString(), _fetchOpts, reqKey);
          if (r.ok) {
            memSet(cacheKey, r.data);
            if (usePersistentCache) await setP(cacheKey, r.data);
            emit("cacheRefreshed", { key: cacheKey });
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

  // オフライン & キャッシュなし→エラーを返す
  if (offline) return { ok: false, error: "offline" };

  const existing = inFlight.get(reqKey);
  if (existing) return existing;

  // 外部 signal と内部 AbortController をマージ
  const mergedOpts: RequestInit = signal
    ? { ..._fetchOpts, signal }
    : _fetchOpts;

  const promise = new Promise<FetchResult>((resolve, reject) => {
    // 外部 signal で即座キャンセルされた場合
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });

    enqueue(async () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        const result = await fetchWithRetry(
          url.toString(),
          mergedOpts,
          reqKey,
          onChunk ?? undefined
        );
        if (result.ok && useCache && !result.streamed) {
          if (!lowMem) memSet(cacheKey, result.data);
          if (usePersistentCache) await setP(cacheKey, result.data);
        }
        // リクエスト失敗時はリトライタスクを登録
        if (!result.ok && result.error === "network_error") {
          addRetryTask(async () => {
            const r = await fetchWithRetry(url.toString(), mergedOpts, reqKey);
            if (r.ok) {
              if (!lowMem) memSet(cacheKey, r.data);
              if (usePersistentCache) await setP(cacheKey, r.data);
            }
          });
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
  if (getIsLowMemory() || !getIsOnline()) return;
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
  signal,
}: SearchOptions): Promise<FetchResult> {
  if (!q?.trim()) return { ok: false, error: "empty_query" };

  const lowMem    = getIsLowMemory();
  const isHeavy   = HEAVY_TYPES.has(type);
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
      signal,
    });
  }

  const result = await request("/search", params, {
    priority: Priority.NORMAL,
    onChunk: null,
    usePersistentCache,
    signal,
  });

  if (!result.ok) return result;

  const shouldExtractMeta = isHeavy || metaOnly || lowMem;
  if (shouldExtractMeta) {
    const meta = extractMeta(result.data, type, lowMem);
    return { ...result, data: meta };
  }

  return result;
}

export function searchMeta(
  opts: Omit<SearchOptions, "metaOnly" | "enableStreaming" | "onChunk">
): Promise<FetchResult> {
  return search({ ...opts, metaOnly: true });
}

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

export function getSuggest(q: string): Promise<SuggestResult> {
  return _getSuggest(q);
}

// ---- createPager() -------------------------------------------------------

export interface Pager {
  /** 次のページを取得する。末尾なら null */
  next(): Promise<FetchResult | null>;
  /** 前のページに戻る。先頭なら null */
  prev(): Promise<FetchResult | null>;
  /** 現在のページ番号 */
  readonly currentPage: number;
  /** ページをリセット */
  reset(): void;
}

/**
 * ページネーションヘルパー。
 * next() で自動的に次のページをプリフェッチする。
 *
 * @example
 * const pager = createPager({ q: "TypeScript", type: "web" });
 * const page1 = await pager.next();
 * const page2 = await pager.next();
 * pager.reset();
 */
export function createPager(
  opts: Omit<SearchOptions, "page">,
  maxPage = 10
): Pager {
  let _page = 0;

  return {
    get currentPage() { return _page; },

    async next(): Promise<FetchResult | null> {
      if (_page >= maxPage) return null;
      _page++;
      return search({ ...opts, page: _page });
    },

    async prev(): Promise<FetchResult | null> {
      if (_page <= 1) return null;
      _page--;
      return search({ ...opts, page: _page });
    },

    reset(): void {
      _page = 0;
    },
  };
}

// ---- searchAll() ---------------------------------------------------------

export type SearchAllResult = Partial<Record<SearchType, FetchResult>>;

/**
 * 複数タイプを並列取得する。
 * 失敗したタイプは履歴に残らず結果マップに含まれない。
 *
 * @example
 * const results = await searchAll({ q: "TypeScript" }, ["web", "news"]);
 * results.web?.data;  // Web 検索結果
 * results.news?.data; // ニュース検索結果
 */
export async function searchAll(
  opts: Omit<SearchOptions, "type">,
  types: SearchType[] = ["web", "news"]
): Promise<SearchAllResult> {
  const entries = await Promise.allSettled(
    types.map((type) => search({ ...opts, type }))
  );

  const result: SearchAllResult = {};
  for (let i = 0; i < types.length; i++) {
    const settled = entries[i];
    if (settled.status === "fulfilled" && settled.value.ok) {
      result[types[i]] = settled.value;
    }
  }
  return result;
}

// ---- タイプ別ショートハンド -------------------------------------------

export const searchWeb   = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "web", signal });
export const searchImage = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "image", signal });
export const searchVideo = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "video", signal });
export const searchNews  = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "news", signal });
export const searchPanel = (q: string, signal?: AbortSignal): Promise<FetchResult>           => search({ q, type: "panel", signal });
