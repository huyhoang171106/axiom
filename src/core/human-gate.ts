// src/core/human-gate.ts - Human checkpoints between workflow nodes: interrupt() to pause, Command({ resume }) to go on

import { Command, interrupt } from '@langchain/langgraph';
import type { CommandUI } from './execution-context.js';

export interface HumanQuestion {
  question: string;
  choices: readonly string[];
}

/**
 * Pauses the graph until `runGraph` gets an answer. Call it only in a node with no side effects before it:
 * on resume LangGraph runs the whole node again (DESIGN.md decision 2026-11-03).
 */
export function askHuman(question: string, choices: readonly string[]): string {
  const payload: HumanQuestion = { question, choices };
  const answer: unknown = interrupt(payload);
  return typeof answer === 'string' && choices.includes(answer) ? answer : choices[choices.length - 1];
}

type GraphConfig = { configurable: { thread_id: string }; signal?: AbortSignal };

/** The part of a compiled LangGraph graph `runGraph` uses. */
export interface CompiledGraph {
  invoke(input: unknown, config: GraphConfig): Promise<unknown>;
}

function pendingQuestion(result: unknown): HumanQuestion | undefined {
  if (typeof result !== 'object' || result === null || !('__interrupt__' in result)) return undefined;
  const interrupts = (result as { __interrupt__: unknown }).__interrupt__;
  if (!Array.isArray(interrupts) || interrupts.length === 0) return undefined;
  const value: unknown = (interrupts[0] as { value?: unknown })?.value;
  const q = value as Partial<HumanQuestion> | undefined;
  if (typeof q?.question !== 'string' || !Array.isArray(q.choices) || q.choices.length === 0) {
    throw new Error(`Graph paused with an unknown interrupt: ${JSON.stringify(value)}`);
  }
  return { question: q.question, choices: q.choices.map(String) };
}

/**
 * yes/no goes through `ui.confirm`, so headless without a TTY answers no and `--yes` answers yes. Other choices
 * go through `ui.ask`; an answer that is not a choice becomes the last choice.
 */
async function answer(ui: CommandUI, q: HumanQuestion): Promise<string> {
  if (q.choices.length === 2 && q.choices.includes('yes') && q.choices.includes('no')) {
    return (await ui.confirm(q.question)) ? 'yes' : 'no';
  }
  const reply = (await ui.ask(`${q.question} (${q.choices.join('/')})`)).trim();
  return q.choices.includes(reply) ? reply : q.choices[q.choices.length - 1];
}

/** Runs `graph` to the end on `threadId`, asking `ui` at every `askHuman`. `input: null` continues from the last checkpoint. */
export async function runGraph<S>(
  graph: CompiledGraph,
  input: Partial<S> | null,
  opts: { threadId: string; ui: CommandUI; signal?: AbortSignal }
): Promise<S> {
  const config: GraphConfig = { configurable: { thread_id: opts.threadId }, signal: opts.signal };
  let result = await graph.invoke(input, config);
  for (let q = pendingQuestion(result); q; q = pendingQuestion(result)) {
    if (opts.signal?.aborted) throw new Error('Cancelled');
    result = await graph.invoke(new Command({ resume: await answer(opts.ui, q) }), config);
  }
  return result as S;
}
