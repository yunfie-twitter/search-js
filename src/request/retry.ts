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

export function cancel(key: string): void {
  controllers.get(key)?.abort();
  controllers.delete(key);
}

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
    // 前の attempt の ctrl を必ず削除してから新しい ctrl を登録
    controllers.get(key)?.abort();
    controllers.delete(key);

    const ctrl = canAbort ? new AbortController() : null;
    if (ctrl) controllers.set(key, ctrl);

    const externalSignal = opts.signal as AbortSignal | undefined;
    let mergedSignal: AbortSignal | undefined;

    if (ctrl && externalSignal) {
      if (typeof AbortSignal.any === "function") {
        mergedSignal = AbortSignal.any([ctrl.signal, externalSignal]);
      } else {
        const bridge = (): void => ctrl.abort();
        externalSignal.addEventListener("abort", bridge, { once: true });
        mergedSignal = ctrl.signal;
      }
    } else {
      mergedSignal = ctrl?.signal ?? externalSignal ?? undefined;
    }

    const fetchOpts: RequestInit = mergedSignal ? { ...opts, signal: mergedSignal } : opts;
    const tid = ctrl ? setTimeout(() => ctrl.abort(), cfg.TIMEOUT) : undefined;

    try {
      const res = await fetch(url, fetchOpts);
      clearTimeout(tid);
      // 成功時は必ず削除
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
      // エラー時も必ず削除（リトライする場合もループ先頭で再登録される）
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

  const onAbort = (): void => { aborted = true; reader.cancel().catch(() => {}); };
  ctrl?.signal.addEventListener("abort", onAbort, { once: true });

  try {
    outer: while (!aborted) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try { readResult = await reader.read(); }
      catch { break outer; }
      if (readResult.done) break;
      buf += dec.decode(readResult.value, { stream: true });
      // #2 fix: aborted チェックを追加して二重 _flush を防止
      if (!aborted && buf.length > cfg.STREAMING_BUFFER_SIZE) _flush();
    }
    if (!aborted) _flush();
  } finally {
    ctrl?.signal.removeEventListener("abort", onAbort);
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
