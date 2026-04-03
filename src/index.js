// src/index.js
import { configure, getConfig } from "./config.js";
import { store as memStore } from "./cache/memory.js";
import { getCacheKey, get as memGet, set as memSet } from "./cache/memory.js";
import { getP, setP, cleanup } from "./cache/persistent.js";
import { initMemoryMonitor, getIsLowMemory } from "./memory.js";
import { enqueue, Priority } from "./request/queue.js";
import { fetchWithRetry, cancel as cancelRequest } from "./request/retry.js";
import { debounce } from "./utils.js";

export { configure, debounce, cancelRequest };

// 初期化（アプリ起動時に1回呼ぶ）
export function init(options = {}) {
  configure(options);
  initMemoryMonitor(memStore);
  setInterval(cleanup, getConfig().PERSISTENT_CLEANUP_INTERVAL);
}

// In-flight deduplication
const inFlight = new Map();

function _requestKey(endpoint, params) {
  const { q, page, type } = params;
  return `${endpoint}?q=${encodeURIComponent(q ?? "")}&page=${page ?? 1}&type=${type ?? "web"}`;
}

async function request(endpoint, params = {}, {
  useCache = true,
  priority = Priority.NORMAL,
  onChunk,
  usePersistentCache = false,
} = {}) {
  const cfg = getConfig();
  const url = new URL(cfg.API_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.append(k, v);
  });

  const cacheKey = getCacheKey(endpoint, params);
  const reqKey = _requestKey(endpoint, params);

  if (useCache) {
    const hit = memGet(cacheKey);
    if (hit) {
      if (hit.expired) {
        // SWR: バックグラウンドで再取得
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

  if (inFlight.has(reqKey)) return inFlight.get(reqKey);

  const promise = new Promise((resolve, reject) => {
    enqueue(async () => {
      try {
        const result = await fetchWithRetry(url.toString(), _fetchOpts(), reqKey, onChunk);
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

function _fetchOpts() {
  return { method: "GET", headers: { Accept: "application/json" } };
}

function _prefetch(endpoint, params) {
  if (getIsLowMemory()) return;
  const cacheKey = getCacheKey(endpoint, params);
  const hit = memGet(cacheKey);
  if (hit && !hit.expired) return;
  if (inFlight.has(_requestKey(endpoint, params))) return;
  request(endpoint, params, { priority: Priority.LOW }).catch(() => {});
}

// ========================
// パブリック検索 API
// ========================
export async function search({
  q,
  page = 1,
  type = "web",
  safesearch = 0,
  lang = "ja",
  enableStreaming = false,
  onChunk,
  usePersistentCache = false,
} = {}) {
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

// タイプ別ショートハンド
export const searchWeb    = (q, page = 1) => search({ q, page, type: "web" });
export const searchImage  = (q, page = 1) => search({ q, page, type: "image" });
export const searchVideo  = (q, page = 1) => search({ q, page, type: "video" });
export const searchNews   = (q, page = 1) => search({ q, page, type: "news" });
export const getSuggest   = (q)           => search({ q, type: "suggest" });
export const searchPanel  = (q)           => search({ q, type: "panel" });
