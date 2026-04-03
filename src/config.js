// src/config.js
export const defaults = {
  API_BASE: "https://api.wholphin.net",
  CACHE_TTL: 1000 * 60 * 5,
  CACHE_MAX: 30,
  CACHE_LOW_MEMORY: 10,
  MEMORY_PRESSURE_NORMAL: 0.65,
  MEMORY_PRESSURE_CRITICAL: 0.80,
  STRINGIFY_SIZE_THRESHOLD: 1024 * 10,
  TIMEOUT: 8000,
  RETRIES: 3,
  RETRY_BACKOFF_BASE: 1000,
  MAX_CONCURRENT_REQUESTS: 6,
  STREAMING_BUFFER_SIZE: 1024 * 10,
  PERSISTENT_CACHE_MAX: 500,
  PERSISTENT_CLEANUP_INTERVAL: 1000 * 60 * 30,
  MEMORY_CHECK_INTERVAL: 1000 * 60,
};

// 使用側が configure() で上書きできる実行時設定
let _config = { ...defaults };

export function configure(overrides = {}) {
  _config = { ...defaults, ...overrides };
}

export function getConfig() {
  return _config;
}
