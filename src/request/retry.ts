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

// 進行中リクエストの AbortController マップ
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
    // 同一キーの前回分を必ずキャンセルしてリーク防止
    controllers.get(key)?.abort();
    const ctrl = canAbort ? new AbortController() : null;
    if (ctrl) controllers.set(key, ctrl);

    // 外部 signal と内部 ctrl のマージ
    const externalSignal = opts.signal;
    let mergedSignal: AbortSignal | undefined;
    if (ctrl && externalSignal) {
      // 両方のキャンセルを捕捉
      if (typeof AbortSignal.any === "function") {
        mergedSignal = AbortSignal.any([ctrl.signal, externalSignal]);
      } else {
        // フォールバック: 外部 signal を監視して ctrl に伝總
        const bridge = (): void => ctrl.abort();
        externalSignal.addEventListener("abort", bridge, { once: true });
        mergedSignal = ctrl.signal;
      }
    } else {
      mergedSignal = ctrl?.signal ?? externalSignal;
    }

    const fetchOpts: RequestInit = mergedSignal
      ? { ...opts, signal: mergedSignal }
      : opts;

    // タイムアウトは ctrl ベースのシグナルのみ abort
    const tid = ctrl
      ? setTimeout(() => ctrl.abort(), cfg.TIMEOUT)
      : undefined;

    try {
      const res = await fetch(url, fetchOpts);
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
          await _sleep(cfg.RETRY_BACKOFF_BASE * 2 ** attempt);
          continue;
        }
      }
      return { ok: false, error: "unknown_error" };
    }
  }

  return { ok: false, error: "max_retries_exceeded" };
}

const _sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * ストリームを読み取って JSON オブジェクトを逆次コールバックに渡す。
 *
 * リーク防止のための保証:
 * - finally で必ず reader.releaseLock()
 * - { once: true } で abort リスナーを自動解除
 * - finally で buf を空文字列にして文字列参照を切る
 * - aborted 時は reader.cancel() でストリームを閉じる
 */
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

  const onAbort = (): void => {
    aborted = true;
    // cancel() は非同期なので void で捨てる
    reader.cancel().catch(() => {});
  };
  ctrl?.signal.addEventListener("abort", onAbort, { once: true });

  try {
    outer: while (!aborted) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        // キャンセル・ネットワークエラーはループを抖り出す
        break outer;
      }
      if (readResult.done) break;
      buf += dec.decode(readResult.value, { stream: true });
      if (buf.length > cfg.STREAMING_BUFFER_SIZE) _flush();
    }
    if (!aborted) _flush();
  } finally {
    ctrl?.signal.removeEventListener("abort", onAbort);
    // releaseLock は cancel 後でも安全に呼び出せる
    try { reader.releaseLock(); } catch { /* 既に解放済みの場合 */ }
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
      if (esc)         { esc = false; continue; }
      if (c === "\\")  { esc = true;  continue; }
      if (c === '"')   { inStr = !inStr; continue; }
      if (inStr)       continue;
      if (c === "{")   { if (!braces) start = i; braces++; }
      else if (c === "}") {
        if (!--braces) {
          try {
            const obj: unknown = JSON.parse(buf.slice(start, i + 1));
            chunks.push(obj);
            onChunk(obj);
          } catch { /* malformed JSON は無視 */ }
          buf = buf.slice(i + 1);
          i = -1;
        }
      }
    }
  }
}
