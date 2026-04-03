// src/memory.ts
import { getConfig } from "./config.ts";

interface Capabilities {
  performanceMemory: boolean;
  deviceMemory: boolean;
}

const capabilities: Capabilities = {
  performanceMemory:
    typeof performance !== "undefined" &&
    !!(performance as Performance & { memory?: unknown }).memory,
  deviceMemory:
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === "number",
};

let isLowMemory = false;
let currentCacheMax: number;

export const getIsLowMemory = (): boolean => isLowMemory;
export const getCurrentCacheMax = (): number => currentCacheMax;

export function initMemoryMonitor(cacheRef: Map<unknown, unknown>): void {
  const cfg = getConfig();
  currentCacheMax = cfg.CACHE_MAX;

  const nav = navigator as Navigator & { deviceMemory?: number };
  if (capabilities.deviceMemory && nav.deviceMemory !== undefined && nav.deviceMemory <= 2) {
    currentCacheMax = cfg.CACHE_LOW_MEMORY;
  }

  setInterval(() => _check(cacheRef), cfg.MEMORY_CHECK_INTERVAL);
}

function _check(cacheRef: Map<unknown, unknown>): void {
  const cfg = getConfig();
  let pressure = 0;

  if (capabilities.performanceMemory) {
    const mem = (performance as Performance & { memory: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    pressure = Math.max(pressure, (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
  }

  if (cacheRef.size > currentCacheMax * 0.85) {
    pressure = Math.max(pressure, 65);
  }

  const wasLow = isLowMemory;
  isLowMemory = pressure > cfg.MEMORY_PRESSURE_NORMAL * 100;

  if (isLowMemory && currentCacheMax > cfg.CACHE_LOW_MEMORY) {
    const target =
      pressure > cfg.MEMORY_PRESSURE_CRITICAL * 100
        ? Math.ceil(cfg.CACHE_LOW_MEMORY * 0.5)
        : cfg.CACHE_LOW_MEMORY;
    _trimCache(cacheRef, target);
    currentCacheMax = target;
  } else if (!isLowMemory && currentCacheMax < cfg.CACHE_MAX && wasLow) {
    currentCacheMax = Math.min(cfg.CACHE_MAX, Math.ceil(currentCacheMax * 1.5));
  }
}

function _trimCache(cacheRef: Map<unknown, unknown>, maxSize: number): void {
  while (cacheRef.size > maxSize) {
    const firstKey = cacheRef.keys().next().value;
    if (firstKey !== undefined) cacheRef.delete(firstKey);
    else break;
  }
}
