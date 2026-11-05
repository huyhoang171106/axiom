// src/core/compaction.ts - Summarize the middle of a long conversation into 5 fixed sections (UC-04)

import type { BaseLLMProvider } from '../llm/base-provider.js';
import type { CostTracker } from '../llm/cost-tracker.js';
import type { EventBus } from './event-bus.js';
import type { TaskState } from './task-state.js';
import type { Message } from './types.js';

export const COMPACT_SECTIONS = [
  'Goal',
  'Constraints',
  'Completed steps',
  'Current state',
  'Open risks and next step',
] as const;

export type CompactSection = (typeof COMPACT_SECTIONS)[number];

export const COMPACT_THRESHOLD = 0.6;

/**
 * Returns true if token usage reaches or exceeds the threshold ratio of the context window.
 */
export function shouldCompact(usedTokens: number, contextWindow: number, threshold = COMPACT_THRESHOLD): boolean {
  if (contextWindow <= 0) return false;
  return usedTokens / contextWindow >= threshold;
}

/**
 * Returns section names from COMPACT_SECTIONS that do not have a `## <name>` heading in `summary`.
 */
export function missingSections(summary: string): string[] {
  const missing: string[] = [];
  for (const section of COMPACT_SECTIONS) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^##\\s+(?:\\d+\\.\\s*)?${escaped}\\b`, 'im');
    if (!regex.test(summary)) {
      missing.push(section);
    }
  }
  return missing;
}

/**
 * Parses markdown into section map keyed by clean heading names.
 */
function parseSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let currentTitle: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(?:(?:\d+\.\s*)?)(.+)$/);
    if (headerMatch) {
      if (currentTitle) {
        sections.set(currentTitle.toLowerCase(), currentContent.join('\n').trim());
      }
      currentTitle = headerMatch[1].trim().replace(/:$/, '');
      currentContent = [];
    } else if (currentTitle) {
      currentContent.push(line);
    }
  }
  if (currentTitle) {
    sections.set(currentTitle.toLowerCase(), currentContent.join('\n').trim());
  }
  return sections;
}

/**
 * Overrides Goal and Constraints sections with verbatim values from TaskState.
 */
function injectTaskState(summary: string, task: TaskState): string {
  const sections = parseSections(summary);

  const goalContent = task.goal;
  const constraintsList = task.constraints && task.constraints.length > 0
    ? task.constraints.map((c) => `- ${c}`).join('\n')
    : '(none)';
  const acceptanceList = task.acceptance.map((a) => `- ${a}`).join('\n');
  const constraintsContent = `${constraintsList}\n\n### Acceptance criteria\n${acceptanceList}`;

  sections.set('goal', goalContent);
  sections.set('constraints', constraintsContent);

  const out: string[] = [];
  for (const name of COMPACT_SECTIONS) {
    const content = sections.get(name.toLowerCase()) || '(không có)';
    out.push(`## ${name}\n${content}`);
  }
  return out.join('\n\n');
}

/**
 * Formats messages into clean text for the summarizer model.
 */
function formatMessagesForSummary(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      let text = `[${m.role.toUpperCase()}]: ${m.content ?? ''}`;
      if (m.toolCalls && m.toolCalls.length > 0) {
        const calls = m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ');
        text += `\n[Tool Calls]: ${calls}`;
      }
      return text;
    })
    .join('\n\n');
}

/**
 * Finds a safe split point for chat messages, keeping at least 4 messages at the end
 * while ensuring assistant tool-call and tool-result groups stay together.
 */
function findSafeSplitCutoff(chatMessages: readonly Message[]): number {
  if (chatMessages.length <= 4) return 0;

  let cutoff = chatMessages.length - 4;

  // If the message at cutoff is a tool result, step back to include the assistant message that initiated it
  while (cutoff > 0 && chatMessages[cutoff].role === 'tool') {
    cutoff--;
  }

  return cutoff;
}

/**
 * Summarizes the middle of a conversation into 5 fixed sections (Goal, Constraints,
 * Completed steps, Current state, Open risks and next step), keeping the system prompt
 * and the recent message tail.
 */
export async function compactHistory(
  messages: readonly Message[],
  opts: {
    provider: BaseLLMProvider;
    model: string;
    task?: TaskState;
    signal?: AbortSignal;
    costTracker?: CostTracker;
    eventBus?: EventBus;
  }
): Promise<{ summary: string; messages: Message[] }> {
  const systemMessage = messages.find((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');

  const cutoff = findSafeSplitCutoff(chatMessages);
  if (cutoff <= 0) {
    return { summary: '', messages: [...messages] };
  }

  const middle = chatMessages.slice(0, cutoff);
  const tail = chatMessages.slice(cutoff);

  const systemPrompt = [
    'You are a technical context summarizer for a software engineering coding agent.',
    'Your job is to summarize the middle part of a conversation between user and agent.',
    'You MUST structure your summary using exactly these five Markdown headings in order:',
    '## Goal',
    '## Constraints',
    '## Completed steps',
    '## Current state',
    '## Open risks and next step',
    'Do not omit any heading. If there is no content for a section, write "(none)".',
  ].join('\n');

  const userPrompt = [
    'Please summarize the following conversation history into the required 5 sections:',
    '',
    formatMessagesForSummary(middle),
  ].join('\n');

  // Lần 1: gửi middle cho model tóm tắt
  const response = await opts.provider.chat({
    model: opts.model,
    messages: [
      { role: 'system', content: systemPrompt, timestamp: Date.now() },
      { role: 'user', content: userPrompt, timestamp: Date.now() },
    ],
    signal: opts.signal,
  });

  if (opts.costTracker && response.usage) {
    opts.costTracker.record(opts.model, response.usage);
  }

  let summary = response.content;
  let missing = missingSections(summary);

  // Thiếu mục -> hỏi lại 1 lần kèm tên mục thiếu
  if (missing.length > 0) {
    const retryResponse = await opts.provider.chat({
      model: opts.model,
      messages: [
        { role: 'system', content: systemPrompt, timestamp: Date.now() },
        { role: 'user', content: userPrompt, timestamp: Date.now() },
        { role: 'assistant', content: summary, timestamp: Date.now() },
        {
          role: 'user',
          content: `The summary was missing the following required sections: ${missing.join(', ')}. Please provide a revised, complete summary including all 5 required headings: ${COMPACT_SECTIONS.join(', ')}.`,
          timestamp: Date.now(),
        },
      ],
      signal: opts.signal,
    });

    if (opts.costTracker && retryResponse.usage) {
      opts.costTracker.record(opts.model, retryResponse.usage);
    }

    summary = retryResponse.content;
    const stillMissing = missingSections(summary);

    // Vẫn thiếu -> thêm heading rỗng ## <tên>\n(không có) và bus.emit('error', ...)
    if (stillMissing.length > 0) {
      for (const section of stillMissing) {
        summary += `\n\n## ${section}\n(không có)`;
      }
      opts.eventBus?.emit('error', {
        message: `Compaction summary missing sections after retry: ${stillMissing.join(', ')}`,
      });
    }
  }

  // Có task -> mục Goal/Constraints chép nguyên goal, constraints, acceptance từ TaskState
  if (opts.task) {
    summary = injectTaskState(summary, opts.task);
  }

  const compactedMessages: Message[] = [];
  if (systemMessage) {
    compactedMessages.push(systemMessage);
  }
  compactedMessages.push({
    role: 'user',
    content: summary,
    timestamp: Date.now(),
  });
  compactedMessages.push(...tail);

  return { summary, messages: compactedMessages };
}
