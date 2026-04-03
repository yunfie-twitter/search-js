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

export { configure, debounce, cancelRequest, cancelAll };
export type { Config, FetchResult, ResultMeta, ResultDetail, ParsedResponse };

// ---- 型定義 -------------------------------------------------------

export type SearchType = "web" | "image" | "video" | "news" | "suggest" | "panel";

/** 大規模・高負荷型コンテンツ（ストリーミング優先） */
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
  /**
   * true のときメタ情報のみを返す。
   * summary などの重いフィールドは含まない、0.数秒でリスト描画できる。
   */
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

/**
 * 検索のメイン API。
 *
 * タイプ別の取得戦略:
 * - web / news : フル取得 → メモリキャッシュ。metaOnly 時は summary を除いたメタのみ返す。
 * - image/video : 大規模なのでメタのみ返す。詳細は fetchDetail() で取得。
 * - LowMemory   : HEAVY タイプはストリーミング強制、summary を筆頭に除外。
 */
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

  const lowMem    = getIsLowMemory();
  const isHeavy   = HEAVY_TYPES.has(type);
  const forceStream = isHeavy && lowMem;

  const params = { q: q.trim(), page, type, safesearch, lang };

  if (type !== "suggest" && page < 10 && !lowMem) {
    _prefetch("/search", { ...params, page: page + 1 });
  }

  // ---- ストリーミングモード (大規模 or 高負荷時に強制適用) ----
  if (forceStream || (enableStreaming && onChunk)) {
    const streamChunk = (chunk: unknown): void => {
      onChunk?.(chunk);
    };
    return request("/search", params, {
      priority: Priority.NORMAL,
      onChunk: streamChunk,
      usePersistentCache,
    });
  }

  // ---- 通常モード ----
  const result = await request("/search", params, {
    priority: type === "suggest" ? Priority.HIGH : Priority.NORMAL,
    onChunk: null,
    usePersistentCache,
  });

  if (!result.ok) return result;

  // 画像・動画は常に metaOnly（詳細は fetchDetail()）
  // web / news は metaOnly フラグ or LowMemory（summary を除外）のときのみ
  const shouldExtractMeta = isHeavy || metaOnly || lowMem;
  if (shouldExtractMeta) {
    const meta = extractMeta(result.data, type, lowMem);
    return { ...result, data: meta };
  }

  return result;
}

/**
 * メタ情報のみを先に取得するショートハンド。
 * リスト画面の高速初回描画に使う。
 *
 * @example
 * // Web: title, url, summary, favicon
 * const { data } = await searchMeta({ q: "TypeScript" });
 *
 * // Image: title, url, thumbnail, domain
 * const { data } = await searchMeta({ q: "cats", type: "image" });
 *
 * // LowMemory 時は summary を自動省略
 */
export function searchMeta(
  opts: Omit<SearchOptions, "metaOnly" | "enableStreaming" | "onChunk">
): Promise<FetchResult> {
  return search({ ...opts, metaOnly: true });
}

/**
 * キャッシュ済みデータから指定インデックスの詳細データを取得する。
 * 基本的にネットワークリクエストは発生しない（キャッシュがあれば）。
 *
 * @example
 * // ユーザーが結果をクリックしたとき
 * const detail = await fetchDetail({ q: "TypeScript", type: "web" }, 2);
 * // detail.summary, detail.favicon など全フィールドあり
 */
export async function fetchDetail(
  opts: Omit<SearchOptions, "metaOnly" | "enableStreaming" | "onChunk">,
  idx: number
): Promise<ResultDetail | null> {
  const { q, page = 1, type = "web", safesearch = 0, lang = "ja", usePersistentCache = false } = opts;
  if (!q?.trim()) return null;

  const params  = { q: q.trim(), page, type, safesearch, lang };
  const cacheKey = getCacheKey("/search", params);

  // 1. メモリキャッシュから
  const hit = memGet(cacheKey);
  if (hit) return extractDetail(hit.data, idx);

  // 2. 永続キャッシュから
  if (usePersistentCache) {
    const pData = await getP(cacheKey);
    if (pData) return extractDetail(pData, idx);
  }

  // 3. キャッシュなし → フル取得（不少ないケース）
  const result = await request("/search", params, {
    priority: Priority.NORMAL,
    usePersistentCache,
  });
  return result.ok ? extractDetail(result.data, idx) : null;
}

// ---- タイプ別ショートハンド -------------------------------------------

export const searchWeb   = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "web" });
export const searchImage = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "image" });
export const searchVideo = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "video" });
export const searchNews  = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "news" });
export const getSuggest  = (q: string): Promise<FetchResult>           => search({ q, type: "suggest" });
export const searchPanel = (q: string): Promise<FetchResult>           => search({ q, type: "panel" });
