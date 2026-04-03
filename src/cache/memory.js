// src/cache/memory.js
import { getConfig } from "../config.js";
import { getCurrentCacheMax } from "../memory.js";

const store = new Map();

export function getCacheKey(endpoint, params) {
  return endpoint + "?" + new URLSearchParams(params).toString();
}

export function get(key) {
  const item = store.get(key);
  if (!item) return null;

  // LRU 更新
  store.delete(key);
  store.set(key, item);

  // 遅延 JSON パース
  if (typeof item.data === "string" && !item.parsed) {
    item.parsed = JSON.parse(item.data);
  }

  return {
    data: item.parsed ?? item.data,
    expired: Date.now() - item.time > getConfig().CACHE_TTL,
  };
}

export function set(key, data) {
  const cfg = getConfig();
  const max = getCurrentCacheMax();

  if (store.has(key)) store.delete(key);
  if (store.size >= max) store.delete(store.keys().next().value);

  const jsonStr = typeof data === "string" ? data : JSON.stringify(data);
  store.set(key, {
    time: Date.now(),
    data: jsonStr.length < cfg.STRINGIFY_SIZE_THRESHOLD ? jsonStr : data,
  });
}

export { store }; // memory monitor から参照するため
