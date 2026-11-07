// src/tui/components/transcript.tsx - Static completed turns and a live streaming turn
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Box, Static, Text } from 'ink';
import type { TuiTurn, TuiState } from '../store.js';
import { ToolRow } from './tool-row.js';
import { formatTelemetryLine, formatUserPromptLines, truncate, visibleWidth } from '../layout.js';
import { createTheme } from '../theme.js';
import { issueTicketSchema } from '../../agents/triage.js';
import { AskAnswerView } from './citation.js';
import { z } from 'zod';
import { redact } from '../../core/secrets.js';
import { resultText } from '../results.js';
import { IssueTicketView } from './issue-ticket.js';

function formatInlineMarkdown(text: string, theme: ReturnType<typeof createTheme>): string {
  // Bold: **text**
  let res = text.replace(/\*\*([^*]+)\*\*/g, (_, b) => theme.bold(b));
  // Inline code: `code`
  res = res.replace(/`([^`]+)`/g, (_, c) => theme.accent(c));
  return res;
}

function renderAssistantLines(
  text: string,
  theme: ReturnType<typeof createTheme>,
  width: number,
  maxLines?: number,
): ReactNode[] {
  const allLines = text.split(/\r?\n/);
  const clippedCount =
    maxLines !== undefined && maxLines > 0 && allLines.length > maxLines ? allLines.length - maxLines : 0;
  const lines = clippedCount > 0 ? allLines.slice(-maxLines!) : allLines;
  const innerW = Math.max(16, width);

  let inFence = false;
  if (clippedCount > 0) {
    for (let i = 0; i < clippedCount; i++) {
      if (allLines[i].trimStart().startsWith('```')) inFence = !inFence;
    }
  }

  const rendered: ReactNode[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trimStart();

    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        const lang = trimmed.slice(3).trim();
        const header = lang ? `╭─ [${lang}] ` : '╭── ';
        const borderLen = Math.max(0, innerW - visibleWidth(header) - 1);
        const topBorder = truncate(`${header}${'─'.repeat(borderLen)}╮`, innerW);
        rendered.push(<Text key={`fence-start-${idx}`}>{theme.muted(topBorder)}</Text>);
      } else {
        inFence = false;
        const bottomBorder = truncate(`╰${'─'.repeat(Math.max(0, innerW - 2))}╯`, innerW);
        rendered.push(<Text key={`fence-end-${idx}`}>{theme.muted(bottomBorder)}</Text>);
      }
      continue;
    }

    if (inFence) {
      rendered.push(
        <Text key={`code-${idx}`}>
          {theme.muted(`${theme.icons.bar}  `)}
          {rawLine.length > innerW - 4 ? rawLine.slice(0, innerW - 5) + '…' : rawLine}
        </Text>,
      );
      continue;
    }

    if (/^#{1,6}\s/.test(trimmed)) {
      rendered.push(<Text key={`h-${idx}`}>{theme.accent(theme.bold(truncate(rawLine, innerW)))}</Text>);
      continue;
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      const itemContent = rawLine.replace(/^(\s*)[-*•]\s+/, '$1  • ');
      rendered.push(<Text key={`bullet-${idx}`}>{formatInlineMarkdown(truncate(itemContent, innerW), theme)}</Text>);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      rendered.push(<Text key={`num-${idx}`}>{formatInlineMarkdown(truncate(rawLine, innerW), theme)}</Text>);
      continue;
    }

    if (/^>\s+/.test(trimmed)) {
      const quote = rawLine.replace(/^>\s*/, '');
      rendered.push(
        <Text key={`quote-${idx}`}>
          {theme.muted(`${theme.icons.bar} `)}
          {theme.muted(truncate(quote, innerW - 2))}
        </Text>,
      );
      continue;
    }

    rendered.push(<Text key={`text-${idx}`}>{formatInlineMarkdown(truncate(rawLine, innerW), theme)}</Text>);
  }

  if (clippedCount > 0) {
    rendered.unshift(<Text key="clipped-hint">{theme.muted(`… (+${clippedCount} dòng phía trên)`)}</Text>);
  }
  return rendered;
}

export function Turn({
  turn,
  expanded,
  width,
  maxLines,
  workspaceRoot,
}: {
  workspaceRoot?: string;
  turn: TuiTurn;
  expanded: boolean;
  width: number;
  maxLines?: number;
}) {
  const theme = createTheme();
  const cols = Math.max(20, Math.floor(width));
  const promptLines = turn.prompt
    ? formatUserPromptLines(turn.prompt, cols, { left: theme.icons.userLeft, right: theme.icons.userRight })
    : [];
  const lastThought =
    turn.thinking
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  const doneThinking = Boolean(turn.text) || turn.status === 'completed' || turn.status === 'failed';
  const thinkingLine = turn.thinking
    ? truncate(`~ think ${doneThinking ? theme.icons.success : `${theme.icons.thinking} ${lastThought}`}`, cols)
    : '';
  const errorLines = turn.error ? turn.error.split(/\r?\n/) : [];
  const preview = turn.kind === 'issue-ticket-preview' && turn.data && typeof turn.data === 'object'
    ? turn.data as { ticket?: unknown; warnings?: unknown; workspaceRoot?: unknown } : undefined;
  const ticket = preview ? issueTicketSchema.safeParse(preview.ticket) : undefined;

  const route = turn.kind === 'issue-ticket' ? z.object({ result: z.object({ route: z.string(), data: z.unknown().optional() }) }).safeParse(turn.data) : undefined;
  const kind = route?.success ? ({ answer: 'ask-answer', fix: 'fix-report', implement: 'feature-report' } as Record<string,string>)[route.data.result.route] : turn.kind;
  const data = route?.success ? route.data.result.data : turn.data;
  const structuredText = resultText(kind, data);
  const answer = kind === 'ask-answer' ? z.object({ text: z.string(), found: z.boolean(),
    citations: z.array(z.object({ path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), source: z.enum(['repo', 'team']).optional() })) }).safeParse(data) : undefined;
  return (
    <Box flexDirection="column">
      {promptLines.map((line, idx) => (
        <Text key={`p-${idx}`}>{theme.userBg(line)}</Text>
      ))}
      {thinkingLine && <Text>{theme.muted(thinkingLine)}</Text>}
      {turn.tools.map((row, index) => (
        <ToolRow key={`${row.call.id}-${index}`} row={row} expanded={expanded} width={cols} />
      ))}
      {ticket?.success && Array.isArray(preview?.warnings) && preview.warnings.every((w) => typeof w === 'string')
        && typeof preview.workspaceRoot === 'string' && (
          <IssueTicketView ticket={ticket.data} warnings={preview.warnings} width={cols} workspaceRoot={preview.workspaceRoot} />
        )}
      {answer?.success && workspaceRoot && <AskAnswerView answer={{ ...answer.data, text: redact(answer.data.text) }} root={workspaceRoot} width={cols} />}
      {!(answer?.success && workspaceRoot) && structuredText !== undefined && <Box flexDirection="column" width={cols}>
        {redact(structuredText).split(/\r?\n/).map((line, i) => <Text key={`result-${i}`} wrap="wrap">{line}</Text>)}
      </Box>}
      {!(answer?.success && workspaceRoot) && structuredText === undefined && turn.text && <Box flexDirection="column">{renderAssistantLines(redact(turn.text), theme, cols, maxLines)}</Box>}
      {errorLines.map((line, idx) => (
        <Text key={`err-${idx}`}>
          {idx === 0
            ? theme.error(truncate(`${theme.icons.error} ${line}`, cols))
            : theme.warning(truncate(`  ${line}`, cols))}
        </Text>
      ))}
      {turn.telemetry && <Text>{theme.muted(truncate(formatTelemetryLine(turn.telemetry, turn.usage), cols))}</Text>}
    </Box>
  );
}

export function Transcript({
  state,
  expanded,
  width,
  maxLiveLines,
  header,
  workspaceRoot,
}: {
  workspaceRoot?: string;
  state: TuiState;
  expanded: boolean;
  width: number;
  maxLiveLines?: number;
  header?: ReactNode;
}) {
  // Only include the startup header in revision 0; /clear increments revision so it never re-prints the welcome header.
  const includeHeader = Boolean(header) && state.revision === 0;
  const items = useMemo<('header' | TuiTurn)[]>(
    () => (includeHeader ? ['header', ...state.entries] : [...state.entries]),
    [includeHeader, state.entries],
  );

  return (
    <Box flexDirection="column">
      <Static key={state.revision} items={items}>
        {(item) => {
          if (item === 'header') {
            return <Box key="header">{header}</Box>;
          }
          return <Turn workspaceRoot={workspaceRoot} key={item.id} turn={item} expanded={false} width={width} />;
        }}
      </Static>
      {expanded &&
        state.entries
          .slice(-3)
          .flatMap((turn) =>
            turn.tools.map((row, index) => <ToolRow key={`${turn.id}-${index}`} row={row} expanded width={width} />),
          )}
      {state.live && <Turn workspaceRoot={workspaceRoot} turn={state.live} expanded={expanded} width={width} maxLines={maxLiveLines} />}
    </Box>
  );
}

