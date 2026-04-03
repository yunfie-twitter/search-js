// src/request/retry.js
import { getConfig } from "../config.js";

const controllers = new Map();

export function cancel(key) {
  controllers.get(key)?.abort();
  controllers.delete(key);
}

export async function fetchWithRetry(url, opts, key, onChunk) {
  const cfg = getConfig();
  const canAbort = typeof AbortController !== "undefined";
  const canStream = typeof ReadableStream !== "undefined" && onChunk;

  for (let attempt = 0; attempt <= cfg.RETRIES; attempt++) {
    const ctrl = canAbort ? new AbortController() : null;
    const tid = setTimeout(() => ctrl?.abort(), cfg.TIMEOUT);
    if (ctrl) controllers.set(key, ctrl);

    try {
      const res = await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
      clearTimeout(tid);
      if (ctrl) { ctrl.signal.onabort = null; controllers.delete(key); }

      if (!res.ok) {
        return { ok: false, error: res.status >= 500 ? "server_error" : "client_error", status: res.status };
      }

      if (canStream && res.body) {
        return await _readStream(res.body, ctrl, onChunk, cfg);
      }

      return { ok: true, data: await res.json() };

    } catch (err) {
      clearTimeout(tid);
      if (ctrl) { ctrl.signal.onabort = null; controllers.delete(key); }

      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        return { ok: false, error: "cancelled" };
      }
      if (err instanceof TypeError) {
        if (attempt === cfg.RETRIES) return { ok: false, error: "network_error" };
        await new Promise((r) => setTimeout(r, cfg.RETRY_BACKOFF_BASE * 2 ** attempt));
        continue;
      }
      return { ok: false, error: "unknown_error" };
    }
  }
}

async function _readStream(body, ctrl, onChunk, cfg) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", braces = 0, inStr = false, esc = false, aborted = false;
  const chunks = [];

  const onAbort = () => { aborted = true; reader.cancel(); };
  ctrl?.signal.addEventListener("abort", onAbort);

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.length > cfg.STREAMING_BUFFER_SIZE) _flush();
    }
    if (!aborted) _flush();
  } finally {
    reader.releaseLock();
    ctrl?.signal.removeEventListener("abort", onAbort);
  }

  function _flush() {
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
            const obj = JSON.parse(buf.slice(start, i + 1));
            chunks.push(obj);
            onChunk?.(obj);
          } catch { /* ignore malformed */ }
          buf = buf.slice(i + 1);
          i = -1;
        }
      }
    }
  }

  return { ok: true, data: chunks.length === 1 ? chunks[0] : chunks, streamed: true };
}
