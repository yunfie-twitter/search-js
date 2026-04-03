// src/cache/persistent.ts
import { getConfig } from "../config.js";

let _dbPromise: Promise<IDBDatabase | null> | null = null;

function _open(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB || _dbPromise) return _dbPromise ?? Promise.resolve(null);

  _dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open("ApiCache", 2);
    req.onerror = () => { console.warn("IndexedDB unavailable"); resolve(null); };
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e: IDBVersionChangeEvent) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("cache")) {
        db.createObjectStore("cache").createIndex("time", "time");
      }
    };
  });

  return _dbPromise;
}

export async function getP(key: string): Promise<unknown> {
  const db = await _open();
  if (!db) return null;

  return new Promise<unknown>((resolve) => {
    const req = db.transaction(["cache"], "readonly")
      .objectStore("cache").get(key);
    req.onsuccess = () => {
      const item = req.result as { time: number; data: unknown } | undefined;
      resolve(item && Date.now() - item.time < getConfig().CACHE_TTL
        ? item.data : null);
    };
    req.onerror = () => resolve(null);
  });
}

export async function setP(key: string, data: unknown): Promise<void> {
  const db = await _open();
  if (!db) return;

  const cfg = getConfig();
  return new Promise<void>((resolve) => {
    const tx = db.transaction(["cache"], "readwrite");
    const store = tx.objectStore("cache");
    const countReq = store.count();

    countReq.onsuccess = () => {
      if (countReq.result >= cfg.PERSISTENT_CACHE_MAX) {
        const maxDel = Math.ceil(cfg.PERSISTENT_CACHE_MAX * 0.2);
        const cur = store.index("time").openCursor(IDBKeyRange.lowerBound(0));
        let deleted = 0;
        cur.onsuccess = (e: Event) => {
          const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (c && deleted < maxDel) {
            c.delete();
            deleted++;
            c.continue();
          } else {
            store.put({ data, time: Date.now() }, key);
            resolve();
          }
        };
      } else {
        store.put({ data, time: Date.now() }, key);
        resolve();
      }
    };
  });
}

export async function cleanup(): Promise<void> {
  const db = await _open();
  if (!db) return;
  const cfg = getConfig();
  const cutoff = Date.now() - cfg.CACHE_TTL;
  const req = db.transaction(["cache"], "readwrite")
    .objectStore("cache").index("time")
    .openCursor(IDBKeyRange.upperBound(cutoff));
  req.onsuccess = (e: Event) => {
    const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (c) { c.delete(); c.continue(); }
  };
}
