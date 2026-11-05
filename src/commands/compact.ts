// src/commands/compact.ts - `compact` command (UC-04)

import { compactHistory } from '../core/compaction.js';
import { defaultSessionManager } from '../core/session.js';
import { loadCatalog } from '../llm/catalog/index.js';
import { createProviderFor, resolveModel } from '../llm/model-resolver.js';
import type { Command, CommandResult } from './types.js';

export const compactCommand: Command = {
  name: 'compact',
  summary: 'Summarize the conversation now to free context',
  usage: '/compact',
  async run(_args, ctx): Promise<CommandResult> {
    const session = defaultSessionManager.getSession() ?? defaultSessionManager.resumeLastSession();
    if (!session || session.messages.length === 0) {
      return { kind: 'compact', data: { summary: '' }, text: 'No active session or conversation history to compact.' };
    }

    const modelInfo = ctx.session?.model ?? resolveModel('@default', loadCatalog(), ctx.config);
    const provider = await createProviderFor(modelInfo);

    const { summary, messages: compactedMessages } = await compactHistory(session.messages, {
      provider,
      model: modelInfo.id,
      signal: ctx.signal,
      costTracker: ctx.costTracker,
      eventBus: ctx.bus,
    });

    if (!summary) {
      return { kind: 'compact', data: { summary: '' }, text: 'Conversation is too short to compact (less than 5 messages).' };
    }

    session.messages = compactedMessages;
    defaultSessionManager.saveSession();

    return {
      kind: 'compact',
      data: { summary },
      text: `Conversation compacted successfully.\n\n${summary}`,
    };
  },
};
