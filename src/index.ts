// src/index.ts
import { configure, getConfig, type Config } from "./config.js";
import { store as memStore, clearStore, evictExpired, trimToHalf } from "./cache/memory.js";
import { getCacheKey, get as memGet, set as memSet } from "./cache/memory.js";
import { getP, setP, cleanup, destroyDB } from "./cache/persistent.js";
import { initMemoryMonitor, getIsLowMemory, getIsCriticalMemory, getCurrentCacheMax, destroyMemoryMonitor } from "./memory.js";
import { enqueue, Priority, clearQueues, type PriorityValue } from "./request/queue.js";
import { fetchWithRetry, cancel as cancelRequest, cancelAll, type FetchResult } from "./request/retry.js";
import { debounce } from "./utils.js";
import {
  extractMeta, extractDetail,
  type ResultMeta, type ResultDetail, type ParsedResponse,
} from "./parser.js";
import {
  getSuggest as _getSuggest,
  getSuggestDebounced,
  createSuggestDebouncer,
  clearSuggestCache,
  clearSuggestDebouncers,
  type SuggestItem,
  type SuggestResult,
  type SuggestDebouncer,
} from "./suggest.js";
import { on, off, emit, clearAllListeners, type SearchEventMap } from "./events.js";
import { addHistory, getHistory, removeHistory, clearHistory, mergeWithHistory, type HistoryEntry } from "./history.js";
import { initOfflineMonitor, destroyOfflineMonitor, getIsOnline, addRetryTask } from "./offline.js";

export {
  configure, debounce,
  cancelRequest, cancelAll,
  getSuggestDebounced,
  createSuggestDebouncer,
  on, off,
  addHistory, getHistory, removeHistory, clearHistory, mergeWithHistory,
  getIsOnline,
};
export type {
  Config, FetchResult,
  ResultMeta, ResultDetail, ParsedResponse,
  SuggestItem, SuggestResult, SuggestDebouncer,
  SearchEventMap, HistoryEntry,
};

export type SearchType = "web" | "image" | "video" | "news" | "panel";

const HEAVY_TYPES: ReadonlySet<SearchType> = new Set(["image", "video"]);

export interface SearchOptions {
  /** 検索クエリ */
  q: string;
  /** ページ番号 (デフォルト: 1) */
  page?: number;
  /** 検索タイプ (デフォルト: "web") */
  type?: SearchType;
  safesearch?: 0 | 1 | 2;
  lang?: string;
  enableStreaming?: boolean;
  onChunk?: (chunk: unknown) => void;
  usePersistentCache?: boolean;
  /** true の場合メタ情報のみを返す (軽量モード) */
  metaOnly?: boolean;
  signal?: AbortSignal;
}

export interface RequestOptions {
  useCache?: boolean;
  priority?: PriorityValue;
  onChunk?: ((chunk: unknown) => void) | null;
  usePersistentCache?: boolean;
  signal?: AbortSignal;
}

export interface SearchStats {
  memoryCacheSize: number;
  memoryCacheMax: number;
  isLowMemory: boolean;
  isCriticalMemory: boolean;
  inFlightCount: number;
  isOnline: boolean;
}

/** 現在のキャッシュ・メモリ・ネットワーク状態を返す。デバッグ用途。 */
export function getSearchStats(): SearchStats {
  return {
    memoryCacheSize:  memStore.size,
    memoryCacheMax:   getCurrentCacheMax(),
    isLowMemory:      getIsLowMemory(),
    isCriticalMemory: getIsCriticalMemory(),
    inFlightCount:    inFlight.size,
    isOnline:         getIsOnline(),
  };
}

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;
let _destroyed = false;

/**
 * ライブラリを初期化する。アプリ起動時に一度だけ呼ぶこと。
 * @param options - Config の部分的な上書き設定
 */
export function init(options: Partial<Config> = {}): void {
  _destroyed = false;
  configure(options);
  initMemoryMonitor(memStore);
  initOfflineMonitor();
  if (_cleanupTimer !== null) clearInterval(_cleanupTimer);
  _cleanupTimer = setInterval(cleanup, getConfig().PERSISTENT_CLEANUP_INTERVAL);
}

/**
 * ライブラリのリソースを全て解放する。
 * 再利用する場合は init() を再度呼ぶこと。
 */
export async function destroy(): Promise<void> {
  _destroyed = true;
  cancelAll();
  clearQueues();
  inFlight.clear();
  clearStore();
  clearSuggestCache();
  clearSuggestDebouncers();
  clearAllListeners();
  destroyOfflineMonitor();
  await destroyDB();
  destroyMemoryMonitor();
  if (_cleanupTimer !== null) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

const inFlight = new Map<string, Promise<FetchResult>>();

function _requestKey(endpoint: string, params: Record<string, unknown>): string {
  const p = params as { q?: string; page?: number; type?: string };
  return endpoint + "\x00" + (p.q ?? "") + "\x00" + (p.page ?? 1) + "\x00" + (p.type ?? "web");
}

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
  const cfg    = getConfig();
  const lowMem = getIsLowMemory();
  const offline = !getIsOnline();

  if (getIsCriticalMemory()) { evictExpired(); trimToHalf(); }
  else if (lowMem) { evictExpired(); }

  const url = new URL(cfg.API_BASE + endpoint);
  for (const k in params) {
    const v = params[k];
    if (v != null) url.searchParams.append(k, String(v));
  }

  const cacheKey = getCacheKey(endpoint, params);
  const reqKey   = _requestKey(endpoint, params);

  if (useCache) {
    const hit = memGet(cacheKey);
    if (hit) {
      if (hit.expired && !lowMem && !offline) {
        enqueue(async () => {
          if (_destroyed) return;
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

  if (offline) return { ok: false, error: "offline" };
  if (signal?.aborted) return { ok: false, error: "cancelled" };

  const existing = inFlight.get(reqKey);
  if (existing) return existing;

  const fetchOpts: RequestInit = signal ? { ..._fetchOpts, signal } : _fetchOpts;

  const promise = new Promise<FetchResult>((resolve) => {
    // [FREEZE fix] onAbort 経由で resolve した場合も必ず inFlight から削除する。
    // 旧実装では finally で削除していたが、onAbort パスは enqueue コールバックの
    // 外側で resolve するため finally が実行されず inFlight に残骸が残っていた。
    let settled = false;
    const _settle = (result: FetchResult): void => {
      if (settled) return;
      settled = true;
      inFlight.delete(reqKey);
      resolve(result);
    };

    const onAbort = (): void => _settle({ ok: false, error: "cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });

    enqueue(async () => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { _settle({ ok: false, error: "cancelled" }); return; }
      try {
        const result = await fetchWithRetry(url.toString(), fetchOpts, reqKey, onChunk ?? undefined);
        if (result.ok && useCache && !result.streamed) {
          if (!lowMem) memSet(cacheKey, result.data);
          if (usePersistentCache) await setP(cacheKey, result.data);
        }
        if (!result.ok && result.error === "network_error") {
          addRetryTask(async () => {
            const r = await fetchWithRetry(url.toString(), _fetchOpts, reqKey);
            if (r.ok) {
              if (!lowMem) memSet(cacheKey, r.data);
              if (usePersistentCache) await setP(cacheKey, r.data);
            }
          });
        }
        _settle(result);
      } catch (e) {
        _settle({ ok: false, error: e instanceof Error ? e.message : "unknown_error" });
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

/**
 * 検索を実行する。キャッシュがある場合はキャッシュを返しつつバックグラウンドで更新する。
 */
export async function search({
  q, page = 1, type = "web", safesearch = 0, lang = "ja",
  enableStreaming = false, onChunk, usePersistentCache = false, metaOnly = false, signal,
}: SearchOptions): Promise<FetchResult> {
  if (!q?.trim()) return { ok: false, error: "empty_query" };
  const lowMem     = getIsLowMemory();
  const isHeavy    = HEAVY_TYPES.has(type);
  const forceStream = isHeavy && lowMem;
  const params = { q: q.trim(), page, type, safesearch, lang };
  if (page < 10 && !lowMem) _prefetch("/search", { ...params, page: page + 1 });
  if (forceStream || (enableStreaming && onChunk)) {
    return request("/search", params, { priority: Priority.NORMAL, onChunk: onChunk ?? undefined, usePersistentCache, signal });
  }
  const result = await request("/search", params, { priority: Priority.NORMAL, onChunk: null, usePersistentCache, signal });
  if (!result.ok) return result;
  if (isHeavy || metaOnly || lowMem) {
    return { ...result, data: extractMeta(result.data, type, lowMem) };
  }
  return result;
}

/** メタ情報のみを取得する軽量版 search。 */
export function searchMeta(opts: Omit<SearchOptions, "metaOnly" | "enableStreaming" | "onChunk">): Promise<FetchResult> {
  return search({ ...opts, metaOnly: true });
}

/** キャッシュから指定インデックスの詳細情報を取得する。キャッシュがなければリクエストする。 */
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
  const result = await request("/search", params, { priority: Priority.NORMAL, usePersistentCache });
  return result.ok ? extractDetail(result.data, idx) : null;
}

/** サジェストを取得する。 */
export function getSuggest(q: string): Promise<SuggestResult> { return _getSuggest(q); }

export interface Pager {
  next(): Promise<FetchResult | null>;
  prev(): Promise<FetchResult | null>;
  readonly currentPage: number;
  reset(): void;
}

/**
 * ページネーション用のページャーを生成する。
 * @param opts - SearchOptions から page を除いたオプション
 * @param maxPage - 最大ページ数 (デフォルト: 10)
 */
export function createPager(opts: Omit<SearchOptions, "page">, maxPage = 10): Pager {
  let _page = 0;
  return {
    get currentPage() { return _page; },
    async next() { if (_page >= maxPage) return null; _page++; return search({ ...opts, page: _page }); },
    async prev() { if (_page <= 1) return null; _page--; return search({ ...opts, page: _page }); },
    reset() { _page = 0; },
  };
}

export type SearchAllResult = Partial<Record<SearchType, FetchResult>>;

/**
 * 複数の検索タイプを並行して実行する。
 * @param opts - 共通の SearchOptions
 * @param types - 実行するタイプ一覧 (デフォルト: ["web", "news"])
 */
export async function searchAll(
  opts: Omit<SearchOptions, "type">,
  types: SearchType[] = ["web", "news"]
): Promise<SearchAllResult> {
  const entries = await Promise.allSettled(types.map((type) => search({ ...opts, type })));
  const result: SearchAllResult = {};
  for (let i = 0; i < types.length; i++) {
    const s = entries[i];
    if (s.status === "fulfilled" && s.value.ok) result[types[i]] = s.value;
  }
  return result;
}

/** Web 検索のショートハンド */
export const searchWeb   = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "web",   signal });
/** 画像検索のショートハンド */
export const searchImage = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "image", signal });
/** 動画検索のショートハンド */
export const searchVideo = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "video", signal });
/** ニュース検索のショートハンド */
export const searchNews  = (q: string, page = 1, signal?: AbortSignal): Promise<FetchResult> => search({ q, page, type: "news",  signal });
/** パネル検索のショートハンド */
export const searchPanel = (q: string,            signal?: AbortSignal): Promise<FetchResult> => search({ q,       type: "panel", signal });
