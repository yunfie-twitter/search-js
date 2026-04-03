# API Reference

すべての公開 API の型シグネチャと説明です。

---

## 初期化

### `init(options?)`

ライブラリを初期化します。アプリ起動時に一度だけ呼んでください。

```ts
import { init } from "search-js";

init({
  API_BASE: "https://api.example.com",
  SUGGEST_TTL: 20_000,
  SUGGEST_DEBOUNCE_MS: 150,
});
```

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `API_BASE` | `string` | `"https://api.wholphin.net"` | API サーバーのベース URL |
| `CACHE_TTL` | `number` | `300_000` ms | メモリキャッシュの有効期限 |
| `CACHE_MAX` | `number` | `30` | メモリキャッシュの最大エントリ数 |
| `TIMEOUT` | `number` | `8_000` ms | リクエストタイムアウト |
| `RETRIES` | `number` | `3` | 失敗時の最大リトライ回数 |
| `SUGGEST_TTL` | `number` | `30_000` ms | サジェストキャッシュの有効期限 |
| `SUGGEST_DEBOUNCE_MS` | `number` | `200` ms | サジェスト debounce 間隔 |

### `destroy()`

タイマー・キャッシュ・リスナーをすべて解放します。SPA のアンマウント時に呼んでください。

```ts
await destroy();
```

---

## 検索

### `search(options): Promise<FetchResult>`

汎用検索関数。

```ts
const result = await search({ q: "TypeScript", type: "web" });
```

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `q` | `string` | — | 検索クエリ（必須） |
| `type` | `SearchType` | `"web"` | 検索タイプ |
| `page` | `number` | `1` | ページ番号 |
| `safesearch` | `0\|1\|2` | `0` | セーフサーチレベル |
| `lang` | `string` | `"ja"` | 言語コード |
| `metaOnly` | `boolean` | `false` | メタ情報のみ取得 |
| `enableStreaming` | `boolean` | `false` | ストリーミング有効化 |
| `onChunk` | `(chunk) => void` | — | ストリーミング時のコールバック |
| `usePersistentCache` | `boolean` | `false` | IndexedDB キャッシュを使用 |
| `signal` | `AbortSignal` | — | キャンセル用シグナル |

`SearchType` は `"web" | "image" | "video" | "news" | "panel"` のいずれか。

### ショートハンド

```ts
searchWeb(q, page?, signal?)
searchImage(q, page?, signal?)
searchVideo(q, page?, signal?)
searchNews(q, page?, signal?)
searchPanel(q, signal?)
```

### `searchMeta(options): Promise<FetchResult>`

`metaOnly: true` 固定の `search()` 。title / url / favicon などのみ取得します。

### `searchAll(options, types?): Promise<SearchAllResult>`

複数タイプを並列取得します。失敗したタイプは結果から除外されます。

```ts
const { web, news } = await searchAll({ q: "検索" }, ["web", "news"]);
```

### `fetchDetail(options, idx): Promise<ResultDetail | null>`

キャッシュまたはネットワークから idx 番目のアイテムの全フィールドを取得します。

---

## サジェスト

### `getSuggest(q): Promise<SuggestResult>`

サジェストを即時取得します（プレフィックスキャッシュ適用）。

```ts
const { items } = await getSuggest("TypeS");
// items: [{ title: "TypeScript" }, { title: "TypeScript とは" }, ...]
```

### `getSuggestDebounced(q, callback, wait?)`

デバウンス済みのサジェスト取得。入力イベントハンドラで使います。

```ts
input.addEventListener("input", (e) => {
  getSuggestDebounced(e.currentTarget.value, (result) => {
    renderDropdown(result.items);
  });
});
```

---

## ページネーション

### `createPager(options, maxPage?): Pager`

```ts
const pager = createPager({ q: "検索", type: "web" });

const page1 = await pager.next(); // page=1
const page2 = await pager.next(); // page=2
await pager.prev();               // page=1 に戻る
pager.reset();                    // page=0 にリセット

console.log(pager.currentPage);   // 0
```

---

## 検索履歴

```ts
import { addHistory, getHistory, removeHistory, clearHistory, mergeWithHistory } from "search-js";

addHistory("TypeScript", "web");        // 履歴に追加
getHistory();                            // 全履歴取得
getHistory("Type");                      // プレフィックスフィルタ
removeHistory("TypeScript", "web");     // 1件削除
clearHistory();                          // 全削除

// サジェストと履歴をマージ
const suggest = await getSuggest(q);
const merged = mergeWithHistory(q, suggest.items);
// merged[i].fromHistory で履歴由来か判別可能
```

---

## イベント

```ts
import { on } from "search-js";

// 戻り値は unsubscribe 関数
const unsub = on("memoryStateChange", ({ isLow, isCritical }) => {
  console.log("メモリ状態変化", isLow, isCritical);
});

on("online",  () => console.log("オンライン復帰"));
on("offline", () => console.log("オフライン"));
on("cacheRefreshed", ({ key }) => console.log("SWR 更新:", key));

// 解除
unsub();
```

| イベント | ペイロード | タイミング |
|---|---|---|
| `memoryStateChange` | `{ isLow, isCritical }` | メモリ圧力が変化したとき |
| `online` | — | ネットワーク復帰時 |
| `offline` | — | ネットワーク切断時 |
| `cacheRefreshed` | `{ key }` | SWR バックグラウンド更新完了時 |

---

## 統計

```ts
import { getSearchStats } from "search-js";

const stats = getSearchStats();
// {
//   memoryCacheSize: 12,
//   memoryCacheMax: 30,
//   isLowMemory: false,
//   isCriticalMemory: false,
//   inFlightCount: 1,
//   isOnline: true,
// }
```

---

## キャンセル

```ts
import { cancelRequest, cancelAll } from "search-js";

cancelRequest("request-key"); // 特定のリクエストをキャンセル
cancelAll();                   // 全リクエストをキャンセル
```

外部 `AbortController` を使う方法（React / SvelteKit 推奨）:

```ts
const ac = new AbortController();
searchWeb("query", 1, ac.signal);

// コンポーネントのアンマウント時
ac.abort();
```
