// src/memory.js
import { getConfig } from "./config.js";

const capabilities = {
  performanceMemory:
    typeof performance !== "undefined" && performance.memory,
  deviceMemory:
    typeof navigator !== "undefined" && navigator.deviceMemory,
};

let isLowMemory = false;
let currentCacheMax;

// 外部から読み取れるゲッター
export const getIsLowMemory = () => isLowMemory;
export const getCurrentCacheMax = () => currentCacheMax;

export function initMemoryMonitor(cacheRef) {
  const cfg = getConfig();
  currentCacheMax = cfg.CACHE_MAX;

  if (capabilities.deviceMemory && navigator.deviceMemory <= 2) {
    currentCacheMax = cfg.CACHE_LOW_MEMORY;
  }

  setInterval(() => _check(cacheRef), cfg.MEMORY_CHECK_INTERVAL);
}

function _check(cacheRef) {
  const cfg = getConfig();
  let pressure = 0;

  if (capabilities.performanceMemory) {
    const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory;
    pressure = Math.max(pressure, (usedJSHeapSize / jsHeapSizeLimit) * 100);
  }

  if (cacheRef.size > currentCacheMax * 0.85) {
    pressure = Math.max(pressure, 65);
  }

  const waLow = isLowMemory;
  isLowMemory = pressure > cfg.MEMORY_PRESSURE_NORMAL * 100;

  if (isLowMemory && currentCacheMax > cfg.CACHE_LOW_MEMORY) {
    const target =
      pressure > cfg.MEMORY_PRESSURE_CRITICAL * 100
        ? Math.ceil(cfg.CACHE_LOW_MEMORY * 0.5)
        : cfg.CACHE_LOW_MEMORY;
    _trimCache(cacheRef, target);
    currentCacheMax = target;
  } else if (!isLowMemory && currentCacheMax < cfg.CACHE_MAX && waLow) {
    currentCacheMax = Math.min(cfg.CACHE_MAX, Math.ceil(currentCacheMax * 1.5));
  }
}

function _trimCache(cacheRef, maxSize) {
  while (cacheRef.size > maxSize) {
    cacheRef.delete(cacheRef.keys().next().value);
  }
}
