# サジェストガイド

サジェストは通常の検索（`search()`）と完全に分離した専用エンジンです。
`title` のみの超軽量データで、TTL が短く、永続キャッシュには書き込みません。

## 基本的な使い方

```ts
import { getSuggest } from "search-js";

const result = await getSuggest("破産");
console.log(result.items);
// [
//   { title: "破産" },
//   { title: "破産とは" },
//   { title: "破産者マップ" },
//   ...
// ]
```

## 入力欄への組み込み（debounce 付き）

```ts
import { getSuggestDebounced } from "search-js";

const input = document.querySelector("input")!;

input.addEventListener("input", (e) => {
  getSuggestDebounced(
    (e.currentTarget as HTMLInputElement).value,
    (result) => {
      if (!result.ok) return;
      renderDropdown(result.items);
    },
    200 // ms（省略すると config.SUGGEST_DEBOUNCE_MS を使用）
  );
});
```

## 履歴と混ぜる

```ts
import { getSuggest, getSuggestDebounced, mergeWithHistory, addHistory } from "search-js";

// 検索実行時に履歴へ追加
function onSearch(q: string) {
  addHistory(q, "web");
  // ...
}

// サジェストドロップダウン表示
getSuggestDebounced(q, (result) => {
  const merged = mergeWithHistory(q, result.items);
  // merged[i].fromHistory === true → 🕐 アイコンを表示
  // merged[i].fromHistory === false → 🔍 アイコンを表示
  renderDropdown(merged);
});
```

## プレフィックスキャッシュの仕組み

「破産」で取得済みなら、「破産手続き」の入力時はネットワーク通信なしでキャッシュから絞り込んで返します。

```
"破産" → API 通信 → キャッシュに保存
"破産手" → キャッシュヒット → items.filter(title.includes("破産手")) → 即返す
"破産手続き" → キャッシュヒット → 同上
```

TTL（デフォルト 30 秒）を過ぎたエントリは自動で無効化されます。

## React での例

```tsx
import { useEffect, useState, useCallback } from "react";
import { getSuggestDebounced, mergeWithHistory, addHistory } from "search-js";

function SearchBar() {
  const [items, setItems] = useState<{ title: string; fromHistory: boolean }[]>([]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    getSuggestDebounced(e.target.value, (result) => {
      if (result.ok) setItems(mergeWithHistory(e.target.value, result.items));
    });
  }, []);

  return (
    <div>
      <input onChange={handleInput} />
      <ul>
        {items.map((item) => (
          <li key={item.title}>
            {item.fromHistory ? "🕐" : "🔍"} {item.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
```
