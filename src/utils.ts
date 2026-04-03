// src/utils.ts
import { getIsLowMemory } from "./memory.js";

// AnyFunction は内部型のみ。外部引数は T extends (...args: never[]) => unknown で表現
type AnyFunction = (...args: never[]) => unknown;

interface DebounceOptions {
  delay?: number;
  leading?: boolean;
  trailing?: boolean;
  usePromise?: boolean;
}

export function debounce<T extends AnyFunction>(
  fn: T,
  options: DebounceOptions | number = {}
) {
  const opts: DebounceOptions =
    typeof options === "number" ? { delay: options } : options;

  const {
    delay = 300,
    leading = false,
    trailing = true,
    usePromise = true,
  } = opts;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: Parameters<T> | undefined;
  let pending:
    | { resolve: (v: ReturnType<T>) => void; reject: (e: unknown) => void }
    | undefined;

  const getDelay = (): number => (getIsLowMemory() ? delay * 2 : delay);

  const execute = async (): Promise<ReturnType<T>> => {
    if (!lastArgs) return undefined as ReturnType<T>;
    try {
      const result = await (fn as (...a: Parameters<T>) => ReturnType<T>)(...lastArgs);
      pending?.resolve(result);
      return result;
    } catch (e) {
      pending?.reject(e);
      throw e;
    } finally {
      pending = undefined;
    }
  };

  const debounced = (...args: Parameters<T>): Promise<ReturnType<T>> | void => {
    lastArgs = args;
    const shouldCallNow = leading && !timer;
    if (timer) clearTimeout(timer);

    if (shouldCallNow) {
      if (usePromise) {
        return Promise.resolve(
          (fn as (...a: Parameters<T>) => ReturnType<T>)(...args)
        );
      }
      (fn as (...a: Parameters<T>) => unknown)(...args);
      return;
    }

    if (!trailing) return;

    if (usePromise) {
      return new Promise<ReturnType<T>>((resolve, reject) => {
        pending?.reject(new Error("debounced_cancelled"));
        pending = { resolve, reject };
        timer = setTimeout(() => {
          timer = undefined;
          void execute();
        }, getDelay());
      });
    }

    timer = setTimeout(() => {
      timer = undefined;
      void (fn as (...a: Parameters<T>) => unknown)(...(lastArgs as Parameters<T>));
    }, getDelay());
  };

  debounced.cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    pending?.reject(new Error("debounced_cancelled"));
    pending = undefined;
  };

  debounced.flush = (): Promise<ReturnType<T>> | undefined => {
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
