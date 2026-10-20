// src/tui/select-menu.ts - Pure state, filtering, windowing and keyboard handling for transient Pi-style selectors
import { stripBracketedPaste, type EditorKey } from './editor.js';

export interface TuiMenuItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly badge?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
}

export interface TuiMenuState {
  readonly kind: 'model' | 'login' | 'logout';
  readonly title: string;
  readonly placeholder?: string;
  readonly items: readonly TuiMenuItem[];
  readonly query: string;
  readonly selectedIndex: number;
}

function matchRank(item: TuiMenuItem, fullQuery: string): number {
  const val = item.value.toLowerCase();
  const lbl = item.label.toLowerCase();
  if (val === fullQuery || lbl === fullQuery) return 0;
  if (val.startsWith(fullQuery) || lbl.startsWith(fullQuery)) return 1;
  if (val.includes(fullQuery) || lbl.includes(fullQuery)) return 2;
  return 3;
}

/** Filters items by case-insensitive multi-token query and ranks exact/prefix matches first. */
export function filterMenuItems(items: readonly TuiMenuItem[], query: string): TuiMenuItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const matched = items.filter((item) => {
    const haystack = `${item.value} ${item.label} ${item.description ?? ''} ${item.badge ?? ''}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
  return matched
    .map((item, idx) => ({ item, idx, rank: matchRank(item, normalized) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((entry) => entry.item);
}

export interface MenuWindow {
  readonly slice: readonly TuiMenuItem[];
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly selectedIndex: number;
}

/** Computes a visible window of at most `maxVisible` items around `selectedIndex`. */
export function windowMenuItems(
  filtered: readonly TuiMenuItem[],
  selectedIndex: number,
  maxVisible = 8,
): MenuWindow {
  const total = filtered.length;
  const size = Math.max(1, Math.floor(maxVisible));
  const clamped = total > 0 ? Math.max(0, Math.min(selectedIndex, total - 1)) : 0;
  if (total <= size) {
    return { slice: filtered, start: 0, end: total, total, selectedIndex: clamped };
  }
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(clamped - half, total - size));
  const end = Math.min(total, start + size);
  return { slice: filtered.slice(start, end), start, end, total, selectedIndex: clamped };
}

function stepEnabledIndex(filtered: readonly TuiMenuItem[], current: number, delta: 1 | -1): number {
  const count = filtered.length;
  if (count === 0) return 0;
  for (let step = 1; step <= count; step++) {
    const candidate = (current + delta * step + count) % count;
    if (!filtered[candidate]?.disabled) return candidate;
  }
  return (current + delta + count) % count;
}

export interface MenuKey extends EditorKey {
  upArrow?: boolean;
  downArrow?: boolean;
  tab?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

/** Pure keyboard reducer for the transient selector menu. */
export function editMenuInput(
  menu: TuiMenuState,
  input: string,
  key: MenuKey,
  pageSize = 8,
): { state: TuiMenuState; select?: string; cancel?: boolean } {
  const filtered = filterMenuItems(menu.items, menu.query);
  const count = filtered.length;
  const current = count > 0 ? Math.max(0, Math.min(menu.selectedIndex, count - 1)) : 0;

  if (key.escape) {
    return { state: menu, cancel: true };
  }
  if (key.return) {
    if (count === 0) return { state: menu };
    const chosen = filtered[current];
    if (!chosen || chosen.disabled) return { state: menu };
    return { state: menu, select: chosen.value };
  }
  if (key.upArrow) {
    if (count === 0) return { state: menu };
    return { state: { ...menu, selectedIndex: stepEnabledIndex(filtered, current, -1) } };
  }
  if (key.downArrow) {
    if (count === 0) return { state: menu };
    return { state: { ...menu, selectedIndex: stepEnabledIndex(filtered, current, 1) } };
  }
  if (key.pageUp) {
    if (count === 0) return { state: menu };
    return { state: { ...menu, selectedIndex: Math.max(0, current - pageSize) } };
  }
  if (key.pageDown) {
    if (count === 0) return { state: menu };
    return { state: { ...menu, selectedIndex: Math.min(count - 1, current + pageSize) } };
  }
  if (key.backspace || key.delete) {
    const chars = [...menu.query];
    if (chars.length === 0) return { state: menu };
    const nextQuery = chars.slice(0, -1).join('');
    return { state: { ...menu, query: nextQuery, selectedIndex: 0 } };
  }
  if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) {
    return { state: menu };
  }
  const clean = stripBracketedPaste(input).replace(/[\r\n\t]+/g, '');
  if (!clean) return { state: menu };
  return { state: { ...menu, query: menu.query + clean, selectedIndex: 0 } };
}
