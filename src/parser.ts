// src/parser.ts
// 部分パース・メタ先行取得・フィールド抜き出し

// ---- 型定義 --------------------------------------------------------

export interface ResultMeta {
  title?: string;
  url?: string;
  thumbnail?: string;
  /** 元のインデックス（detail 取得用） */
  _idx: number;
}

export interface ResultDetail extends ResultMeta {
  description?: string;
  date?: string;
  [key: string]: unknown;
}

export interface ParsedResponse {
  meta: ResultMeta[];
  raw: unknown;
}

// 小・中規模で部分パースするフィールドセット
export const META_FIELDS: ReadonlySet<string> = new Set([
  "title", "url", "href", "link",
  "thumbnail", "image", "img", "thumb",
]);

// ---- ユーティリティ --------------------------------------------------------

/**
 * 任意オブジェクトから指定フィールドのみを抽出する。
 * 部分パースで必要最小限のメモリしか使わない。
 */
export function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields: ReadonlySet<string>
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of fields) {
    if (key in obj) (out as Record<string, unknown>)[key] = obj[key];
  }
  return out;
}

/**
 * レスポンスデータから ResultMeta[] を抽出する。
 * API レスポンスのトップレベルに配列があればそれを使い、
 * なければ data.results / data.items などを探索する。
 */
export function extractMeta(data: unknown): ResultMeta[] {
  const arr = _toArray(data);
  return arr.map((item, idx) => {
    const obj = item as Record<string, unknown>;
    const meta: ResultMeta = { _idx: idx };

    // title
    meta.title = _str(obj.title ?? obj.name);
    // url
    meta.url   = _str(obj.url ?? obj.href ?? obj.link);
    // thumbnail
    meta.thumbnail = _str(obj.thumbnail ?? obj.image ?? obj.img ?? obj.thumb);

    // undefined のフィールドを消す
    if (!meta.title)     delete meta.title;
    if (!meta.url)       delete meta.url;
    if (!meta.thumbnail) delete meta.thumbnail;

    return meta;
  });
}

/**
 * 指定 index のアイテムから ResultDetail を抽出する。
 * ユーザー操作時に呼び、詳細データを遅延取得するために使う。
 */
export function extractDetail(data: unknown, idx: number): ResultDetail | null {
  const arr = _toArray(data);
  const item = arr[idx];
  if (!item) return null;
  const obj = item as Record<string, unknown>;
  return {
    _idx: idx,
    title:       _str(obj.title ?? obj.name),
    url:         _str(obj.url ?? obj.href ?? obj.link),
    thumbnail:   _str(obj.thumbnail ?? obj.image ?? obj.img ?? obj.thumb),
    description: _str(obj.description ?? obj.snippet ?? obj.desc ?? obj.content),
    date:        _str(obj.date ?? obj.published ?? obj.publishedAt),
    ...obj,
  };
}

/**
 * ストリーミングチャンクから ResultMeta を逐次抽出する。
 * onChunk に渡して画面を順次描画するときに使う。
 */
export function chunkToMeta(chunk: unknown): ResultMeta | null {
  if (!chunk || typeof chunk !== "object") return null;
  const obj = chunk as Record<string, unknown>;
  // チャンク自体がアイテムの場合
  if ("title" in obj || "url" in obj) {
    return {
      _idx: typeof obj._idx === "number" ? obj._idx : 0,
      title:     _str(obj.title ?? obj.name),
      url:       _str(obj.url ?? obj.href),
      thumbnail: _str(obj.thumbnail ?? obj.image),
    };
  }
  // チャンクが { results: [...] } などのラッパーの場合
  const arr = _toArray(obj);
  if (arr.length > 0) return chunkToMeta(arr[0]);
  return null;
}

// ---- 内部ユーティリティ ---------------------------------------------------

function _str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function _toArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // 一般的なフィールド名を探索
    for (const key of ["results", "items", "data", "hits", "entries", "docs"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}
