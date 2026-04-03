# キャッシュ戦略ガイド

search-js は 3 層のキャッシュを持ちます。

## キャッシュ層の概要

| 層 | 場所 | TTL | 永続 | 用途 |
|---|---|---|---|---|
| メモリキャッシュ | `Map`（JS ヒープ） | 5 分 | ✗ | 高速アクセス・LRU 管理 |
| 永続キャッシュ | IndexedDB | 任意 | ✓ | ページリロード後も有効 |
| サジェストキャッシュ | `Map`（JS ヒープ） | 30 秒 | ✗ | 入力補助専用 |

## SWR（Stale-While-Revalidate）

キャッシュの有効期限が切れていても、古いデータを即座に返しながらバックグラウンドで新しいデータを取得します。ユーザーは待たされません。

```ts
import { on } from "search-js";

// SWR で更新されたタイミングを検知して UI を差分更新できる
on("cacheRefreshed", ({ key }) => {
  console.log("バックグラウンド更新完了:", key);
});
```

## 永続キャッシュの使い方

```ts
const result = await searchWeb("TypeScript", 1, undefined /* signal */);
// 永続キャッシュは SearchOptions から指定
const result2 = await search({
  q: "TypeScript",
  type: "web",
  usePersistentCache: true, // IndexedDB に保存・読み込み
});
```

## 低メモリ端末での挙動

`performance.memory` や `navigator.deviceMemory` でメモリ状況を監視し、自動的にキャッシュを削減します。

```
通常: CACHE_MAX=30 エントリ保持
Low:  CACHE_MAX=10 に削減、期限切れを即座に退避
Critical: CACHE_MAX=5 に削減、全体を半分に強制削除
```

この変化は `on("memoryStateChange")` で検知できます。

```ts
on("memoryStateChange", ({ isLow, isCritical }) => {
  if (isCritical) showBanner("メモリ不足のため画質を下げました");
});
```

## キャッシュ統計の確認

```ts
import { getSearchStats } from "search-js";

setInterval(() => {
  const s = getSearchStats();
  console.table(s);
}, 5000);
```

## 手動クリア

```ts
import { destroy } from "search-js";
import { clearHistory } from "search-js";

// 検索キャッシュをすべてクリア（IndexedDB も含む）
await destroy();

// 履歴のみクリア
clearHistory();
```
