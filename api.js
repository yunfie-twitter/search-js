// api.js

const API_BASE = "https://api.wholphin.net";

// =======================
// 險ｭ螳�
// =======================
const CACHE_TTL = 1000 * 60 * 5;
const CACHE_MAX = 30; // 繝｡繝｢繝ｪ荳企剞繧貞､ｧ蟷�炎貂幢ｼ�L1繝�ぅ繧｢繝ｼ繝会ｼ�
const CACHE_LOW_MEMORY = 10; // 菴弱Γ繝｢繝ｪ譎ゅ�譛螟ｧ繧ｭ繝｣繝�す繝･
const MEMORY_PRESSURE_THRESHOLD_NORMAL = 0.65; // 豁｣蟶ｸ譎ゅ�髢ｾ蛟､��65%��
const MEMORY_PRESSURE_THRESHOLD_CRITICAL = 0.80; // 蜊ｱ髯ｺ豌ｴ蝓滂ｼ�80%��
const STRINGIFY_SIZE_THRESHOLD = 1024 * 10; // 10KB莉･荳翫� stringification 繧ｹ繧ｭ繝��
const TIMEOUT = 8000;
const RETRIES = 3;
const PRIORITY_SUGGEST = 0;
const PRIORITY_SEARCH = 1;
const PRIORITY_PREFETCH = 2;
const MEMORY_CHECK_INTERVAL = 1000 * 60; // 1蛻�
const STREAMING_BUFFER_SIZE = 1024 * 10;
const MAX_CONCURRENT_REQUESTS = 6;
const RETRY_BACKOFF_BASE = 1000;
const PERSISTENT_CLEANUP_INTERVAL = 1000 * 60 * 30;
const GC_PRESSURE_CHECK_INTERVAL = 1000 * 10; // 10遘偵＃縺ｨ縺ｫGC蝨ｧ繧偵メ繧ｧ繝�け

// =======================
// 繝｡繝｢繝ｪ繧ｭ繝｣繝�す繝･縺ｨ繝悶Λ繧ｦ繧ｶ讖溯�讀懷�
// =======================
const cache = new Map(); // JSON譁�ｭ怜�縺ｨ縺励※菫晏ｭ假ｼ�L1繝�ぅ繧｢繝ｼ繝会ｼ�
const browserCapabilities = {
    abortController: typeof AbortController !== 'undefined',
    readableStream: typeof ReadableStream !== 'undefined',
    performanceMemory: typeof performance !== 'undefined' && performance.memory,
    weakRef: typeof WeakRef !== 'undefined',
    finalizationRegistry: typeof FinalizationRegistry !== 'undefined',
    deviceMemory: typeof navigator !== 'undefined' && navigator.deviceMemory
};

// =======================
// In-flight 繝ｪ繧ｯ繧ｨ繧ｹ繝育ｵｱ蜷茨ｼ�deduplication��
// =======================
const inFlightRequests = new Map(); // key -> Promise

// =======================
// IndexedDB豌ｸ邯壹く繝｣繝�す繝･�医が繝励す繝ｧ繝ｳ + LRU��
// =======================
let dbPromise = null;
const PERSISTENT_CACHE_MAX = 500; // IndexedDB譛螟ｧ繧ｨ繝ｳ繝医Μ謨ｰ

function initIndexedDB() {
    if (!window.indexedDB || dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('ApiCache', 2); // 繝舌�繧ｸ繝ｧ繝ｳ繧｢繝��

        request.onerror = () => {
            console.warn('IndexedDB not available');
            resolve(null);
        };

        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('cache')) {
                const store = db.createObjectStore('cache');
                store.createIndex('time', 'time');
            }
        };
    });

    return dbPromise;
}

async function getPersistentCache(key) {
    const db = await initIndexedDB();
    if (!db) return null;

    return new Promise((resolve) => {
        const transaction = db.transaction(['cache'], 'readonly');
        const store = transaction.objectStore('cache');
        const request = store.get(key);

        request.onsuccess = () => {
            const item = request.result;
            if (item && Date.now() - item.time < CACHE_TTL) {
                resolve(item.data);
            } else {
                resolve(null);
            }
        };

        request.onerror = () => resolve(null);
    });
}

async function setPersistentCache(key, data) {
    const db = await initIndexedDB();
    if (!db) return;

    return new Promise((resolve) => {
        const transaction = db.transaction(['cache'], 'readwrite');
        const store = transaction.objectStore('cache');
        const index = store.index('time');

        // LRU: 蜿､縺�お繝ｳ繝医Μ縺九ｉ蜑企勁�域怙螟ｧ謨ｰ雜�℃譎ゅ�縺ｿ��
        const countRequest = store.count();
        countRequest.onsuccess = () => {
            if (countRequest.result >= PERSISTENT_CACHE_MAX) {
                // 蜿､縺�ｂ縺ｮ縺九ｉ譛螟ｧ100莉ｶ蜑企勁
                const range = IDBKeyRange.lowerBound(0, false);
                const cursorRequest = index.openCursor(range);
                let deleted = 0;
                const maxDelete = Math.ceil(PERSISTENT_CACHE_MAX * 0.2); // 20%蜑企勁

                cursorRequest.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor && deleted < maxDelete) {
                        cursor.delete();
                        deleted++;
                        cursor.continue();
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

// IndexedDB繧ｯ繝ｪ繝ｼ繝ｳ繧｢繝���亥商縺�お繝ｳ繝医Μ蜑企勁��
async function cleanupPersistentCache() {
    const db = await initIndexedDB();
    if (!db) return;

    const transaction = db.transaction(['cache'], 'readwrite');
    const store = transaction.objectStore('cache');
    const index = store.index('time');
    const cutoff = Date.now() - CACHE_TTL;

    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);

    request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
            cursor.delete();
            cursor.continue();
        }
    };
}

// 螳壽悄繧ｯ繝ｪ繝ｼ繝ｳ繧｢繝����30蛻�＃縺ｨ��
setInterval(cleanupPersistentCache, PERSISTENT_CLEANUP_INTERVAL);

let isLowMemory = false;
let currentCacheMax = CACHE_MAX;
let deviceMemoryGb = 8; // 繝�ヵ繧ｩ繝ｫ繝�8GB

// 繝�ヰ繧､繧ｹ繝｡繝｢繝ｪ蛻晄悄蛹�
if (browserCapabilities.deviceMemory) {
    deviceMemoryGb = navigator.deviceMemory;
    // 繝ｭ繝ｼ繧ｨ繝ｳ繝臥ｫｯ譛ｫ��2GB莉･荳具ｼ峨�蝣ｴ蜷医∵怙蛻昴°繧峨く繝｣繝�す繝･繧堤ｵ槭ｋ
    if (deviceMemoryGb <= 2) {
        currentCacheMax = CACHE_LOW_MEMORY;
    }
}

// 繝｡繝｢繝ｪ菴ｿ逕ｨ驥上メ繧ｧ繝�け�郁､�粋蛻､螳夲ｼ�
function checkMemoryUsage() {
    let pressureLevel = 0; // 0-100

    // 1. performance.memory 縺ｫ繧医ｋ蛻､螳夲ｼ�V8��
    if (browserCapabilities.performanceMemory) {
        const mem = performance.memory;
        const usedPercent = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
        pressureLevel = Math.max(pressureLevel, usedPercent * 100);
    }

    // 2. 繧ｭ繝｣繝�す繝･繧ｵ繧､繧ｺ雜�℃縺ｫ繧医ｋ蛻､螳�
    if (cache.size > currentCacheMax * 0.85) {
        pressureLevel = Math.max(pressureLevel, 65);
    }

    // 蛻､螳壹Ο繧ｸ繝�け
    const oldLowMemory = isLowMemory;
    isLowMemory = pressureLevel > MEMORY_PRESSURE_THRESHOLD_NORMAL;

    // 髢ｾ蛟､雜�℃譎ゅ�繧ｭ繝｣繝�す繝･蜑頑ｸ�
    if (isLowMemory && currentCacheMax > CACHE_LOW_MEMORY) {
        const targetSize = pressureLevel > MEMORY_PRESSURE_THRESHOLD_CRITICAL
            ? Math.ceil(CACHE_LOW_MEMORY * 0.5) // 蜊ｱ髯ｺ豌ｴ蝓溘↑繧�50%蜑頑ｸ�
            : CACHE_LOW_MEMORY;
        trimCacheToSize(targetSize);
        currentCacheMax = targetSize;
    } else if (!isLowMemory && currentCacheMax < CACHE_MAX && oldLowMemory) {
        // 蝗槫ｾｩ譎ゅ�谿ｵ髫守噪縺ｫ蠕ｩ蟶ｰ
        currentCacheMax = Math.min(CACHE_MAX, Math.ceil(currentCacheMax * 1.5));
    }
}

// 繧ｭ繝｣繝�す繝･繧呈欠螳壹し繧､繧ｺ縺ｫ蜑頑ｸ�
function trimCacheToSize(maxSize) {
    while (cache.size > maxSize) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
}

// 繝｡繝｢繝ｪ繝√ぉ繝�け縺ｯ enqueue譎ゅ�縺ｿ�亥ｮ壽悄繝√ぉ繝�け縺ｯ蟒�ｭ｢��

function getCacheKey(endpoint, params) {
    return endpoint + "?" + new URLSearchParams(params).toString();
}

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;

    const isExpired = Date.now() - item.time > CACHE_TTL;

    // LRU譖ｴ譁ｰ
    cache.delete(key);
    cache.set(key, item);

    // JSON譁�ｭ怜�繧偵Γ繝｢蛹悶ヱ繝ｼ繧ｹ�亥�蝗槭�縺ｿ JSON.parse��
    if (typeof item.data === 'string' && !item.parsed) {
        item.parsed = JSON.parse(item.data);
    }

    return {
        data: item.parsed || item.data,
        expired: isExpired
    };
}

function setCache(key, data) {
    // 譌｢蟄倥お繝ｳ繝医Μ繧貞炎髯､�磯��ｺ乗峩譁ｰ縺ｮ縺溘ａ��
    if (cache.has(key)) {
        cache.delete(key);
    }

    // 繧ｵ繧､繧ｺ雜�℃譎ゅ�譛繧ょ商縺�お繝ｳ繝医Μ繧貞炎髯､
    if (cache.size >= currentCacheMax) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }

    // 譚｡莉ｶ莉倥″ stringify�亥､ｧ縺阪＞繝��繧ｿ縺ｯ raw object 縺ｧ菫晏ｭ假ｼ�
    let cacheItem = {
        time: Date.now()
    };

    if (typeof data === 'string') {
        cacheItem.data = data;
    } else {
        // 繝��繧ｿ繧ｵ繧､繧ｺ繝√ぉ繝�け�育ｰ｡譏鍋沿�哽SON length 縺ｧ蛻､螳夲ｼ�
        const jsonStr = JSON.stringify(data);
        if (jsonStr.length < STRINGIFY_SIZE_THRESHOLD) {
            // 蟆上＆縺�ョ繝ｼ繧ｿ縺ｯ stringify�医Γ繝｢繝ｪ蜉ｹ邇�ｼ�
            cacheItem.data = jsonStr;
        } else {
            // 螟ｧ縺阪＞繝��繧ｿ縺ｯ raw object��CPU蜉ｹ邇�ｼ�
            cacheItem.data = data;
        }
    }

    cache.set(key, cacheItem);
}

// =======================
// Abort邂｡逅�ｼ�key蛻･��
// =======================
const controllers = new Map();

function getRequestKey(endpoint, params) {
    // endpoint + q + page + type 縺ｧ螳悟�縺ｪ荳諢乗ｧ繧堤｢ｺ菫�
    const { q, page, type } = params;
    return `${endpoint}?q=${encodeURIComponent(q || "")}&page=${page || 1}&type=${type || "web"}`;
}

function cancelRequest(key) {
    const controller = controllers.get(key);
    if (controller) {
        controller.abort();
        controllers.delete(key);
    }
}

// =======================
// 繝ｪ繧ｯ繧ｨ繧ｹ繝医く繝･繝ｼ�亥━蜈亥ｺｦ蛻ｶ蠕｡ + 邁｡譏薙ヲ繝ｼ繝暦ｼ�
// =======================
const requestQueueHighPriority = []; // suggest 縺ｪ縺ｩ譛鬮伜━蜈亥ｺｦ
const requestQueueNormal = [];       // search 縺ｪ縺ｩ騾壼ｸｸ蜆ｪ蜈亥ｺｦ
const requestQueueLow = [];          // prefetch 縺ｪ縺ｩ菴主━蜈亥ｺｦ
const MAX_QUEUE_SIZE = 20;
const MAX_QUEUE_LOW_MEMORY = 10;
let activeRequests = 0;

function enqueueRequest(requestFn, priority) {
    // 繝｡繝｢繝ｪ繝√ぉ繝�け縺ｯ enqueue譎ゅ�縺ｿ
    checkMemoryUsage();

    const maxQueueSize = isLowMemory ? MAX_QUEUE_LOW_MEMORY : MAX_QUEUE_SIZE;
    const totalQueued = requestQueueHighPriority.length + requestQueueNormal.length + requestQueueLow.length;

    // 繧ｭ繝･繝ｼ繧ｷ繧ｹ繝�Β縺後＞縺｣縺ｱ縺�↑繧我ｽ主━蜈亥ｺｦ縺九ｉ蜑企勁
    if (totalQueued >= maxQueueSize) {
        if (requestQueueLow.length > 0) {
            requestQueueLow.pop();
        } else if (requestQueueNormal.length > 0) {
            requestQueueNormal.pop();
        }
    }

    // 蜆ｪ蜈亥ｺｦ蛻･縺ｫ謖ｯ繧雁�縺托ｼ�O(1)��
    if (priority === PRIORITY_SUGGEST) {
        requestQueueHighPriority.push(requestFn);
    } else if (priority === PRIORITY_PREFETCH) {
        requestQueueLow.push(requestFn);
    } else {
        requestQueueNormal.push(requestFn);
    }

    processQueue();
}

async function processQueue() {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) return;

    const hasQueue = requestQueueHighPriority.length > 0 ||
                     requestQueueNormal.length > 0 ||
                     requestQueueLow.length > 0;

    if (!hasQueue) return;

    while (activeRequests < MAX_CONCURRENT_REQUESTS) {
        let requestFn = null;

        // 蜆ｪ蜈亥ｺｦ鬆�↓蜿門ｾ�
        if (requestQueueHighPriority.length > 0) {
            requestFn = requestQueueHighPriority.shift();
        } else if (requestQueueNormal.length > 0) {
            requestFn = requestQueueNormal.shift();
        } else if (requestQueueLow.length > 0) {
            requestFn = requestQueueLow.shift();
        } else {
            break;
        }

        activeRequests++;

        // 荳ｦ蛻怜ｮ溯｡�
        requestFn().catch(e => {
            console.error("Queue processing error:", e);
        }).finally(() => {
            activeRequests--;
            queueMicrotask(processQueue);
        });
    }
}

// =======================
// fetch��retry + timeout + streaming + fallback + 繝舌ャ繧ｯ繧ｪ繝包ｼ�
// =======================
async function fetchWithRetry(url, options, key, onChunk) {
    // 繧ｹ繝医Μ繝ｼ繝溘Φ繧ｰ蟇ｾ蠢懊メ繧ｧ繝�け
    const supportsStreaming = browserCapabilities.readableStream && onChunk;

    for (let attempt = 0; attempt <= RETRIES; attempt++) {

        const controller = browserCapabilities.abortController ? new AbortController() : null;
        const timeoutId = setTimeout(() => {
            if (controller) controller.abort();
        }, TIMEOUT);

        if (controller) controllers.set(key, controller);

        try {
            const fetchOptions = controller ? {
                ...options,
                signal: controller.signal
            } : options;

            const res = await fetch(url, fetchOptions);

            clearTimeout(timeoutId);
            if (controller) {
                controllers.delete(key);
                // AbortController 縺ｮ遒ｺ螳溘↑GC�医う繝吶Φ繝医Μ繧ｹ繝翫�蜿ら�繧貞�繧具ｼ�
                controller.signal.onabort = null;
            }

            if (!res.ok) {
                return {
                    ok: false,
                    error: res.status >= 500 ? "server_error" : "client_error",
                    status: res.status
                };
            }

            if (supportsStreaming && res.body) {
                // 繧ｹ繝医Μ繝ｼ繝溘Φ繧ｰ蜃ｦ逅�ｼ医Γ繝｢繝ｪ蜉ｹ邇�喧 + 蝣�欧蛹� + Abort蟇ｾ蠢懶ｼ�
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let braceCount = 0;
                let inString = false;
                let escaped = false;
                let isAborted = false;
                const chunks = []; // 繝��繧ｿ繧帝寔繧√ｋ

                let abortHandler = () => {
                    isAborted = true;
                    reader.cancel();
                };

                if (controller) {
                    controller.signal.addEventListener('abort', abortHandler);
                }

                try {
                    while (!isAborted) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunk = decoder.decode(value, { stream: true });
                        buffer += chunk;

                        // 繝舌ャ繝輔ぃ繧ｵ繧､繧ｺ蛻ｶ髯�
                        if (buffer.length > STREAMING_BUFFER_SIZE) {
                            processBuffer();
                        }
                    }

                    if (!isAborted) {
                        // 譛蠕後�繝舌ャ繝輔ぃ繧貞�逅�
                        processBuffer();
                    }

                    function processBuffer() {
                        let start = 0;
                        for (let i = 0; i < buffer.length; i++) {
                            const char = buffer[i];

                            if (escaped) {
                                escaped = false;
                                continue;
                            }

                            if (char === '\\') {
                                escaped = true;
                                continue;
                            }

                            if (char === '"') {
                                inString = !inString;
                                continue;
                            }

                            if (inString) continue;

                            if (char === '{') {
                                if (braceCount === 0) start = i;
                                braceCount++;
                            } else if (char === '}') {
                                braceCount--;
                                if (braceCount === 0) {
                                    // 螳悟�縺ｪJSON繧ｪ繝悶ず繧ｧ繧ｯ繝医′隕九▽縺九▲縺�
                                    const jsonStr = buffer.slice(start, i + 1);
                                    buffer = buffer.slice(i + 1);
                                    i = -1; // 繝ｫ繝ｼ繝励ｒ繝ｪ繧ｻ繝�ヨ

                                    try {
                                        const chunk = JSON.parse(jsonStr);
                                        chunks.push(chunk); // 繝��繧ｿ繧帝寔繧√ｋ
                                        if (onChunk) onChunk(chunk); // 譌｢蟄倥�繧ｳ繝ｼ繝ｫ繝舌ャ繧ｯ繧ょ他縺ｶ
                                    } catch (e) {
                                        console.warn("Invalid JSON chunk:", jsonStr);
                                    }
                                }
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                    if (controller) {
                        controller.signal.removeEventListener('abort', abortHandler);
                        abortHandler = null; // GC遒ｺ菫�
                    }
                }

                // 繝��繧ｿ繧偵∪縺ｨ繧√※霑斐☆�亥腰荳縺ｮ蝣ｴ蜷医�縺昴�縺ｾ縺ｾ縲∬､�焚蝣ｴ蜷医�驟榊���
                const data = chunks.length === 1 ? chunks[0] : chunks;
                return { ok: true, data, streamed: true };
            } else {
                // 繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ�夐壼ｸｸ縺ｮJSON繝ｬ繧ｹ繝昴Φ繧ｹ
                const data = await res.json();
                return { ok: true, data };
            }

        } catch (err) {
            clearTimeout(timeoutId);
            if (controller) {
                controllers.delete(key);
                controller.signal.onabort = null; // GC遒ｺ菫�
            }

            if (err.name === "AbortError" || err.message?.includes("aborted")) {
                return { ok: false, error: "cancelled" };
            }

            if (err instanceof TypeError) {
                if (attempt === RETRIES) {
                    return { ok: false, error: "network_error" };
                }
                // 謖�焚繝舌ャ繧ｯ繧ｪ繝�
                const backoffDelay = RETRY_BACKOFF_BASE * Math.pow(2, attempt);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                continue;
            }

            return { ok: false, error: "unknown_error" };
        }
    }
}

// =======================
// request��SWR蟇ｾ蠢� + priority + streaming + 豌ｸ邯壹く繝｣繝�す繝･��
// =======================
async function request(endpoint, params = {}, useCache = true, priority = PRIORITY_SEARCH, onChunk, usePersistentCache = false) {
    const url = new URL(API_BASE + endpoint);

    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
            url.searchParams.append(k, v);
        }
    });

    const cacheKey = getCacheKey(endpoint, params);
    const requestKey = getRequestKey(endpoint, params);

    // ===================
    // stale-while-revalidate + 豌ｸ邯壹く繝｣繝�す繝･
    // ===================
    if (useCache) {
        const cached = getCache(cacheKey);

        if (cached) {
            // 繝舌ャ繧ｯ繧ｰ繝ｩ繧ｦ繝ｳ繝画峩譁ｰ��expired縺ｪ繧会ｼ�
            if (cached.expired) {
                enqueueRequest(() => fetchWithRetry(url.toString(), {
                    method: "GET",
                    headers: { "Accept": "application/json" }
                }, requestKey).then(async (res) => {
                    if (res.ok) {
                        setCache(cacheKey, res.data);
                        if (usePersistentCache) await setPersistentCache(cacheKey, res.data);
                    }
                }), priority);
            }

            return {
                ok: true,
                data: cached.data,
                cached: true,
                stale: cached.expired
            };
        }

        // 豌ｸ邯壹く繝｣繝�す繝･繝√ぉ繝�け
        if (usePersistentCache) {
            const persistentData = await getPersistentCache(cacheKey);
            if (persistentData) {
                setCache(cacheKey, persistentData); // 繝｡繝｢繝ｪ繧ｭ繝｣繝�す繝･縺ｫ繧ょ�繧後ｋ
                return {
                    ok: true,
                    data: persistentData,
                    cached: true,
                    persistent: true
                };
            }
        }
    }

    // ===================================
    // In-flight deduplication�亥酔譎ゅΜ繧ｯ繧ｨ繧ｹ繝育ｵｱ蜷茨ｼ�
    // ===================================
    if (inFlightRequests.has(requestKey)) {
        return inFlightRequests.get(requestKey);
    }

    const fetchPromise = new Promise((resolve, reject) => {
        enqueueRequest(async () => {
            // 螳溯｡御ｸｭ縺ｮ繝ｪ繧ｯ繧ｨ繧ｹ繝医□縺代く繝｣繝ｳ繧ｻ繝ｫ
            if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
                cancelRequest(requestKey);
            }

            try {
                const result = await fetchWithRetry(url.toString(), {
                    method: "GET",
                    headers: { "Accept": "application/json" }
                }, requestKey, onChunk);

                if (result.ok && useCache && !result.streamed) {
                    setCache(cacheKey, result.data);
                    if (usePersistentCache) await setPersistentCache(cacheKey, result.data);
                }

                resolve(result);
            } catch (e) {
                reject(e);
            } finally {
                inFlightRequests.delete(requestKey);
            }
        }, priority);
    });

    inFlightRequests.set(requestKey, fetchPromise);
    return fetchPromise;
}

// =======================
// debounce�医Γ繝｢繝ｪ蜉ｹ邇�喧 + callback蟇ｾ蠢懶ｼ�
// =======================
export function debounce(fn, delay = 300, usePromise = true) {
    let timer;

    if (usePromise) {
        return (...args) => {
            clearTimeout(timer);

            // 菴弱Γ繝｢繝ｪ譎ゅ�delay繧�2蛟阪↓
            const actualDelay = isLowMemory ? delay * 2 : delay;

            return new Promise((resolve, reject) => {
                timer = setTimeout(async () => {
                    try {
                        resolve(await fn(...args));
                    } catch (e) {
                        reject(e);
                    }
                }, actualDelay);
            });
        };
    } else {
        // callback蝙�
        return (...args) => {
            clearTimeout(timer);

            const actualDelay = isLowMemory ? delay * 2 : delay;

            timer = setTimeout(() => {
                fn(...args);
            }, actualDelay);
        };
    }
}

// =======================
// prefetch�域ｬ｡繝壹�繧ｸ蜈郁ｪｭ縺ｿ + 譚｡莉ｶ蠑ｷ蛹厄ｼ�
// =======================
function prefetch(endpoint, params) {
    // 菴弱Γ繝｢繝ｪ譎ゅ�繧ｹ繧ｭ繝��
    if (isLowMemory) return;

    // 繧ｭ繝･繝ｼ縺梧里縺ｫ縺�▲縺ｱ縺�↑繧� prefetch 繧ゅせ繧ｭ繝��
    const totalQueued = requestQueueHighPriority.length + requestQueueNormal.length + requestQueueLow.length;
    if (totalQueued >= MAX_QUEUE_SIZE) return;

    const cacheKey = getCacheKey(endpoint, params);
    const cached = getCache(cacheKey);

    // 繧ｭ繝｣繝�す繝･縺悟ｭ伜惠縺励※譁ｰ縺励￠繧後�繧ｹ繧ｭ繝��
    if (cached && !cached.expired) return;

    // 譌｢縺ｫ in-flight 縺ｪ繧蛾㍾隍�Μ繧ｯ繧ｨ繧ｹ繝医�驕ｿ縺代ｋ
    const requestKey = getRequestKey(endpoint, params);
    if (inFlightRequests.has(requestKey)) return;

    // 繝舌ャ繧ｯ繧ｰ繝ｩ繧ｦ繝ｳ繝峨〒prefetch�井ｽ主━蜈亥ｺｦ��
    request(endpoint, params, true, PRIORITY_PREFETCH).catch(e => {
        console.warn("Prefetch failed:", e);
    });
}

// =======================
// API
// =======================
export async function search({
    q,
    page = 1,
    type = "web",
    safesearch = 0,
    lang = "ja",
    enableStreaming = false,
    onChunk,
    usePersistentCache = false
}) {
    if (!q || !q.trim()) {
        return { ok: false, error: "empty_query" };
    }

    const params = {
        q: q.trim(),
        page,
        type,
        safesearch,
        lang
    };

    // 菴弱Γ繝｢繝ｪ譎ゅ�繧ｹ繝医Μ繝ｼ繝溘Φ繧ｰ繧堤┌蜉ｹ蛹�
    const actualStreaming = enableStreaming && !isLowMemory;

    // prefetch谺｡縺ｮ繝壹�繧ｸ��type縺茎uggest莉･螟悶�蝣ｴ蜷医∽ｽ弱Γ繝｢繝ｪ譎ゅ�繧ｹ繧ｭ繝����
    if (type !== "suggest" && page < 10 && !isLowMemory) {
        prefetch("/search", { ...params, page: page + 1 });
    }

    return request("/search", params, true, type === "suggest" ? PRIORITY_SUGGEST : PRIORITY_SEARCH, actualStreaming ? onChunk : null, usePersistentCache);
}

// =======================
// 繧ｿ繧､繝怜挨
// =======================
export const searchWeb = (q, page = 1) =>
    search({ q, page, type: "web" });

export const searchImage = (q, page = 1) =>
    search({ q, page, type: "image" });

export const searchVideo = (q, page = 1) =>
    search({ q, page, type: "video" });

export const searchNews = (q, page = 1) =>
    search({ q, page, type: "news" });

export const getSuggest = (q) =>
    search({ q, type: "suggest", page: 1 });

export const searchPanel = (q) =>
    search({ q, type: "panel", page: 1 });

// =======================
// 螟夜Κ蛻ｶ蠕｡
// =======================
export { cancelRequest };
