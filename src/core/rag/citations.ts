// src/core/rag/citations.ts - Parse `path:Lx-Ly` citations and check them against the sources and retrieved chunks

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapesWorkspace } from '../../tools/permissions.js';
import { tokenize } from './bm25.js';
import { TEAM_DOCS_DIR } from './chunker.js';
import type { Chunk, Citation } from './types.js';

/** `team:` marks a team doc (source 'team'); the path after it is relative to the team docs dir, never to the repo. */
export const CITATION_RE = /(?<![\w./-])(?:(team):)?([\w./-]+\.\w+):L(\d+)(?:-L?(\d+))?/g;

function toCitation(m: RegExpMatchArray): Citation {
  const startLine = Number(m[3]);
  const c: Citation = { path: m[2].replace(/^\.\//, ''), startLine, endLine: m[4] ? Number(m[4]) : startLine };
  return m[1] ? { ...c, source: 'team' } : c;
}

/** Same source and range, whatever the text form (`L10-25` or `L10-L25`). */
export function citationKey(c: Citation): string {
  return `${c.source === 'team' ? 'team:' : ''}${c.path}:${c.startLine}-${c.endLine}`;
}

export function parseCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const c = toCitation(m);
    if (!seen.has(citationKey(c))) {
      seen.add(citationKey(c));
      citations.push(c);
    }
  }
  return citations;
}

export interface CitationInText {
  citation: Citation;
  start: number;               // offset of the citation in the text
  end: number;
  claim: string;               // the sentence that cites it, citations removed
}

/** Every citation with the sentence it supports; a sentence ends at `.`, `!` or `?` before a space, or at a line end. */
export function findCitations(text: string): CitationInText[] {
  return [...text.matchAll(CITATION_RE)].map((m) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const sentenceStart = Math.max(before.lastIndexOf('\n'), ...[...before.matchAll(/[.!?]\s/g)].map((s) => (s.index ?? 0) + 1)) + 1;
    const stop = after.search(/[.!?](\s|$)|\n/);
    const sentence = text.slice(sentenceStart, stop < 0 ? text.length : end + stop);
    return { citation: toCitation(m), start, end, claim: sentence.replace(CITATION_RE, ' ') };
  });
}

function lineCount(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function sourceRoot(c: Citation, root: string, teamDir: string): string {
  return c.source === 'team' ? teamDir : root;
}

/** The retrieved chunk of the same source that holds the whole cited range. */
function containingChunk(c: Citation, retrieved: readonly Chunk[]): Chunk | undefined {
  return retrieved.find(
    (chunk) => (chunk.source ?? 'repo') === (c.source ?? 'repo') && chunk.path === c.path && chunk.startLine <= c.startLine && c.endLine <= chunk.endLine
  );
}

/** null = valid; otherwise why the citation is wrong. Team citations resolve under `teamDir`, repo ones under `root`. */
export function validateCitation(c: Citation, root: string, retrieved: readonly Chunk[], teamDir = TEAM_DOCS_DIR): string | null {
  const base = sourceRoot(c, root, teamDir);
  const abs = path.resolve(base, c.path);
  if (path.isAbsolute(c.path) || escapesWorkspace(c.path, base) || !fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) return 'file not found';
  if (c.startLine < 1 || c.startLine > c.endLine || c.endLine > lineCount(abs)) return 'line out of range';
  // Inside one chunk, not just overlapping: lines outside what the model was shown cannot back its claim.
  return containingChunk(c, retrieved) ? null : 'not inside a retrieved chunk';
}

/** English filler that matches anything; dropped so a shared "the" never counts as support. */
const FILLER = new Set(['the', 'is', 'are', 'was', 'be', 'in', 'at', 'of', 'to', 'and', 'or', 'it', 'its', 'this', 'that', 'see', 'for', 'on', 'with', 'by', 'as', 'from', 'an', 'into', 'here', 'there', 'which']);

function contentWords(text: string): Set<string> {
  return new Set(tokenize(text).filter((w) => w.length > 2 && !FILLER.has(w)));
}

/**
 * null when the cited lines back the sentence: they share a word with it (a symbol, an identifier part, a term), which is
 * the topic's "the cited span contains the symbol or related content". A citation in a sentence about something else fails.
 */
export function checkSupport(claim: string, c: Citation, retrieved: readonly Chunk[]): string | null {
  const chunk = containingChunk(c, retrieved);
  if (!chunk) return 'not inside a retrieved chunk';
  const claimWords = contentWords(claim);
  if (claimWords.size === 0) return 'no claim next to the citation';
  const lines = chunk.text.split(/\r\n|\r|\n/).slice(c.startLine - chunk.startLine, c.endLine - chunk.startLine + 1);
  const cited = contentWords(`${chunk.symbol ?? ''}\n${lines.join('\n')}`);
  return [...claimWords].some((w) => cited.has(w)) ? null : 'cited lines do not mention what the sentence says';
}

/** OSC 8 hyperlink: terminals that support it open the file at the line, others show the plain label. */
export function fileLink(root: string, c: Citation, teamDir = TEAM_DOCS_DIR): string {
  const url = `${pathToFileURL(path.resolve(sourceRoot(c, root, teamDir), c.path)).href}#L${c.startLine}`;
  const label = `${c.source === 'team' ? 'team:' : ''}${c.path}:L${c.startLine}-L${c.endLine}`;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}
