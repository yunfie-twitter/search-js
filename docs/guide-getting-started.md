# Getting Started

## インストール

```bash
npm install search-js
# or
pnpm add search-js
```

## 最小構成

```ts
import { init, searchWeb } from "search-js";

// アプリ起動時に一度だけ呼ぶ
init({ API_BASE: "https://api.example.com" });

const result = await searchWeb("TypeScript");
if (result.ok) {
  console.log(result.data);
}
```

## 結果の構造

`result.data` はそのまま API レスポンスの JSON です。`type: "image"` や `type: "video"` では自動的にメタ情報のみに絞られます。

```ts
// Web 検索の結果例
{
  "results": [
    {
      "title": "TypeScript 公式ドキュメント",
      "url": "https://www.typescriptlang.org/",
      "summary": "TypeScript is JavaScript with syntax for types.",
      "favicon": "https://..."
    }
  ]
}
```

## エラーハンドリング

`result.ok` が `false` のとき `result.error` にエラーコードが入ります。

| エラーコード | 意味 |
|---|---|
| `empty_query` | クエリが空 |
| `offline` | オフライン（キャッシュもなし）|
| `cancelled` | `AbortSignal` でキャンセル |
| `network_error` | ネットワーク到達不可 |
| `server_error` | API が 5xx を返した |
| `client_error` | API が 4xx を返した |
| `max_retries_exceeded` | リトライ上限超過 |

```ts
const result = await searchWeb("query");
if (!result.ok) {
  if (result.error === "offline") {
    showToast("オフラインです。キャッシュから表示しています。");
  }
}
```

## アプリ終了時

SPA では画面遷移やアンマウント時に `destroy()` を呼んでリソースを解放してください。

```ts
import { destroy } from "search-js";

// React: useEffect の cleanup
useEffect(() => {
  init({ API_BASE: "..." });
  return () => { void destroy(); };
}, []);
```
