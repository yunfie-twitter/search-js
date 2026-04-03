// src/config.ts

export interface Config {
  API_BASE: string;
  /** メモリキャッシュの TTL (ms) */
  CACHE_TTL: number;
  /** 通常時のメモリキャッシュ上限エントリ数 */
  CACHE_MAX: number;
  /** LowMemory 時のメモリキャッシュ上限エントリ数 */
  CACHE_LOW_MEMORY: number;
  /** この割合 (0-1) を超えたら LowMemory と判定 */
  MEMORY_PRESSURE_NORMAL: number;
  /** この割合 (0-1) を超えたら Critical と判定し積極的にキャッシュを削減 */
  MEMORY_PRESSURE_CRITICAL: number;
  /** この文字数以下の JSON は文字列として保持（遅延パース用） */
  STRINGIFY_SIZE_THRESHOLD: number;
  /** fetch タイムアウト (ms) */
  TIMEOUT: number;
  /** リトライ回数 */
  RETRIES: number;
  /** リトライ初期ウェイト (ms)、指数バックオフで逓増 */
  RETRY_BACKOFF_BASE: number;
  /** 通常時の最大同時リクエスト数 */
  MAX_CONCURRENT_REQUESTS: number;
  /** LowMemory 時の最大同時リクエスト数 */
  MAX_CONCURRENT_LOW_MEMORY: number;
  /** ストリーミングバッファ上限 (bytes) */
  STREAMING_BUFFER_SIZE: number;
  /** 永続キャッシュ最大エントリ数 */
  PERSISTENT_CACHE_MAX: number;
  /** 永続キャッシュ定期クリーンアップ間隔 (ms) */
  PERSISTENT_CLEANUP_INTERVAL: number;
  /** メモリ圧力チェック間隔 (ms) */
  MEMORY_CHECK_INTERVAL: number;
}

export const defaults: Config = {
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
  MAX_CONCURRENT_LOW_MEMORY: 2,
  STREAMING_BUFFER_SIZE: 1024 * 10,
  PERSISTENT_CACHE_MAX: 500,
  PERSISTENT_CLEANUP_INTERVAL: 1000 * 60 * 30,
  MEMORY_CHECK_INTERVAL: 1000 * 60,
};

let _config: Config = { ...defaults };

export function configure(overrides: Partial<Config> = {}): void {
  _config = { ...defaults, ...overrides };
}

export function getConfig(): Config {
  return _config;
}
