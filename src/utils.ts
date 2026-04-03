// src/utils.ts
import { getIsLowMemory } from "./memory.js";

type AnyFunction = (...args: unknown[]) => unknown;

export function debounce<T extends AnyFunction>(
  fn: T,
  delay = 300,
  usePromise = true
): (...args: Parameters<T>) => usePromise extends true ? Promise<ReturnType<T>> : void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (usePromise) {
    return ((...args: Parameters<T>) => {
      clearTimeout(timer);
      const d = getIsLowMemory() ? delay * 2 : delay;
      return new Promise<ReturnType<T>>((res, rej) => {
        timer = setTimeout(async () => {
          try {
            res(await (fn(...args) as Promise<ReturnType<T>>));
          } catch (e) {
            rej(e);
          }
        }, d);
      });
    }) as ReturnType<typeof debounce<T>>;
  }

  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), getIsLowMemory() ? delay * 2 : delay);
  }) as ReturnType<typeof debounce<T>>;
}
