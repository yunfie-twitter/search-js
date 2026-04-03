// src/index.ts
import { configure, getConfig, type Config } from "./config.js";
import { store as memStore } from "./cache/memory.js";
import { getCacheKey, get as memGet, set as memSet } from "./cache/memory.js";
import { getP, setP, cleanup } from "./cache/persistent.js";
import { initMemoryMonitor, getIsLowMemory } from "./memory.js";
import { enqueue, Priority, type PriorityValue } from "./request/queue.js";
import { fetchWithRetry, cancel as cancelRequest, type FetchResult } from "./request/retry.js";
import { debounce } from "./utils.js";

export { configure, debounce, cancelRequest };
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

export function init(options: Partial<Config> = {}): void {
  configure(options);
  initMemoryMonitor(memStore);
  setInterval(cleanup, getConfig().PERSISTENT_CLEANUP_INTERVAL);
}

// In-flight deduplication
const inFlight = new Map<string, Promise<FetchResult>>();

function _requestKey(endpoint: string, params: Record<string, unknown>): string {
  const { q, page, type } = params as { q?: string; page?: number; type?: string };
  return `${endpoint}?q=${encodeURIComponent(q ?? "")}&page=${page ?? 1}&type=${type ?? "web"}`;
}

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
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.append(k, String(v));
  });

  const cacheKey = getCacheKey(endpoint, params);
  const reqKey = _requestKey(endpoint, params);

  if (useCache) {
    const hit = memGet(cacheKey);
    if (hit) {
      if (hit.expired) {
        enqueue(async () => {
          const r = await fetchWithRetry(url.toString(), _fetchOpts(), reqKey);
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
        const result = await fetchWithRetry(url.toString(), _fetchOpts(), reqKey, onChunk ?? undefined);
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

function _fetchOpts(): RequestInit {
  return { method: "GET", headers: { Accept: "application/json" } };
}

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
