// src/utils.js
import { getIsLowMemory } from "./memory.js";

export function debounce(fn, delay = 300, usePromise = true) {
  let timer;

  if (usePromise) {
    return (...args) => {
      clearTimeout(timer);
      const d = getIsLowMemory() ? delay * 2 : delay;
      return new Promise((res, rej) => {
        timer = setTimeout(async () => {
          try { res(await fn(...args)); } catch (e) { rej(e); }
        }, d);
      });
    };
  }

  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), getIsLowMemory() ? delay * 2 : delay);
  };
}
