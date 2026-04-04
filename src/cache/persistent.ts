// src/cache/persistent.ts
import { getConfig } from "../config.js";

let _dbPromise: Promise<IDBDatabase | null> | null = null;
// [FREEZE fix] destroyDB 後に進行中の getP/setP が孤立した IDBTransaction を
// 開こうとするのを防ぐガードフラグ。destroy 後は即 null を返す。
let _destroyed = false;

function _open(): Promise<IDBDatabase | null> {
  if (_destroyed) return Promise.resolve(null);
  if (typeof globalThis.indexedDB === "undefined") return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;

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

/** IndexedDB から永続キャッシュを取得する。TTL 切れ・未存在は null を返す。 */
export async function getP(key: string): Promise<unknown> {
  const db = await _open();
  if (!db) return null;

  return new Promise<unknown>((resolve) => {
    const req = db
      .transaction(["cache"], "readonly")
      .objectStore("cache")
      .get(key);
    req.onsuccess = () => {
      const item = req.result as { time: number; data: unknown } | undefined;
      resolve(
        item && Date.now() - item.time < getConfig().CACHE_TTL ? item.data : null
      );
    };
    req.onerror = () => resolve(null);
  });
}

/** IndexedDB に永続キャッシュを書き込む。上限超過時は古いエントリを 20% 削除する。 */
export async function setP(key: string, data: unknown): Promise<void> {
  const db = await _open();
  if (!db) return;

  const cfg = getConfig();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["cache"], "readwrite");
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    const objectStore = tx.objectStore("cache");
    const countReq = objectStore.count();

    countReq.onsuccess = () => {
      if (countReq.result >= cfg.PERSISTENT_CACHE_MAX) {
        const maxDel = Math.ceil(cfg.PERSISTENT_CACHE_MAX * 0.2);
        const cur = objectStore.index("time").openCursor(IDBKeyRange.lowerBound(0));
        let deleted = 0;
        cur.onsuccess = (e: Event) => {
          const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (c && deleted < maxDel) {
            c.delete(); deleted++; c.continue();
          } else {
            tx.oncomplete = () => resolve();
            objectStore.put({ data, time: Date.now() }, key);
          }
        };
        cur.onerror = () => reject(cur.error);
      } else {
        tx.oncomplete = () => resolve();
        objectStore.put({ data, time: Date.now() }, key);
      }
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

/** TTL 切れエントリを IndexedDB から削除する。 */
export async function cleanup(): Promise<void> {
  const db = await _open();
  if (!db) return;
  const cfg = getConfig();
  const cutoff = Date.now() - cfg.CACHE_TTL;

  return new Promise<void>((resolve) => {
    const req = db
      .transaction(["cache"], "readwrite")
      .objectStore("cache")
      .index("time")
      .openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = (e: Event) => {
      const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (c) { c.delete(); c.continue(); }
      else resolve();
    };
    req.onerror = () => resolve();
  });
}

/** DB を閉じてリソースを解放する。destroy() から呼ぶこと。 */
export async function destroyDB(): Promise<void> {
  _destroyed = true;
  const db = await _open();
  db?.close();
  _dbPromise = null;
  // 次の init() で再利用できるようフラグをリセット
  _destroyed = false;
}
