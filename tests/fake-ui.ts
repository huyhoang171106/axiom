// tests/fake-ui.ts - CommandUI that answers from a list and records what was printed and asked

import type { CommandUI } from '../src/commands/types.js';

export function fakeUI(answers: string[] = [], confirm = false): CommandUI & { printed: string[]; asked: string[] } {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    printed,
    asked,
    print: (text) => void printed.push(text),
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
    confirm: async () => confirm,
  };
}
