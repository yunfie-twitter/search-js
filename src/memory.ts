// src/memory.ts
import { getConfig } from "./config.ts";
import { emit } from "./events.ts";

/**
 * =======================
 * 型定義
 * =======================
 */

interface Capabilities {
  performanceMemory: boolean;
  deviceMemory: boolean;
}

interface MemoryState {
  isLow: boolean;
  isCritical: boolean;
  cacheMax: number;
}

/**
 * =======================
 * 定数
 * =======================
 */

const CACHE_PRESSURE_RATIO = 0.85;
const CACHE_PRESSURE_SCORE = 65;

/**
 * =======================
 * 環境検出
 * =======================
 */

const capabilities: Capabilities = {
  performanceMemory:
    typeof performance !== "undefined" &&
    "memory" in performance,

  deviceMemory:
    typeof navigator !== "undefined" &&
    "deviceMemory" in navigator,
};

/**
 * =======================
 * 内部状態
 * =======================
 */

let state: MemoryState = {
  isLow: false,
  isCritical: false,
  cacheMax: 0,
};

let timer: ReturnType<typeof setInterval> | null = null;
let config = getConfig();

/**
 * =======================
 * Public API
 * =======================
 */

export const getIsLowMemory = () => state.isLow;
export const getIsCriticalMemory = () => state.isCritical;
export const getCurrentCacheMax = () => state.cacheMax;

export function initMemoryMonitor(cache: Map<unknown, unknown>): void {
  stopMonitor();

  config = getConfig();
  state.cacheMax = resolveInitialCacheSize(config);

  timer = setInterval(() => {
    updateState(cache);
  }, config.MEMORY_CHECK_INTERVAL);
}

export function destroyMemoryMonitor(): void {
  stopMonitor();
  state = { isLow: false, isCritical: false, cacheMax: 0 };
}

/**
 * =======================
 * 内部処理
 * =======================
 */

function stopMonitor(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function resolveInitialCacheSize(cfg: ReturnType<typeof getConfig>): number {
  if (capabilities.deviceMemory) {
    const nav = navigator as Navigator & { deviceMemory?: number };
    if (nav.deviceMemory && nav.deviceMemory <= 2) {
      return cfg.CACHE_LOW_MEMORY;
    }
  }
  return cfg.CACHE_MAX;
}

/**
 * メイン更新処理
 */
function updateState(cache: Map<unknown, unknown>): void {
  const pressure = calculatePressure(cache);
  const next = evaluateState(pressure);

  handleStateChange(next);

  state.isLow = next.isLow;
  state.isCritical = next.isCritical;

  adjustCache(cache);
}

/**
 * 純粋関数：圧力計算
 */
function calculatePressure(cache: Map<unknown, unknown>): number {
  let pressure = 0;

  if (capabilities.performanceMemory) {
    const mem = (performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;

    if (mem) {
      pressure = Math.max(
        pressure,
        (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100
      );
    }
  }

  if (cache.size > state.cacheMax * CACHE_PRESSURE_RATIO) {
    pressure = Math.max(pressure, CACHE_PRESSURE_SCORE);
  }

  return pressure;
}

/**
 * 純粋関数：状態判定
 */
function evaluateState(pressure: number): { isLow: boolean; isCritical: boolean } {
  return {
    isLow: pressure > config.MEMORY_PRESSURE_NORMAL * 100,
    isCritical: pressure > config.MEMORY_PRESSURE_CRITICAL * 100,
  };
}

/**
 * 状態変化処理
 */
function handleStateChange(next: { isLow: boolean; isCritical: boolean }) {
  if (
    next.isLow !== state.isLow ||
    next.isCritical !== state.isCritical
  ) {
    emit("memoryStateChange", next);
  }
}

/**
 * キャッシュ調整
 */
function adjustCache(cache: Map<unknown, unknown>): void {
  if (state.isLow) {
    const target = state.isCritical
      ? Math.ceil(config.CACHE_LOW_MEMORY * 0.5)
      : config.CACHE_LOW_MEMORY;

    if (state.cacheMax > target) {
      trimCache(cache, target);
      state.cacheMax = target;
    }
  } else {
    // 回復
    state.cacheMax = Math.min(
      config.CACHE_MAX,
      Math.ceil(state.cacheMax * 1.5)
    );
  }
}

/**
 * FIFO削除（Map依存）
 */
function trimCache(cache: Map<unknown, unknown>, maxSize: number): void {
  while (cache.size > maxSize) {
    const key = cache.keys().next().value;
    if (key === undefined) break;
    cache.delete(key);
  }
}
