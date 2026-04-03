// src/request/retry.ts
import { getConfig } from "../config.ts";

export interface FetchResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
  cached?: boolean;
  stale?: boolean;
  persistent?: boolean;
  streamed?: boolean;
}

const controllers = new Map<string, AbortController>();

export function cancel(key: string): void {
  const ctrl = controllers.get(key);
  if (ctrl) {
    ctrl.abort();
    controllers.delete(key);
  }
}

export function cancelAll(): void {
  for (const ctrl of controllers.values()) ctrl.abort();
  controllers.clear();
}

export async function fetchWithRetry<T = unknown>(
  url: string,
  opts: RequestInit = {},
  key: string,
  onChunk?: (chunk: T) => void
): Promise<FetchResult<T>> {
  const cfg = getConfig();

  const canAbort = typeof AbortController !== "undefined";
  const canStream = typeof ReadableStream !== "undefined";

  for (let attempt = 0; attempt <= cfg.RETRIES; attempt++) {
    // ---- AbortController ----
    const prev = controllers.get(key);
    if (prev) {
      prev.abort();
      controllers.delete(key);
    }

    const ctrl = canAbort ? new AbortController() : null;
    if (ctrl) controllers.set(key, ctrl);

    // ---- signal merge ----
    const externalSignal = opts.signal;
    let mergedSignal: AbortSignal | undefined;
    let cleanupExternal: (() => void) | undefined;

    if (ctrl && externalSignal) {
      if (typeof AbortSignal.any === "function") {
        mergedSignal = AbortSignal.any([ctrl.signal, externalSignal]);
      } else {
        const bridge = (): void => ctrl.abort();
        externalSignal.addEventListener("abort", bridge, { once: true });
        cleanupExternal = () =>
          externalSignal.removeEventListener("abort", bridge);
        mergedSignal = ctrl.signal;
      }
    } else {
      mergedSignal = ctrl?.signal ?? externalSignal;
    }

    const fetchOpts: RequestInit = mergedSignal
      ? { ...opts, signal: mergedSignal }
      : opts;

    const tid =
      ctrl !== null
        ? setTimeout(() => ctrl.abort(), cfg.TIMEOUT)
        : undefined;

    try {
      const res = await fetch(url, fetchOpts);

      if (tid) clearTimeout(tid);
      cleanupExternal?.();
      controllers.delete(key);

      if (!res.ok) {
        return {
          ok: false,
          error: res.status >= 500 ? "server_error" : "client_error",
          status: res.status,
        };
      }

      // ---- streaming ----
      if (canStream && res.body && onChunk) {
        return await _readStream<T>(res.body, ctrl, onChunk, cfg);
      }

      // ---- safe parse ----
      const contentType = res.headers.get("content-type") || "";

      let data: unknown;

      if (contentType.includes("application/json")) {
        data = res.status === 204 ? null : await res.json();
      } else {
        data = await res.text();
      }

      return { ok: true, data: data as T };

    } catch (err) {
      if (tid) clearTimeout(tid);
      cleanupExternal?.();
      controllers.delete(key);

      if (err instanceof Error) {
        // Abort
        if (err.name === "AbortError" || err.message.includes("aborted")) {
          return { ok: false, error: "cancelled", status: 0 };
        }

        // Network error
        if (
          err instanceof TypeError ||
          err.name === "NetworkError"
        ) {
          if (attempt === cfg.RETRIES) {
            return { ok: false, error: "network_error" };
          }

          // jitter付きバックオフ
          const base = cfg.RETRY_BACKOFF_BASE * 2 ** attempt;
          const jitter = base * (0.5 + Math.random() * 0.5);
          await _sleep(jitter);
          continue;
        }

        return { ok: false, error: err.message };
      }

      return { ok: false, error: "unknown_error" };
    }
  }

  return { ok: false, error: "max_retries_exceeded" };
}

const _sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function _readStream<T>(
  body: ReadableStream<Uint8Array>,
  ctrl: AbortController | null,
  onChunk: (chunk: T) => void,
  cfg: ReturnType<typeof getConfig>
): Promise<FetchResult<T>> {
  const reader = body.getReader();
  const dec = new TextDecoder();

  let buf = "";
  let braces = 0;
  let inStr = false;
  let esc = false;
  let aborted = false;

  const chunks: T[] = [];

  const onAbort = (): void => {
    aborted = true;
    reader.cancel().catch(() => {});
  };

  ctrl?.signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!aborted) {
      let result: ReadableStreamReadResult<Uint8Array>;

      try {
        result = await reader.read();
      } catch {
        break;
      }

      if (result.done) break;

      buf += dec.decode(result.value, { stream: true });

      if (buf.length > cfg.STREAMING_BUFFER_SIZE) flush();
    }

    if (!aborted) flush();

  } finally {
    ctrl?.signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
    buf = "";
  }

  return {
    ok: !aborted,
    ...(aborted ? { error: "cancelled" } : {}),
    data: (chunks.length === 1 ? chunks[0] : chunks) as T,
    streamed: true,
  };

  function flush(): void {
    let start = 0;

    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];

      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;

      if (c === "{") {
        if (!braces) start = i;
        braces++;
      } else if (c === "}") {
        braces--;
        if (!braces) {
          try {
            const obj = JSON.parse(buf.slice(start, i + 1)) as T;
            chunks.push(obj);
            onChunk(obj);
          } catch {}

          buf = buf.slice(i + 1);
          i = -1;
        }
      }
    }
  }
}
