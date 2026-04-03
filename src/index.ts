// src/index.ts
import { configure, getConfig, type Config } from "./config.ts";
import { store as memStore, clearStore, evictExpired, trimToHalf } from "./cache/memory.ts";
import { getCacheKey, get as memGet, set as memSet } from "./cache/memory.ts";
import { getP, setP, cleanup, destroyDB } from "./cache/persistent.ts";
import { initMemoryMonitor, getIsLowMemory, getIsCriticalMemory, destroyMemoryMonitor } from "./memory.ts";
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

/**
 * 全リソースを解放する。
 * SPA のルート切り替えや React の useEffect cleanup で呼ぶことでメモリリークを完全防止。
 */
export async function destroy(): Promise<void> {
  cancelAll();           // 進行中の全リクエストをキャンセル
  clearQueues();         // 待機中タスクを破棄
  inFlight.clear();      // in-flight 重複排除マップをクリア
  clearStore();          // メモリキャッシュをクリア
  await destroyDB();     // IndexedDB 接続を閉じる
  destroyMemoryMonitor(); // タイマーを停止
  if (_cleanupTimer !== null) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
}

// ── In-flight 重複排除 ────────────────────────────────────────────
// 同じクエリが同時に複数発行された場合、1 つの Promise を共有して
// 無駄なネットワークリクエストとメモリ消費を防ぐ。
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
  }: RequestOptions = {}
): Promise<FetchResult> {
  const cfg = getConfig();
  const lowMem = getIsLowMemory();

  // Critical メモリ時はキャッシュを積極的に削減してから続行
  if (getIsCriticalMemory()) {
    evictExpired();
    trimToHalf();
  } else if (lowMem) {
    // Low メモリ時は期限切れエントリだけ削除
    evictExpired();
  }

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
      if (hit.expired && !lowMem) {
        // SWR: LowMemory でなければバックグラウンド再取得
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

    // LowMemory 時は永続キャッシュからのみ復元してメモリへの書き戻しはしない
    if (usePersistentCache) {
      const pData = await getP(cacheKey);
      if (pData) {
        if (!lowMem) memSet(cacheKey, pData); // Low 時はメモリへ展開しない
        return { ok: true, data: pData, cached: true, persistent: true };
      }
    }
  }

  // 同一リクエストの重複排除
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
          // LowMemory 時はメモリキャッシュに書き込まない
          if (!lowMem) memSet(cacheKey, result.data);
          if (usePersistentCache) await setP(cacheKey, result.data);
        }
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        // 完了後は必ず in-flight から削除してメモリを解放
        inFlight.delete(reqKey);
      }
    }, priority);
  });

  inFlight.set(reqKey, promise);
  return promise;
}

// 毎回オブジェクトを生成しないよう共有定数として凍結
const _fetchOpts: RequestInit = Object.freeze({
  method: "GET",
  headers: Object.freeze({ Accept: "application/json" }),
});

/**
 * 次ページを先読みする。
 * LowMemory 時はプリフェッチを完全停止してキャッシュを膨らませない。
 */
function _prefetch(endpoint: string, params: Record<string, unknown>): void {
  if (getIsLowMemory()) return; // LowMemory 時は停止
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

  // LowMemory 時はプリフェッチ停止・ストリーミング停止
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
