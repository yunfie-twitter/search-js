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
let isCriticalMemory = false;
let currentCacheMax = 0;
let _monitorTimer: ReturnType<typeof setInterval> | null = null;

export const getIsLowMemory = (): boolean => isLowMemory;
export const getIsCriticalMemory = (): boolean => isCriticalMemory;
export const getCurrentCacheMax = (): number => currentCacheMax;

/**
 * メモリモニターを初期化。
 * 複数回呼ばれてもタイマーは常に1つだけ保持する。
 */
export function initMemoryMonitor(cacheRef: Map<unknown, unknown>): void {
  if (_monitorTimer !== null) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }

  const cfg = getConfig();
  currentCacheMax = cfg.CACHE_MAX;

  const nav = navigator as Navigator & { deviceMemory?: number };
  if (capabilities.deviceMemory && nav.deviceMemory !== undefined && nav.deviceMemory <= 2) {
    currentCacheMax = cfg.CACHE_LOW_MEMORY;
  }

  _monitorTimer = setInterval(() => _check(cacheRef), cfg.MEMORY_CHECK_INTERVAL);
}

/** モニターを停止（SSR・テスト・ページ離脱時に呼ぶ） */
export function destroyMemoryMonitor(): void {
  if (_monitorTimer !== null) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
  isLowMemory = false;
  isCriticalMemory = false;
}

function _check(cacheRef: Map<unknown, unknown>): void {
  const cfg = getConfig();
  let pressure = 0;

  // --- ヒープ使用率 ---
  if (capabilities.performanceMemory) {
    const mem = (performance as Performance & {
      memory: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    pressure = Math.max(pressure, (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
  }

  // --- キャッシュサイズによる擬似圧力 ---
  if (cacheRef.size > currentCacheMax * 0.85) {
    pressure = Math.max(pressure, 65);
  }

  const wasLow = isLowMemory;
  const normalThreshold = cfg.MEMORY_PRESSURE_NORMAL * 100;
  const criticalThreshold = cfg.MEMORY_PRESSURE_CRITICAL * 100;

  isCriticalMemory = pressure > criticalThreshold;
  isLowMemory = pressure > normalThreshold;

  if (isLowMemory) {
    // --- LowMemory: キャッシュを積極削減 ---
    const target = isCriticalMemory
      ? Math.ceil(cfg.CACHE_LOW_MEMORY * 0.5)
      : cfg.CACHE_LOW_MEMORY;

    if (currentCacheMax > target) {
      _trimCache(cacheRef, target);
      currentCacheMax = target;
    }
  } else if (!isLowMemory && wasLow) {
    // --- 回復: 上限を段階的に戻す ---
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
