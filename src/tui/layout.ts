// src/tui/layout.ts - Display-column layout shared by terminal components
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';

export interface Segment { text: string; priority: number; compact?: string }

export function visibleWidth(s: string): number { return stringWidth(s); }

export function truncate(s: string, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  if (!columns) return '';
  if (visibleWidth(s) <= columns) return s;
  return sliceAnsi(s, 0, columns - 1) + '…';
}

export function fitFooterLine(left: Segment[], right: string, width: number): string {
  const available = Math.max(0, Math.floor(width) - visibleWidth(right) - (right ? 1 : 0));
  const parts = left.map((segment) => ({ ...segment }));
  const join = () => parts.map((part) => part.text).filter(Boolean).join(' ');
  for (const part of [...parts].sort((a, b) => a.priority - b.priority)) {
    if (visibleWidth(join()) <= available) break;
    if (part.compact !== undefined) part.text = part.compact;
    if (visibleWidth(join()) > available) part.text = '';
  }
  const text = truncate(join(), available);
  // When the terminal is narrower than right itself, preserving right takes precedence.
  return text + ' '.repeat(Math.max(0, Math.floor(width) - visibleWidth(text) - visibleWidth(right))) + right;
}
