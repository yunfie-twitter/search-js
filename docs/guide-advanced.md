# 高度な使い方

## AbortSignal によるキャンセル

### React `useEffect`

```tsx
useEffect(() => {
  const ac = new AbortController();

  searchWeb(query, 1, ac.signal).then((result) => {
    if (result.ok) setResults(result.data);
  });

  return () => ac.abort(); // コンポーネントアンマウント時にキャンセル
}, [query]);
```

### SvelteKit `load()`

```ts
export async function load({ fetch, url, signal }) {
  const q = url.searchParams.get("q") ?? "";
  return await search({ q, type: "web", signal });
}
```

## ページネーション

```ts
import { createPager } from "search-js";

const pager = createPager({ q: "TypeScript", type: "web" });

// 無限スクロール
async function loadMore() {
  const result = await pager.next();
  if (!result) return; // maxPage 到達
  if (result.ok) appendResults(result.data);
}

// 前のページに戻る
async function loadPrev() {
  const result = await pager.prev();
  if (!result) return; // 先頭
  if (result.ok) setResults(result.data);
}
```

`next()` は内部で次のページを自動プリフェッチするため、実際のフェッチは先行して完了していることが多いです。

## 並列マルチタイプ検索

タブ型UIで Web・ニュースを同時に取得するパターン。

```ts
import { searchAll } from "search-js";

const { web, news, image } = await searchAll(
  { q: "TypeScript", lang: "ja" },
  ["web", "news", "image"]
);

if (web?.ok)   renderWebTab(web.data);
if (news?.ok)  renderNewsTab(news.data);
if (image?.ok) renderImageTab(image.data);
```

`Promise.allSettled` ベースなので、1つのタイプが失敗しても他は影響を受けません。

## オフライン対応

```ts
import { on, getIsOnline } from "search-js";

// 現在のオンライン状態を確認
if (!getIsOnline()) {
  showBanner("オフラインモード: キャッシュから表示しています");
}

// 状態変化を監視
const unsubOnline  = on("online",  () => hideBanner());
const unsubOffline = on("offline", () => showBanner("接続が切れました"));

// クリーンアップ
unsubOnline();
unsubOffline();
```

オフライン中にキャッシュヒットがない場合は `{ ok: false, error: "offline" }` が返ります。ネットワーク復帰時、バックグラウンドで失敗したリクエストが自動再試行されます。

## ストリーミング

大量の結果を逐次表示したい場合に使います。`image` / `video` タイプかつ低メモリ環境では自動的にストリーミングに切り替わります。

```ts
await search({
  q: "TypeScript",
  type: "web",
  enableStreaming: true,
  onChunk: (chunk) => {
    appendCard(chunk); // 1件ずつ画面に追加
  },
});
```

## メモリ状態に応じた UI 制御

```ts
import { on, searchImage } from "search-js";

let quality: "high" | "medium" | "low" = "high";

on("memoryStateChange", ({ isLow, isCritical }) => {
  quality = isCritical ? "low" : isLow ? "medium" : "high";
});

// 画像検索時に quality を使って表示を調整
const result = await searchImage(q);
if (result.ok) renderImages(result.data, quality);
```
