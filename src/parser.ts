// src/parser.ts
import type { SearchType } from "./index.ts";

// ---- 型定義 --------------------------------------------------------

export interface BaseMeta {
  _idx: number;
  title?: string;
  url?: string;
}

export interface WebMeta extends BaseMeta {
  summary?: string;
  favicon?: string;
}

export interface ImageMeta extends BaseMeta {
  thumbnail?: string;
  domain?: string;
}

export interface VideoMeta extends BaseMeta {
  thumbnail?: string;
  duration?: string;
  publishedDate?: string;
}

export interface NewsMeta extends BaseMeta {
  summary?: string;
  favicon?: string;
  publishedDate?: string;
}

export type ResultMeta =
  | WebMeta
  | ImageMeta
  | VideoMeta
  | NewsMeta
  | BaseMeta;

export type ResultDetail = ResultMeta & {
  [key: string]: unknown;
};

export interface ParsedResponse {
  meta: ResultMeta[];
  raw: unknown;
}

// ---- 定義 --------------------------------------------------------

const META_FIELDS_BY_TYPE: Record<string, readonly string[]> = {
  web: ["title", "url", "summary", "favicon"],
  news: ["title", "url", "summary", "favicon", "publishedDate"],
  image: ["title", "url", "thumbnail", "domain"],
  video: ["title", "url", "thumbnail", "duration", "publishedDate"],
};

const HEAVY_FIELDS = new Set<string>(["summary"]);

const FIELD_ALIASES: Record<string, readonly string[]> = {
  url: ["url", "href", "link"],
  thumbnail: ["thumbnail", "image", "img", "thumb"],
  favicon: ["favicon", "icon"],
  domain: ["domain", "source", "siteName"],
  summary: ["summary", "description", "snippet", "desc", "content"],
  publishedDate: ["publishedDate", "date", "published", "publishedAt"],
  duration: ["duration", "length"],
};

// ---- Public API --------------------------------------------------------

export function extractMeta(
  data: unknown,
  type: SearchType = "web",
  lowMemory = false
): ResultMeta[] {
  const fields = _fieldsForType(type, lowMemory);
  const arr = _toArray(data);

  const result: ResultMeta[] = new Array(arr.length);

  for (let i = 0; i < arr.length; i++) {
    const obj = _safeObj(arr[i]);

    const meta: Record<string, unknown> = { _idx: i };

    for (const f of fields) {
      const v = _resolve(obj, f);
      if (v !== undefined) meta[f] = v;
    }

    result[i] = meta as ResultMeta;
  }

  return result;
}

export function extractDetail(
  data: unknown,
  idx: number
): ResultDetail | null {
  const arr = _toArray(data);
  if (idx < 0 || idx >= arr.length) return null;

  const obj = _safeObj(arr[idx]);

  return {
    _idx: idx,
    title: _resolve(obj, "title"),
    url: _resolve(obj, "url"),
    thumbnail: _resolve(obj, "thumbnail"),
    favicon: _resolve(obj, "favicon"),
    domain: _resolve(obj, "domain"),
    summary: _resolve(obj, "summary"),
    duration: _resolve(obj, "duration"),
    publishedDate: _resolve(obj, "publishedDate"),
    ...obj,
  };
}

export function chunkToMeta(
  chunk: unknown,
  type: SearchType = "web",
  lowMemory = false
): ResultMeta | null {
  if (!chunk) return null;

  const fields = _fieldsForType(type, lowMemory);

  const tryObj = _safeObj(chunk);

  // 単体オブジェクト
  if ("title" in tryObj || "url" in tryObj) {
    return _buildMeta(tryObj, fields);
  }

  // ラッパー対応
  const arr = _toArray(chunk);
  if (arr.length > 0) {
    return chunkToMeta(arr[0], type, lowMemory);
  }

  return null;
}

// ---- 内部 --------------------------------------------------------

function _fieldsForType(
  type: SearchType,
  lowMemory: boolean
): readonly string[] {
  const base = META_FIELDS_BY_TYPE[type] ?? ["title", "url"];
  if (!lowMemory) return base;
  return base.filter((f) => !HEAVY_FIELDS.has(f));
}

function _buildMeta(
  obj: Record<string, unknown>,
  fields: readonly string[]
): ResultMeta {
  const meta: Record<string, unknown> = {
    _idx: typeof obj._idx === "number" ? obj._idx : 0,
  };

  for (const f of fields) {
    const v = _resolve(obj, f);
    if (v !== undefined) meta[f] = v;
  }

  return meta as ResultMeta;
}

function _resolve(
  obj: Record<string, unknown>,
  field: string
): string | undefined {
  const aliases = FIELD_ALIASES[field];

  if (aliases) {
    for (const key of aliases) {
      const v = _str(obj[key]);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  return _str(obj[field]);
}

// ---- 安全ユーティリティ（重要） ----

function _safeObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object"
    ? (v as Record<string, unknown>)
    : {};
}

function _str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    return s.length > 0 ? s : undefined;
  }

  // number → string変換（地味に重要）
  if (typeof v === "number") {
    return String(v);
  }

  return undefined;
}

function _toArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    for (const key of [
      "results",
      "items",
      "data",
      "hits",
      "entries",
      "docs",
    ]) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
  }

  return [];
}
