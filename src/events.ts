// src/events.ts
// 軽量イベントエミッター

export type SearchEventMap = {
  memoryStateChange: { isLow: boolean; isCritical: boolean };
  online: undefined;
  offline: undefined;
  cacheRefreshed: { key: string };
};

type Handler<T> = T extends undefined ? () => void : (payload: T) => void;

type Listeners = {
  [K in keyof SearchEventMap]: Set<Handler<SearchEventMap[K]>>;
};

const _listeners: Listeners = {
  memoryStateChange: new Set(),
  online: new Set(),
  offline: new Set(),
  cacheRefreshed: new Set(),
};

export function on<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): () => void {
  (_listeners[event] as Set<Handler<SearchEventMap[K]>>).add(handler);
  return () => off(event, handler);
}

export function off<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): void {
  (_listeners[event] as Set<Handler<SearchEventMap[K]>>).delete(handler);
}

export function emit<K extends keyof SearchEventMap>(
  event: K,
  ...args: SearchEventMap[K] extends undefined ? [] : [SearchEventMap[K]]
): void {
  const set = _listeners[event] as Set<Handler<SearchEventMap[K]>>;
  // スナップショットでイテレートすることで、ハンドラ内での off() 呼び出しによる ConcurrentModification を防ぐ
  for (const fn of [...set]) {
    try {
      // @ts-expect-error payload は型安全だが TS が流を追えない
      fn(...args);
    } catch (e) {
      console.error("[search-js] event handler error:", e);
    }
  }
}

export function clearAllListeners(): void {
  for (const key of Object.keys(_listeners) as (keyof SearchEventMap)[]) {
    (_listeners[key] as Set<unknown>).clear();
  }
}
