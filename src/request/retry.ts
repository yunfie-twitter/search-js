// src/request/retry.ts
import { getConfig } from "../config.ts";

export interface FetchResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  status?: number;
  cached?: boolean;
  stale?: boolean;
  persistent?: boolean;
  streamed?: boolean;
}

// AbortController を key で管理（リクエストキャンセル用）
const controllers = new Map<string, AbortController>();

export function cancel(key: string): void {
  controllers.get(key)?.abort();
  controllers.delete(key);
}

/** 全進行中リクエストをキャンセル（ページ離脱用） */
export function cancelAll(): void {
  for (const ctrl of controllers.values()) ctrl.abort();
  controllers.clear();
}

export async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  key: string,
  onChunk?: (chunk: unknown) => void
): Promise<FetchResult> {
  const cfg = getConfig();
  const canAbort = typeof AbortController !== "undefined";
  const canStream = typeof ReadableStream !== "undefined" && !!onChunk;

  for (let attempt = 0; attempt <= cfg.RETRIES; attempt++) {
    const ctrl = canAbort ? new AbortController() : null;
    // 前回の同一キーのコントローラーがあればキャンセル（重複リクエスト防止）
    controllers.get(key)?.abort();
    if (ctrl) controllers.set(key, ctrl);

    const tid = setTimeout(() => ctrl?.abort(), cfg.TIMEOUT);

    try {
      const res = await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
      clearTimeout(tid);
      controllers.delete(key);

      if (!res.ok) {
        return {
          ok: false,
          error: res.status >= 500 ? "server_error" : "client_error",
          status: res.status,
        };
      }

      if (canStream && res.body) {
        return await _readStream(res.body, ctrl, onChunk!, cfg);
      }

      return { ok: true, data: await res.json() };

    } catch (err) {
      clearTimeout(tid);
      controllers.delete(key);

      if (err instanceof Error) {
        if (err.name === "AbortError" || err.message?.includes("aborted")) {
          return { ok: false, error: "cancelled" };
        }
        if (err instanceof TypeError) {
          if (attempt === cfg.RETRIES) return { ok: false, error: "network_error" };
          await new Promise<void>((r) =>
            setTimeout(r, cfg.RETRY_BACKOFF_BASE * 2 ** attempt)
          );
          continue;
        }
      }
      return { ok: false, error: "unknown_error" };
    }
  }

  return { ok: false, error: "max_retries_exceeded" };
}

async function _readStream(
  body: ReadableStream<Uint8Array>,
  ctrl: AbortController | null,
  onChunk: (chunk: unknown) => void,
  cfg: ReturnType<typeof getConfig>
): Promise<FetchResult> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", braces = 0, inStr = false, esc = false, aborted = false;
  const chunks: unknown[] = [];

  const onAbort = (): void => {
    aborted = true;
    void reader.cancel();
  };
  ctrl?.signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > cfg.STREAMING_BUFFER_SIZE) _flush();
    }
    if (!aborted) _flush();
  } finally {
    // ロック・リスナーを必ず解放する
    reader.releaseLock();
    ctrl?.signal.removeEventListener("abort", onAbort);
    // バッファを明示的に解放
    buf = "";
  }

  return {
    ok: true,
    data: chunks.length === 1 ? chunks[0] : chunks,
    streamed: true,
  };

  function _flush(): void {
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") { if (!braces) start = i; braces++; }
      else if (c === "}") {
        if (!--braces) {
          try {
            const obj: unknown = JSON.parse(buf.slice(start, i + 1));
            chunks.push(obj);
            onChunk(obj);
          } catch { /* ignore malformed */ }
          buf = buf.slice(i + 1);
          i = -1;
        }
      }
    }
  }
}
