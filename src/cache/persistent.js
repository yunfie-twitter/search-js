// src/cache/persistent.js
import { getConfig } from "../config.js";

let _dbPromise = null;

function _open() {
  if (!globalThis.indexedDB || _dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve) => {
    const req = indexedDB.open("ApiCache", 2);
    req.onerror = () => { console.warn("IndexedDB unavailable"); resolve(null); };
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("cache")) {
        db.createObjectStore("cache").createIndex("time", "time");
      }
    };
  });

  return _dbPromise;
}

export async function getP(key) {
  const db = await _open();
  if (!db) return null;

  return new Promise((resolve) => {
    const req = db.transaction(["cache"], "readonly")
      .objectStore("cache").get(key);
    req.onsuccess = () => {
      const item = req.result;
      resolve(item && Date.now() - item.time < getConfig().CACHE_TTL
        ? item.data : null);
    };
    req.onerror = () => resolve(null);
  });
}

export async function setP(key, data) {
  const db = await _open();
  if (!db) return;

  const cfg = getConfig();
  return new Promise((resolve) => {
    const tx = db.transaction(["cache"], "readwrite");
    const store = tx.objectStore("cache");
    const countReq = store.count();

    countReq.onsuccess = () => {
      if (countReq.result >= cfg.PERSISTENT_CACHE_MAX) {
        const maxDel = Math.ceil(cfg.PERSISTENT_CACHE_MAX * 0.2);
        const cur = store.index("time").openCursor(IDBKeyRange.lowerBound(0));
        let deleted = 0;
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (c && deleted < maxDel) { c.delete(); deleted++; c.continue(); }
          else { store.put({ data, time: Date.now() }, key); resolve(); }
        };
      } else {
        store.put({ data, time: Date.now() }, key);
        resolve();
      }
    };
  });
}

export async function cleanup() {
  const db = await _open();
  if (!db) return;
  const cfg = getConfig();
  const cutoff = Date.now() - cfg.CACHE_TTL;
  const req = db.transaction(["cache"], "readwrite")
    .objectStore("cache").index("time")
    .openCursor(IDBKeyRange.upperBound(cutoff));
  req.onsuccess = (e) => {
    const c = e.target.result;
    if (c) { c.delete(); c.continue(); }
  };
}
