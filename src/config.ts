// src/config.ts

export interface Config {
  API_BASE: string;
  CACHE_TTL: number;
  CACHE_MAX: number;
  CACHE_LOW_MEMORY: number;
  MEMORY_PRESSURE_NORMAL: number;
  MEMORY_PRESSURE_CRITICAL: number;
  STRINGIFY_SIZE_THRESHOLD: number;
  TIMEOUT: number;
  RETRIES: number;
  RETRY_BACKOFF_BASE: number;
  MAX_CONCURRENT_REQUESTS: number;
  MAX_CONCURRENT_LOW_MEMORY: number;
  STREAMING_BUFFER_SIZE: number;
  PERSISTENT_CACHE_MAX: number;
  PERSISTENT_CLEANUP_INTERVAL: number;
  MEMORY_CHECK_INTERVAL: number;
  SUGGEST_TTL: number;
  SUGGEST_DEBOUNCE_MS: number;
}

export const defaults: Config = {
  API_BASE: "https://api.wholphin.net",
  CACHE_TTL: 1000 * 60 * 5,
  CACHE_MAX: 30,
  CACHE_LOW_MEMORY: 10,
  MEMORY_PRESSURE_NORMAL: 0.65,
  MEMORY_PRESSURE_CRITICAL: 0.80,
  STRINGIFY_SIZE_THRESHOLD: 1024 * 10,
  TIMEOUT: 20000,
  RETRIES: 3,
  RETRY_BACKOFF_BASE: 1000,
  MAX_CONCURRENT_REQUESTS: 6,
  MAX_CONCURRENT_LOW_MEMORY: 2,
  STREAMING_BUFFER_SIZE: 1024 * 10,
  PERSISTENT_CACHE_MAX: 500,
  PERSISTENT_CLEANUP_INTERVAL: 1000 * 60 * 30,
  MEMORY_CHECK_INTERVAL: 1000 * 60,
  SUGGEST_TTL: 1000 * 30,
  SUGGEST_DEBOUNCE_MS: 200,
};

let _config: Config = { ...defaults };

export function configure(overrides: Partial<Config> = {}): void {
  _config = { ...defaults, ...overrides };
}

export function getConfig(): Config {
  return _config;
}
