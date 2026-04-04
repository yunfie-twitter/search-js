// src/request/retry.ts
import { getConfig } from "../config.js";

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

const controllers = new Map<string, AbortController>();

/** 指定キーのリクエストをキャンセルする */
export function cancel(key: string): void {
  controllers.get(key)?.abort();
  controllers.delete(key);
}

/** 全進行中リクエストをキャンセルする */
export function cancelAll(): void {
  for (const ctrl of controllers.values()) ctrl.abort();
  controllers.clear();
}

/**
 * リトライ付き fetch。タイムアウト・外部 AbortSignal に対応。
 * ストリーミングが有効かつ onChunk が渡された場合は _readStream で処理する。
 */
export async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  key: string,
  onChunk?: (chunk: unknown) => void
): Promise<FetchResult> {
  const cfg = getConfig();
  const canAbort = typeof AbortController !== "undefined";
  const canStream = typeof ReadableStream !== "undefined" && !!onChunk;
  const externalSignal = opts.signal as AbortSignal | undefined;

  for (let attempt = 0; attempt <= cfg.RETRIES; attempt++) {
    controllers.get(key)?.abort();
    controllers.delete(key);

    const ctrl = canAbort ? new AbortController() : null;
    if (ctrl) controllers.set(key, ctrl);

    let bridge: (() => void) | undefined;
    let mergedSignal: AbortSignal | undefined;

    if (ctrl && externalSignal) {
      if (typeof AbortSignal.any === "function") {
        mergedSignal = AbortSignal.any([ctrl.signal, externalSignal]);
      } else {
        bridge = (): void => ctrl.abort();
        externalSignal.addEventListener("abort", bridge, { once: true });
        mergedSignal = ctrl.signal;
      }
    } else {
      mergedSignal = ctrl?.signal ?? externalSignal ?? undefined;
    }

    const fetchOpts: RequestInit = mergedSignal ? { ...opts, signal: mergedSignal } : opts;
    let tid: ReturnType<typeof setTimeout> | undefined;
    if (ctrl) tid = setTimeout(() => ctrl.abort(), cfg.TIMEOUT);

    try {
      const res = await fetch(url, fetchOpts);
      clearTimeout(tid);
      if (bridge && externalSignal) externalSignal.removeEventListener("abort", bridge);
      controllers.delete(key);

      if (!res.ok) {
        return {
          ok: false,
          error: res.status >= 500 ? "server_error" : "client_error",
          status: res.status,
        };
      }

      if (canStream && res.body) return await _readStream(res.body, ctrl, onChunk!, cfg);
      return { ok: true, data: await res.json() };

    } catch (err) {
      clearTimeout(tid);
      if (bridge && externalSignal) externalSignal.removeEventListener("abort", bridge);
      controllers.delete(key);

      if (err instanceof Error) {
        if (err.name === "AbortError" || err.message?.includes("aborted")) {
          return { ok: false, error: "cancelled" };
        }
        if (err instanceof TypeError) {
          if (attempt === cfg.RETRIES) return { ok: false, error: "network_error" };
          await _sleep(cfg.RETRY_BACKOFF_BASE * 2 ** attempt);
          continue;
        }
      }
      return { ok: false, error: "unknown_error" };
    }
  }

  return { ok: false, error: "max_retries_exceeded" };
}

const _sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function _readStream(
  body: ReadableStream<Uint8Array>,
  ctrl: AbortController | null,
  onChunk: (chunk: unknown) => void,
  cfg: ReturnType<typeof getConfig>
): Promise<FetchResult> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let braces = 0;
  let inStr = false;
  let esc = false;
  let aborted = false;
  const chunks: unknown[] = [];

  // [FREEZE fix] onAbort は一度だけ実行されることを保証するフラグを追加。
  // ctrl.signal と finally 内の reader.cancel() が競合しても二重 cancel しない。
  let abortHandled = false;
  const onAbort = (): void => {
    if (abortHandled) return;
    abortHandled = true;
    aborted = true;
    reader.cancel().catch(() => {});
  };
  ctrl?.signal.addEventListener("abort", onAbort, { once: true });

  try {
    outer: while (!aborted) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try { readResult = await reader.read(); }
      catch { break outer; }
      if (readResult.done) break;
      buf += dec.decode(readResult.value, { stream: true });
      if (!aborted && buf.length > cfg.STREAMING_BUFFER_SIZE) _flush();
    }
    if (!aborted) _flush();
  } finally {
    ctrl?.signal.removeEventListener("abort", onAbort);
    // aborted 時は onAbort 内で既に cancel() を発行済みのため await のみ行う。
    // 未 abort の場合は cancel 不要なので releaseLock だけ呼ぶ。
    if (aborted) {
      try { await reader.cancel(); } catch { /* already cancelled */ }
    }
    try { reader.releaseLock(); } catch { /* already released */ }
    buf = "";
  }

  return {
    ok: !aborted,
    ...(aborted ? { error: "cancelled" } : {}),
    data: chunks.length === 1 ? chunks[0] : chunks,
    streamed: true,
  };

  function _flush(): void {
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (esc)        { esc = false; continue; }
      if (c === "\\") { esc = true;  continue; }
      if (c === '"')  { inStr = !inStr; continue; }
      if (inStr)      continue;
      if (c === "{")  { if (!braces) start = i; braces++; }
      else if (c === "}") {
        if (!--braces) {
          try {
            const obj: unknown = JSON.parse(buf.slice(start, i + 1));
            chunks.push(obj);
            onChunk(obj);
          } catch { /* malformed JSON */ }
          buf = buf.slice(i + 1);
          i = -1;
        }
      }
    }
  }
}
