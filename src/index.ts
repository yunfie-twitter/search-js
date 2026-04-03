// src/index.ts
import { configure, getConfig, type Config } from "./config.ts";
import { store as memStore, clearStore } from "./cache/memory.ts";
import { getCacheKey, get as memGet, set as memSet } from "./cache/memory.ts";
import { getP, setP, cleanup, destroyDB } from "./cache/persistent.ts";
import { initMemoryMonitor, getIsLowMemory, destroyMemoryMonitor } from "./memory.ts";
import { enqueue, Priority, clearQueues, type PriorityValue } from "./request/queue.ts";
import { fetchWithRetry, cancel as cancelRequest, cancelAll, type FetchResult } from "./request/retry.ts";
import { debounce } from "./utils.ts";

export { configure, debounce, cancelRequest, cancelAll };
export type { Config, FetchResult };

export interface SearchOptions {
  q: string;
  page?: number;
  type?: "web" | "image" | "video" | "news" | "suggest" | "panel";
  safesearch?: 0 | 1 | 2;
  lang?: string;
  enableStreaming?: boolean;
  onChunk?: (chunk: unknown) => void;
  usePersistentCache?: boolean;
}

export interface RequestOptions {
  useCache?: boolean;
  priority?: PriorityValue;
  onChunk?: ((chunk: unknown) => void) | null;
  usePersistentCache?: boolean;
}

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

// In-flight deduplication
const inFlight = new Map<string, Promise<FetchResult>>();

// リクエストキー: 最小限の文字列連結でハッシュ計算コストを削減
function _requestKey(endpoint: string, params: Record<string, unknown>): string {
  const p = params as { q?: string; page?: number; type?: string };
  return endpoint + "\x00" + (p.q ?? "") + "\x00" + (p.page ?? 1) + "\x00" + (p.type ?? "web");
}

// URL 構築を高速化: entries() ループを減らし直接 append
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
  const url = new URL(cfg.API_BASE + endpoint);
  const sp = url.searchParams;
  for (const k in params) {
    const v = params[k];
    if (v != null) sp.append(k, String(v));
  }

  const cacheKey = getCacheKey(endpoint, params);
  const reqKey = _requestKey(endpoint, params);

  if (useCache) {
    const hit = memGet(cacheKey);
    if (hit) {
      if (hit.expired) {
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
        memSet(cacheKey, pData);
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
          memSet(cacheKey, result.data);
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

// 毎回オブジェクト生成しないよう定数として共有
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

export async function search({
  q,
  page = 1,
  type = "web",
  safesearch = 0,
  lang = "ja",
  enableStreaming = false,
  onChunk,
  usePersistentCache = false,
}: SearchOptions): Promise<FetchResult> {
  if (!q?.trim()) return { ok: false, error: "empty_query" };

  const params = { q: q.trim(), page, type, safesearch, lang };

  if (type !== "suggest" && page < 10 && !getIsLowMemory()) {
    _prefetch("/search", { ...params, page: page + 1 });
  }

  return request("/search", params, {
    priority: type === "suggest" ? Priority.HIGH : Priority.NORMAL,
    onChunk: enableStreaming && !getIsLowMemory() ? onChunk : null,
    usePersistentCache,
  });
}

export const searchWeb   = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "web" });
export const searchImage = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "image" });
export const searchVideo = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "video" });
export const searchNews  = (q: string, page = 1): Promise<FetchResult> => search({ q, page, type: "news" });
export const getSuggest  = (q: string): Promise<FetchResult>           => search({ q, type: "suggest" });
export const searchPanel = (q: string): Promise<FetchResult>           => search({ q, type: "panel" });
