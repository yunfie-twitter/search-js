// src/history.ts

const STORAGE_KEY = "__search_js_history__";
const MAX_HISTORY = 20;

export interface HistoryEntry {
  q: string;
  type: string;
  time: number;
}

function _isAvailable(): boolean {
  try { return typeof localStorage !== "undefined"; }
  catch { return false; }
}

function _load(): HistoryEntry[] {
  if (!_isAvailable()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch { return []; }
}

function _save(entries: HistoryEntry[]): void {
  if (!_isAvailable()) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); }
  catch { /* quota exceeded */ }
}

export function addHistory(q: string, type = "web"): void {
  if (!q.trim()) return;
  const entries = _load().filter(
    (e) => !(e.q.toLowerCase() === q.trim().toLowerCase() && e.type === type)
  );
  entries.unshift({ q: q.trim(), type, time: Date.now() });
  _save(entries.slice(0, MAX_HISTORY));
}

export function getHistory(prefix?: string): HistoryEntry[] {
  const entries = _load();
  if (!prefix) return entries;
  const lower = prefix.trim().toLowerCase();
  return entries.filter((e) => e.q.toLowerCase().startsWith(lower));
}

export function removeHistory(q: string, type = "web"): void {
  _save(
    _load().filter(
      (e) => !(e.q.toLowerCase() === q.trim().toLowerCase() && e.type === type)
    )
  );
}

export function clearHistory(): void {
  if (_isAvailable()) localStorage.removeItem(STORAGE_KEY);
}

export function mergeWithHistory(
  q: string,
  suggestItems: { title: string }[]
): { title: string; fromHistory: boolean }[] {
  const histEntries = getHistory(q);
  const histSet = new Set(histEntries.map((e) => e.q.toLowerCase()));
  const histResults = histEntries.map((e) => ({ title: e.q, fromHistory: true as const }));
  const filtered = suggestItems
    .filter((s) => !histSet.has(s.title.toLowerCase()))
    .map((s) => ({ title: s.title, fromHistory: false as const }));
  return [...histResults, ...filtered];
}
