# API Reference

すべての公開 API の完全なシグネチャ・型定義・戻り値・注意事項です。

---

## 型定義

### `SearchType`

```ts
type SearchType = "web" | "image" | "video" | "news" | "panel";
```

> `"suggest"` は含まれません。サジェストは専用の `getSuggest()` / `getSuggestDebounced()` から呼びます。

---

### `FetchResult`

```ts
interface FetchResult {
  ok: boolean;          // 成功 / 失敗
  data?: unknown;       // API レスポンス本体（ok=true のとき）
  error?: string;       // エラーコード（ok=false のとき）
  status?: number;      // HTTP ステータスコード
  cached?: boolean;     // メモリキャッシュからの応答
  stale?: boolean;      // キャッシュが期限切れ（SWR 更新中）
  persistent?: boolean; // IndexedDB キャッシュからの応答
  streamed?: boolean;   // ストリーミングで取得した
}
```

**エラーコード一覧**

| `error` | 発生条件 |
|---|---|
| `"empty_query"` | `q` が空文字列 |
| `"offline"` | オフライン かつ キャッシュなし |
| `"cancelled"` | `AbortSignal` または `cancelRequest()` によるキャンセル |
| `"network_error"` | ネットワーク到達不可（リトライ上限後） |
| `"server_error"` | HTTP 5xx |
| `"client_error"` | HTTP 4xx |
| `"max_retries_exceeded"` | リトライ上限超過 |
| `"unknown_error"` | 予期せぬ例外 |

---

### `ResultMeta` / `ResultDetail`

タイプ別のメタ情報型。`extractMeta()` と `search({ metaOnly: true })` が返します。

```ts
interface BaseMeta {
  _idx: number;    // 元配列でのインデックス（fetchDetail の idx に使う）
  title?: string;
  url?: string;
}

interface WebMeta extends BaseMeta {
  summary?: string;
  favicon?: string;
}

interface ImageMeta extends BaseMeta {
  thumbnail?: string;
  domain?: string;
}

interface VideoMeta extends BaseMeta {
  thumbnail?: string;
  duration?: string;
  publishedDate?: string;
}

interface NewsMeta extends BaseMeta {
  summary?: string;
  favicon?: string;
  publishedDate?: string;
}

type ResultMeta = WebMeta | ImageMeta | VideoMeta | NewsMeta | BaseMeta;

// fetchDetail() が返す型: ResultMeta のすべてのフィールド + API 生データ
type ResultDetail = ResultMeta & { [key: string]: unknown };
```

**タイプ別の取得フィールド**

| `type` | 取得されるフィールド | `lowMemory` 時に省略 |
|---|---|---|
| `web` | `title`, `url`, `summary`, `favicon` | `summary` |
| `news` | `title`, `url`, `summary`, `favicon`, `publishedDate` | `summary` |
| `image` | `title`, `url`, `thumbnail`, `domain` | なし |
| `video` | `title`, `url`, `thumbnail`, `duration`, `publishedDate` | なし |

---

### `SuggestResult`

```ts
interface SuggestItem {
  title: string;
}

interface SuggestResult {
  ok: boolean;
  query: string;          // 元のクエリ文字列
  items: SuggestItem[];   // サジェスト候補
  cached?: boolean;       // キャッシュ（プレフィックス一致含む）から返した
  error?: string;
}
```

---

### `HistoryEntry`

```ts
interface HistoryEntry {
  q: string;      // 検索クエリ
  type: string;   // 検索タイプ（"web" など）
  time: number;   // Unix ミリ秒
}
```

---

### `SearchStats`

```ts
interface SearchStats {
  memoryCacheSize: number;  // 現在のキャッシュエントリ数
  memoryCacheMax: number;   // 現在の上限（メモリ状態で変動）
  isLowMemory: boolean;     // Low メモリ状態
  isCriticalMemory: boolean; // Critical メモリ状態
  inFlightCount: number;    // 進行中リクエスト数
  isOnline: boolean;        // ネットワーク到達可否
}
```

---

### `SearchEventMap`

```ts
type SearchEventMap = {
  memoryStateChange: { isLow: boolean; isCritical: boolean };
  online:            undefined;
  offline:           undefined;
  cacheRefreshed:    { key: string };
};
```

---

### `Pager`

```ts
interface Pager {
  next(): Promise<FetchResult | null>; // 次ページ。maxPage 到達で null
  prev(): Promise<FetchResult | null>; // 前ページ。先頭で null
  readonly currentPage: number;        // 現在のページ番号（0 = 未取得）
  reset(): void;                       // page=0 にリセット
}
```

---

### `Config`

`init()` に渡せるすべてのオプション。

```ts
interface Config {
  API_BASE: string;                   // デフォルト: "https://api.wholphin.net"
  CACHE_TTL: number;                  // デフォルト: 300_000 ms（5分）
  CACHE_MAX: number;                  // デフォルト: 30
  CACHE_LOW_MEMORY: number;           // デフォルト: 10（Low 時の上限）
  MEMORY_PRESSURE_NORMAL: number;     // デフォルト: 0.65（Low 閾値）
  MEMORY_PRESSURE_CRITICAL: number;   // デフォルト: 0.80（Critical 閾値）
  STRINGIFY_SIZE_THRESHOLD: number;   // デフォルト: 10240 bytes
  TIMEOUT: number;                    // デフォルト: 8_000 ms
  RETRIES: number;                    // デフォルト: 3
  RETRY_BACKOFF_BASE: number;         // デフォルト: 1_000 ms（指数バックオフの底）
  MAX_CONCURRENT_REQUESTS: number;    // デフォルト: 6
  MAX_CONCURRENT_LOW_MEMORY: number;  // デフォルト: 2
  STREAMING_BUFFER_SIZE: number;      // デフォルト: 10240 bytes
  PERSISTENT_CACHE_MAX: number;       // デフォルト: 500
  PERSISTENT_CLEANUP_INTERVAL: number;// デフォルト: 1_800_000 ms（30分）
  MEMORY_CHECK_INTERVAL: number;      // デフォルト: 60_000 ms（1分）
  SUGGEST_TTL: number;                // デフォルト: 30_000 ms（30秒）
  SUGGEST_DEBOUNCE_MS: number;        // デフォルト: 200 ms
}
```

---

## 初期化

### `init(options?: Partial<Config>): void`

ライブラリを初期化します。**アプリ起動時に一度だけ**呼んでください。

- メモリモニター・オフラインモニター・永続キャッシュのクリーンアップタイマーを起動します。
- 再度呼ぶと既存のタイマーを破棄してから再初期化します。

```ts
import { init } from "search-js";

init({
  API_BASE: "https://api.example.com",
  SUGGEST_TTL: 20_000,
  SUGGEST_DEBOUNCE_MS: 150,
});
```

---

### `destroy(): Promise<void>`

以下をすべて解放します。SPA のルートアンマウント時に呼んでください。

- 進行中のすべてのリクエストをキャンセル
- リクエストキューをクリア
- in-flight マップをクリア
- メモリキャッシュをクリア
- サジェストキャッシュをクリア
- イベントリスナーをすべて解除
- オフラインモニターを停止
- IndexedDB 接続を閉じる
- メモリモニタータイマーを停止
- 永続キャッシュクリーンアップタイマーを停止

```ts
await destroy();
```

---

## 検索

### `search(options: SearchOptions): Promise<FetchResult>`

汎用検索関数。

```ts
interface SearchOptions {
  q: string;                          // 検索クエリ（必須）
  type?: SearchType;                  // デフォルト: "web"
  page?: number;                      // デフォルト: 1
  safesearch?: 0 | 1 | 2;            // デフォルト: 0
  lang?: string;                      // デフォルト: "ja"
  metaOnly?: boolean;                 // デフォルト: false
  enableStreaming?: boolean;           // デフォルト: false
  onChunk?: (chunk: unknown) => void; // ストリーミング時コールバック
  usePersistentCache?: boolean;       // デフォルト: false
  signal?: AbortSignal;               // キャンセル用シグナル
}
```

**挙動のまとめ**

| 条件 | 挙動 |
|---|---|
| `q` が空 | 即座に `{ ok: false, error: "empty_query" }` を返す |
| メモリキャッシュヒット（有効期限内） | 即座にキャッシュを返す |
| メモリキャッシュヒット（期限切れ） | 古いデータを返しつつバックグラウンドで更新（SWR） |
| `usePersistentCache: true` でメモリミス | IndexedDB を確認し、あればメモリにロードして返す |
| オフライン かつ キャッシュなし | `{ ok: false, error: "offline" }` を返す |
| `type: "image" \| "video"` かつ LowMemory | 自動的にストリーミングに切り替え |
| `metaOnly: true` または `type: "image" \| "video"` | `data` にメタ情報配列が入る（`ResultMeta[]`） |

---

### `searchMeta(options): Promise<FetchResult>`

`metaOnly: true` 固定の `search()` です。`enableStreaming` / `onChunk` は指定できません。

```ts
const result = await searchMeta({ q: "TypeScript", type: "news" });
// result.data は ResultMeta[] （title, url, summary, favicon, publishedDate のみ）
```

---

### `searchAll(options, types?): Promise<SearchAllResult>`

```ts
type SearchAllResult = Partial<Record<SearchType, FetchResult>>;

function searchAll(
  opts: Omit<SearchOptions, "type">,
  types?: SearchType[]  // デフォルト: ["web", "news"]
): Promise<SearchAllResult>;
```

`Promise.allSettled` で並列実行します。失敗したタイプは戻り値のオブジェクトに含まれません。

```ts
const results = await searchAll({ q: "TypeScript" }, ["web", "news", "image"]);
results.web?.data;   // Web 検索結果（失敗時は undefined）
results.news?.data;  // ニュース検索結果
results.image?.data; // 画像検索結果（ResultMeta[]）
```

---

### `fetchDetail(options, idx): Promise<ResultDetail | null>`

キャッシュ優先で idx 番目のアイテムの全フィールドを取得します。

- メモリキャッシュ → IndexedDB → ネットワークの順で取得します。
- `_idx` は `ResultMeta` の `_idx` フィールドと同じ値です。

```ts
const meta = await searchMeta({ q: "TypeScript" });
const items = meta.data as ResultMeta[];

// 詳細をオンデマンドで取得
const detail = await fetchDetail({ q: "TypeScript" }, items[0]._idx);
console.log(detail?.summary); // 全フィールドが入っている
```

---

### ショートハンド関数

```ts
searchWeb  (q: string, page?: number, signal?: AbortSignal): Promise<FetchResult>
searchImage(q: string, page?: number, signal?: AbortSignal): Promise<FetchResult>
searchVideo(q: string, page?: number, signal?: AbortSignal): Promise<FetchResult>
searchNews (q: string, page?: number, signal?: AbortSignal): Promise<FetchResult>
searchPanel(q: string,                signal?: AbortSignal): Promise<FetchResult>
```

すべて `search()` の薄いラッパーです。

---

## サジェスト

### `getSuggest(q: string): Promise<SuggestResult>`

サジェストを即時取得します。

- プレフィックスキャッシュ適用（「破産」取得済みなら「破産手続き」はキャッシュから絞り込みで返す）
- TTL: `SUGGEST_TTL`（デフォルト 30 秒）
- 永続キャッシュには書き込みません
- 同一クエリが並行して呼ばれた場合は同一の `Promise` を共有します（in-flight 重複排除）
- LowMemory 時はキャッシュ上限を自動で半分に削減します

```ts
const result = await getSuggest("破産");
if (result.ok) {
  console.log(result.items); // [{ title: "破産" }, { title: "破産とは" }, ...]
  console.log(result.cached); // true なら API 通信なし
}
```

---

### `getSuggestDebounced(q, callback, wait?): void`

```ts
function getSuggestDebounced(
  q: string,
  callback: (result: SuggestResult) => void,
  wait?: number // 省略時: Config.SUGGEST_DEBOUNCE_MS（デフォルト 200ms）
): void;
```

- `wait` が同じ値の呼び出しは内部で同一の debounce 関数を再利用します
- LowMemory 時は `wait` が自動で 2 倍になります（`utils.ts` の `debounce` による）

```ts
input.addEventListener("input", (e) => {
  getSuggestDebounced(
    (e.currentTarget as HTMLInputElement).value,
    (result) => {
      if (result.ok) renderDropdown(result.items);
    }
  );
});
```

---

## ページネーション

### `createPager(options, maxPage?): Pager`

```ts
function createPager(
  opts: Omit<SearchOptions, "page">,
  maxPage?: number // デフォルト: 10
): Pager;
```

- `next()` は内部で次のページを自動プリフェッチします（LowMemory / オフライン時は抑制）
- `next()` が `maxPage` を超えると `null` を返します
- `prev()` が page=1 より前になると `null` を返します
- `reset()` 後は `currentPage === 0` になります

```ts
const pager = createPager({ q: "TypeScript", type: "web" }, 20);

const p1 = await pager.next(); // page=1、内部で page=2 をプリフェッチ
const p2 = await pager.next(); // page=2（プリフェッチ済みでほぼ即座に返る）

if (!p1) console.log("maxPage に到達");

pager.reset();
console.log(pager.currentPage); // 0
```

---

## 検索履歴

> 保存先: `localStorage`（SSR 環境では自動的に無効化）
> 上限: 20 件（超えると古いものから削除）
> 同一クエリ（大文字小文字無視）の重複は先頭に移動します

### `addHistory(q, type?): void`

```ts
function addHistory(q: string, type?: string): void; // type デフォルト: "web"
```

### `getHistory(prefix?): HistoryEntry[]`

```ts
function getHistory(prefix?: string): HistoryEntry[];
// prefix を指定するとプレフィックスフィルタリングして返す
// 戻り値は新しい順（先頭が最新）
```

### `removeHistory(q, type?): void`

```ts
function removeHistory(q: string, type?: string): void;
```

### `clearHistory(): void`

```ts
function clearHistory(): void; // localStorage からキーごと削除
```

### `mergeWithHistory(q, suggestItems): MergedItem[]`

```ts
function mergeWithHistory(
  q: string,
  suggestItems: { title: string }[]
): { title: string; fromHistory: boolean }[];
```

- 履歴を先頭に配置し、サジェストと重複する文字列（大文字小文字無視）は履歴側を優先します
- `fromHistory: true` のアイテムにはUI側で時計アイコンなどを表示するのが典型的な使い方です

```ts
const suggest = await getSuggest(q);
const list = mergeWithHistory(q, suggest.items);

for (const item of list) {
  console.log(item.fromHistory ? "🕐" : "🔍", item.title);
}
```

---

## イベント

### `on(event, handler): () => void`

```ts
function on<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): () => void; // 戻り値は unsubscribe 関数
```

- ハンドラ内で `off()` を呼んでも他のハンドラの実行に影響しません（スナップショット実行）
- ハンドラ内で throw した場合 `console.error` に出力されますが、他のハンドラは継続します

```ts
// パターン1: unsubscribe 関数を保持する
const unsub = on("memoryStateChange", ({ isLow, isCritical }) => {
  updateUI(isLow, isCritical);
});
unsub(); // 解除

// パターン2: React useEffect
useEffect(() => {
  return on("online", () => refetch());
}, []);
```

**イベント一覧**

| イベント | ペイロード型 | 発火タイミング |
|---|---|---|
| `memoryStateChange` | `{ isLow: boolean; isCritical: boolean }` | メモリ圧力が閾値をまたいだとき（`MEMORY_CHECK_INTERVAL` ごとに評価） |
| `online` | `undefined` | `window` の `online` イベント発生時 |
| `offline` | `undefined` | `window` の `offline` イベント発生時 |
| `cacheRefreshed` | `{ key: string }` | SWR バックグラウンド更新が成功したとき |

### `off(event, handler): void`

```ts
function off<K extends keyof SearchEventMap>(
  event: K,
  handler: Handler<SearchEventMap[K]>
): void;
```

---

## 統計

### `getSearchStats(): SearchStats`

```ts
const stats = getSearchStats();
```

- `memoryCacheMax` はメモリ状態によって変動します（Normal: 30 / Low: 10 / Critical: 5）
- `inFlightCount` が増え続ける場合はリクエストが詰まっている可能性があります

---

## キャンセル

### `cancelRequest(key: string): void`

内部キーで特定のリクエストをキャンセルします。通常は `AbortSignal` の使用を推奨します。

### `cancelAll(): void`

進行中のすべてのリクエストをキャンセルします。

### AbortSignal（推奨）

```ts
// React useEffect
useEffect(() => {
  const ac = new AbortController();
  searchWeb(query, 1, ac.signal).then(setResult);
  return () => ac.abort();
}, [query]);

// SvelteKit load()
export async function load({ signal, url }) {
  const q = url.searchParams.get("q") ?? "";
  return search({ q, signal });
}
```

> `AbortSignal.any()` 対応ブラウザでは外部シグナルと内部タイムアウトシグナルが正しくマージされます。未対応ブラウザではフォールバック処理が適用されます。

---

## ユーティリティ

### `debounce(fn, delay?, usePromise?)`

```ts
function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay?: number,       // デフォルト: 300ms
  usePromise?: boolean  // デフォルト: true
): (...args: Parameters<T>) => Promise<ReturnType<T>>;
```

- LowMemory 時は `delay` が自動で 2 倍になります
- `usePromise: true`（デフォルト）では debounce された最後の呼び出しの結果を Promise で返します

### `getIsOnline(): boolean`

```ts
function getIsOnline(): boolean;
// navigator.onLine を監視している状態を返す
// SSR では常に true
```

### `configure(overrides?): void`

```ts
function configure(overrides?: Partial<Config>): void;
// init() の内部でも呼ばれます
// init() を通さずに設定だけ変更したい場合に使います
```
