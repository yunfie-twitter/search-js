// src/parser.ts
// タイプ別部分パース・メタ先行取得・フィールド抜き出し

import type { SearchType } from "./index.ts";

// ---- 型定義 --------------------------------------------------------

/** 全タイプ共通のベースメタ */
export interface BaseMeta {
  _idx: number;
  title?: string;
  url?: string;
}

/** Web 検索メタ */
export interface WebMeta extends BaseMeta {
  summary?: string;
  favicon?: string;
}

/** 画像検索メタ */
export interface ImageMeta extends BaseMeta {
  thumbnail?: string;
  domain?: string;
}

/** 動画検索メタ */
export interface VideoMeta extends BaseMeta {
  thumbnail?: string;
  duration?: string;
  publishedDate?: string;
}

/** ニュース検索メタ */
export interface NewsMeta extends BaseMeta {
  summary?: string;
  favicon?: string;
  publishedDate?: string;
}

/** タイプ別メタの union */
export type ResultMeta = WebMeta | ImageMeta | VideoMeta | NewsMeta | BaseMeta;

/** 各タイプの詳細型（メタ + 全フィールド） */
export type ResultDetail = ResultMeta & { [key: string]: unknown };

export interface ParsedResponse {
  meta: ResultMeta[];
  raw: unknown;
}

// ---- タイプ別メタフィールド定義 -----------------------------------------

/**
 * タイプ別に取得するメタフィールド。
 * LowMemory 時に summary などの重いフィールドを省略する判断にも使う。
 */
const META_FIELDS_BY_TYPE: Record<string, ReadonlyArray<string>> = {
  web:   ["title", "url", "summary", "favicon"],
  news:  ["title", "url", "summary", "favicon", "publishedDate"],
  image: ["title", "url", "thumbnail", "domain"],
  video: ["title", "url", "thumbnail", "duration", "publishedDate"],
  // suggest / panel はフルデータのまま使う
};

/** LowMemory 時に省略する重いフィールド */
const HEAVY_FIELDS: ReadonlySet<string> = new Set(["summary"]);

// ---- パブリック API -------------------------------------------------------

/**
 * レスポンスデータからタイプ別の ResultMeta[] を抽出する。
 *
 * @param data      API レスポンスデータ
 * @param type      検索タイプ
 * @param lowMemory true のときは HEAVY_FIELDS を省略してメモリ節約
 */
export function extractMeta(
  data: unknown,
  type: SearchType = "web",
  lowMemory = false
): ResultMeta[] {
  const fields = _fieldsForType(type, lowMemory);
  return _toArray(data).map((item, idx) => {
    const obj = item as Record<string, unknown>;
    const meta: Record<string, unknown> = { _idx: idx };
    for (const f of fields) {
      const v = _resolve(obj, f);
      if (v !== undefined) meta[f] = v;
    }
    return meta as ResultMeta;
  });
}

/**
 * 指定 index のアイテムから全フィールドの ResultDetail を抽出する。
 * fetchDetail() から呼ばれる。
 */
export function extractDetail(data: unknown, idx: number): ResultDetail | null {
  const arr = _toArray(data);
  const item = arr[idx];
  if (!item) return null;
  const obj = item as Record<string, unknown>;
  return {
    _idx: idx,
    title:         _str(obj.title ?? obj.name),
    url:           _str(obj.url ?? obj.href ?? obj.link),
    thumbnail:     _str(obj.thumbnail ?? obj.image ?? obj.img ?? obj.thumb),
    favicon:       _str(obj.favicon ?? obj.icon),
    domain:        _str(obj.domain ?? obj.source),
    summary:       _str(obj.summary ?? obj.description ?? obj.snippet ?? obj.desc ?? obj.content),
    duration:      _str(obj.duration),
    publishedDate: _str(obj.publishedDate ?? obj.date ?? obj.published ?? obj.publishedAt),
    ...obj,
  };
}

/**
 * ストリーミングチャンクから ResultMeta を逐次抽出する。
 * onChunk コールバック内で画面を順次描画するときに使う。
 */
export function chunkToMeta(
  chunk: unknown,
  type: SearchType = "web",
  lowMemory = false
): ResultMeta | null {
  if (!chunk || typeof chunk !== "object") return null;
  const obj = chunk as Record<string, unknown>;

  if ("title" in obj || "url" in obj) {
    const fields = _fieldsForType(type, lowMemory);
    const meta: Record<string, unknown> = {
      _idx: typeof obj._idx === "number" ? obj._idx : 0,
    };
    for (const f of fields) {
      const v = _resolve(obj, f);
      if (v !== undefined) meta[f] = v;
    }
    return meta as ResultMeta;
  }

  // { results: [...] } などラッパーがあれば先頭要素を処理
  const arr = _toArray(obj);
  if (arr.length > 0) return chunkToMeta(arr[0], type, lowMemory);
  return null;
}

// ---- 内部ユーティリティ ---------------------------------------------------

/** タイプとメモリ状態に応じたフィールド一覧を返す */
function _fieldsForType(
  type: SearchType,
  lowMemory: boolean
): ReadonlyArray<string> {
  const base = META_FIELDS_BY_TYPE[type] ?? ["title", "url"];
  if (!lowMemory) return base;
  return base.filter((f) => !HEAVY_FIELDS.has(f));
}

/**
 * フィールド名に対するエイリアスを考慮して値を解決する。
 * 主要フィールド名も API によって異なるため、代替名も探索する。
 */
const FIELD_ALIASES: Record<string, ReadonlyArray<string>> = {
  url:           ["url", "href", "link"],
  thumbnail:     ["thumbnail", "image", "img", "thumb"],
  favicon:       ["favicon", "icon"],
  domain:        ["domain", "source", "siteName"],
  summary:       ["summary", "description", "snippet", "desc", "content"],
  publishedDate: ["publishedDate", "date", "published", "publishedAt"],
  duration:      ["duration", "length"],
};

function _resolve(obj: Record<string, unknown>, field: string): string | undefined {
  const aliases = FIELD_ALIASES[field];
  if (aliases) {
    for (const a of aliases) {
      const v = _str(obj[a]);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  return _str(obj[field]);
}

function _str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function _toArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["results", "items", "data", "hits", "entries", "docs"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}
