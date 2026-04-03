// src/utils.ts
import { getIsLowMemory } from "./memory.ts";

type AnyFunction = (...args: unknown[]) => unknown;

interface DebounceOptions {
  delay?: number;
  leading?: boolean;
  trailing?: boolean;
  usePromise?: boolean;
}

export function debounce<T extends AnyFunction>(
  fn: T,
  options: DebounceOptions = {}
) {
  const {
    delay = 300,
    leading = false,
    trailing = true,
    usePromise = true,
  } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Parameters<T> | undefined;
  let pending:
    | {
        resolve: (v: ReturnType<T>) => void;
        reject: (e: unknown) => void;
      }
    | undefined;

  const getDelay = () =>
    getIsLowMemory() ? delay * 2 : delay;

  const execute = async (): Promise<ReturnType<T>> => {
    if (!lastArgs) return undefined as ReturnType<T>;

    try {
      const result = await fn(...lastArgs);
      pending?.resolve(result as ReturnType<T>);
      return result as ReturnType<T>;
    } catch (e) {
      pending?.reject(e);
      throw e;
    } finally {
      pending = undefined;
    }
  };

  const debounced = (...args: Parameters<T>) => {
    lastArgs = args;

    // ---- leading ----
    const shouldCallNow = leading && !timer;

    if (timer) clearTimeout(timer);

    if (shouldCallNow) {
      if (usePromise) {
        return Promise.resolve(fn(...args) as ReturnType<T>);
      } else {
        fn(...args);
        return;
      }
    }

    if (!trailing) return;

    const d = getDelay();

    if (usePromise) {
      return new Promise<ReturnType<T>>((resolve, reject) => {
        // 古いPromiseをreject（重要）
        pending?.reject(new Error("debounced_cancelled"));

        pending = { resolve, reject };

        timer = setTimeout(() => {
          timer = undefined;
          execute();
        }, d);
      });
    }

    timer = setTimeout(() => {
      timer = undefined;
      void fn(...(lastArgs as Parameters<T>));
    }, d);
  };

  // ---- cancel ----
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending?.reject(new Error("debounced_cancelled"));
    pending = undefined;
  };

  // ---- flush（即実行）----
  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    return execute();
  };

  return debounced as typeof debounced & {
    cancel: () => void;
    flush: () => Promise<ReturnType<T>> | undefined;
  };
}
