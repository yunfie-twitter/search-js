// src/memory.ts
import { getConfig, defaults } from "./config.js";
import { emit } from "./events.js";

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
let currentCacheMax = defaults.CACHE_MAX;
let _monitorTimer: ReturnType<typeof setInterval> | null = null;

export const getIsLowMemory = (): boolean => isLowMemory;
export const getIsCriticalMemory = (): boolean => isCriticalMemory;
export const getCurrentCacheMax = (): number => currentCacheMax;

/** メモリ監視タイマーを開始する。init() から呼ぶこと。 */
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

/** メモリ監視タイマーを停止してフラグをリセットする。destroy() から呼ぶこと。 */
export function destroyMemoryMonitor(): void {
  if (_monitorTimer !== null) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
  isLowMemory = false;
  isCriticalMemory = false;
  currentCacheMax = defaults.CACHE_MAX;
}

function _check(cacheRef: Map<unknown, unknown>): void {
  const cfg = getConfig();
  let pressure = 0;

  if (capabilities.performanceMemory) {
    const mem = (performance as Performance & {
      memory: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    pressure = Math.max(pressure, (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100);
  }

  if (cacheRef.size > currentCacheMax * 0.85) {
    pressure = Math.max(pressure, cfg.MEMORY_PRESSURE_NORMAL * 100);
  }

  const prevLow      = isLowMemory;
  const prevCritical = isCriticalMemory;

  const normalThreshold   = cfg.MEMORY_PRESSURE_NORMAL * 100;
  const criticalThreshold = cfg.MEMORY_PRESSURE_CRITICAL * 100;

  isCriticalMemory = pressure > criticalThreshold;
  isLowMemory      = pressure > normalThreshold;

  if (isLowMemory !== prevLow || isCriticalMemory !== prevCritical) {
    emit("memoryStateChange", { isLow: isLowMemory, isCritical: isCriticalMemory });
  }

  if (isLowMemory) {
    const target = isCriticalMemory
      ? Math.ceil(cfg.CACHE_LOW_MEMORY * 0.5)
      : cfg.CACHE_LOW_MEMORY;
    // [QUALITY fix] target が 0 以下にならないよう最低値 1 を保証する
    const safeTarget = Math.max(1, target);
    if (currentCacheMax > safeTarget) {
      _trimCache(cacheRef, safeTarget);
      currentCacheMax = safeTarget;
    }
  } else if (!isLowMemory && prevLow) {
    currentCacheMax = Math.min(cfg.CACHE_MAX, Math.ceil(currentCacheMax * 1.5));
  }
}

function _trimCache(cacheRef: Map<unknown, unknown>, maxSize: number): void {
  // [QUALITY fix] maxSize が 0 以下の場合でも安全に動作するよう保護
  const safeMax = Math.max(0, maxSize);
  let iterations = 0;
  const limit = cacheRef.size;
  while (cacheRef.size > safeMax && iterations < limit) {
    iterations++;
    const firstKey = cacheRef.keys().next().value;
    if (firstKey !== undefined) cacheRef.delete(firstKey);
    else break;
  }
}
