// src/events.ts
// 軽量イベントエミッター（完全版）

export type SearchEventMap = {
  memoryStateChange: { isLow: boolean; isCritical: boolean };
  online: undefined;
  offline: undefined;
  cacheRefreshed: { key: string };
};

type Handler<T> = T extends undefined
  ? () => void
  : (payload: T) => void;

type ListenerEntry<T> = {
  fn: Handler<T>;
  once: boolean;
};

type Listeners = {
  [K in keyof SearchEventMap]: Set<ListenerEntry<SearchEventMap[K]>>;
};

const _listeners: Listeners = {
  memoryStateChange: new Set(),
  online: new Set(),
  offline: new Set(),
  cacheRefreshed: new Set(),
};

// ---- subscribe ----
export function on<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): () => void {
  const entry: ListenerEntry<SearchEventMap[K]> = {
    fn: handler,
    once: false,
  };

  _listeners[event].add(entry);

  // unsubscribe関数
  return () => off(event, handler);
}

// ---- once ----
export function once<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): () => void {
  const entry: ListenerEntry<SearchEventMap[K]> = {
    fn: handler,
    once: true,
  };

  _listeners[event].add(entry);

  return () => off(event, handler);
}

// ---- unsubscribe ----
export function off<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): void {
  const set = _listeners[event];

  for (const entry of set) {
    if (entry.fn === handler) {
      set.delete(entry);
    }
  }
}

// ---- emit ----
export function emit<K extends keyof SearchEventMap>(
  event: K,
  ...args: SearchEventMap[K] extends undefined
    ? []
    : [SearchEventMap[K]]
): void {
  const set = _listeners[event];

  // snapshot（安全）
  const snapshot = [...set];

  for (const entry of snapshot) {
    try {
      if (args.length === 0) {
        (entry.fn as () => void)();
      } else {
        (entry.fn as (payload: SearchEventMap[K]) => void)(args[0]);
      }
    } catch (e) {
      console.error("[search-js] event handler error:", e);
    }

    // once処理
    if (entry.once) {
      set.delete(entry);
    }
  }
}

// ---- utils ----
export function listenerCount<K extends keyof SearchEventMap>(
  event: K
): number {
  return _listeners[event].size;
}

export function clearAllListeners(): void {
  for (const key of Object.keys(_listeners) as (keyof SearchEventMap)[]) {
    _listeners[key].clear();
  }
}
