// src/tools/policy-shell.ts - Parse only literal shell words; never evaluate shell text.
export function literalCommands(command: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [], word = '', started = false;
  let quote = '';
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === quote) quote = ''; else word += ch;
      continue;
    }
    if (ch === '$' || ch === '`') return null;
    if (ch === '\\') {
      if (++i === command.length) return null;
      if (command[i] === '\n' || command[i] === '\r') return null;
      word += command[i]; started = true; continue;
    }
    if (quote) { if (ch === quote) quote = ''; else word += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if ('<>()[{}?!~#'.includes(ch) || ch === '\0') return null;
    if (';&|\n\r'.includes(ch)) { flush(); if (words.length) commands.push(words); words = []; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    word += ch; started = true;
  }
  if (quote) return null;
  flush(); if (words.length) commands.push(words);
  return commands.length ? commands : null;
}
