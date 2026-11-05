// src/tools/denied-actions.ts - Identity của hành động đã từ chối trong một session.
import fs from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff } from './apply-patch.js';

/** Resolve cả ancestor của file chưa tồn tại; không gộp hai workspace khác nhau. */
export function canonicalActionPath(target: string, workspaceRoot: string): string {
  let current = path.resolve(workspaceRoot, target);
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const resolved = path.join(fs.realpathSync.native(current), ...tail);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Chỉ parse literal; không chạy shell để suy ra identity. Giữ ranh giới argv và quotes. */
function splitCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = '', started = false, quote = '', quotedAssignment = false;
  const flush = () => {
    if (quotedAssignment && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && words.every((previous) => ['env', 'command', 'exec', 'sudo'].includes(previous))) {
      throw new Error('quoted assignment prefix');
    }
    if (started) words.push(word);
    word = ''; started = false; quotedAssignment = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === quote) quote = ''; else word += ch;
      continue;
    }
    if (ch === '\\') {
      if (!word.includes('=')) quotedAssignment = true;
      const next = command[++i];
      if (next === undefined) throw new Error('unfinished shell escape');
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += '\\';
      if (next !== '\n') word += next;
      started = true;
      continue;
    }
    if (ch === '$' || ch === '`') throw new Error('dynamic shell expansion');
    if (quote) { if (ch === quote) quote = ''; else word += ch; continue; }
    if (ch === '"' || ch === "'") { if (!word.includes('=')) quotedAssignment = true; quote = ch; started = true; continue; }
    if ('<>()[{}*?~#\0'.includes(ch)) throw new Error('unsupported shell syntax');
    if (';&|\n\r'.includes(ch)) {
      flush();
      if (words.length) commands.push(words);
      words = [];
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    word += ch; started = true;
  }
  if (quote) throw new Error('unfinished shell quote');
  flush();
  if (words.length) commands.push(words);
  if (!commands.length) throw new Error('empty command');
  return commands;
}

function executable(word: string): string {
  // Chỉ alias binary chuẩn; ./rm có thể là chương trình khác trong workspace.
  const normalized = path.posix.normalize(word);
  return /^\/(?:usr\/)?bin\/[^/]+$/.test(normalized) ? path.posix.basename(normalized) : word;
}

function unwrap(words: string[], depth: number): string[][] {
  if (depth > 16) throw new Error('too many shell wrappers');
  words = [...words];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift();
  const name = executable(words[0] ?? '');
  if (['env', 'command', 'exec', 'sudo'].includes(name)) {
    words.shift();
    if (words[0] === '--') words.shift();
    if (words[0]?.startsWith('-')) throw new Error('unsupported wrapper options');
    return unwrap(words, depth + 1);
  }
  if (['sh', 'bash'].includes(name)) {
    if (words.length !== 3 || words[1] !== '-c') throw new Error('unsupported shell wrapper');
    return splitCommands(words[2]).flatMap((inner) => unwrap(inner, depth + 1));
  }
  if (!words.length) throw new Error('wrapper has no command');
  words[0] = name;
  return [words];
}

const PATH_COMMANDS = new Set(['rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'cat', 'ls', 'head', 'tail', 'stat', 'wc']);
const MUTATIONS = new Set(['rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir']);
const READ_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'stat', 'wc', 'pwd', 'echo', 'whoami', 'id', 'which']);

function normalizeWords(words: string[], root: string): string[] {
  words = [...words];
  if (words[0] === 'pip3') words[0] = 'pip';
  if (/^python3?$/.test(words[0]) && words[1] === '-m' && words[2] === 'pip') words.splice(0, 3, 'pip');
  if (words[0] === 'npm' && words[1] === 'i') words[1] = 'install';
  if (words[0] === 'unlink') words[0] = 'rm';
  if (PATH_COMMANDS.has(words[0])) {
    let operandsOnly = false;
    for (let i = 1; i < words.length; i++) {
      if (!operandsOnly && words[i] === '--') { operandsOnly = true; continue; }
      if (!operandsOnly && words[i].startsWith('-')) continue;
      words[i] = canonicalActionPath(words[i], root);
    }
  }
  if (words[0] === 'rm') {
    const flags = new Set<string>(), operands: string[] = [];
    for (const word of words.slice(1)) {
      if (word === '--') continue;
      if (word === '--force') flags.add('f');
      else if (word === '--recursive') flags.add('r');
      else if (/^-[fRrv]+$/.test(word)) for (const flag of word.slice(1)) flags.add(flag === 'R' ? 'r' : flag);
      else operands.push(word);
    }
    words = ['rm', ...[...flags].sort().map((flag) => `-${flag}`), ...operands];
  }
  return words;
}

/** JSON argv thay vì join(' '): `"a b"` không trùng hai arguments `a b`. */
export function normalizeCommand(command: string, workspaceRoot = process.cwd()): string[] {
  return splitCommands(command).flatMap((words) => unwrap(words, 0))
    .map((words) => JSON.stringify(normalizeWords(words, workspaceRoot)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface CommandActions { keys: string[]; mutationPaths: string[]; opaque: boolean }

/** Shell không biết (interpreter, đổi cwd, script...) không được dùng để lách denial hiện có. */
export function commandActions(command: string, workspaceRoot: string): CommandActions {
  let segments: string[];
  try { segments = normalizeCommand(command, workspaceRoot); }
  catch { return { keys: [`run_command:opaque:${stableJson([canonicalActionPath('.', workspaceRoot), command])}`], mutationPaths: [], opaque: true }; }
  const keys: string[] = [], mutationPaths: string[] = [];
  let opaque = false;
  for (const segment of segments) {
    const words = JSON.parse(segment) as string[];
    keys.push(`run_command:${JSON.stringify([canonicalActionPath('.', workspaceRoot), words])}`);
    if (MUTATIONS.has(words[0])) {
      const operands = words.slice(1).filter((word) => !word.startsWith('-'));
      const targets = words[0] === 'cp' ? operands.slice(-1) : operands;
      const safeFlags: Record<string, RegExp> = {
        rm: /^-[frvidI]+$/, mv: /^-[finv]+$/, cp: /^-[rRfapvn]+$/,
        touch: /^-[amc]+$/, mkdir: /^-[pv]+$/, rmdir: /^-[pv]+$/,
      };
      if (!targets.length || words.slice(1).some((word) => word.startsWith('-') && !safeFlags[words[0]].test(word))) opaque = true;
      for (const target of targets) { mutationPaths.push(target); keys.push(`mutation:${target}`); }
    } else if (['pip', 'npm', 'pnpm', 'uv', 'poetry'].includes(words[0]) && ['install', 'add'].includes(words[1])) {
      for (const spec of words.slice(2)) {
        if (['-q', '--quiet', '-U', '--upgrade', '--no-input', '--disable-pip-version-check', '--user'].includes(spec)) continue;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._@/!=<>+~-]*$/.test(spec) || spec.includes('/') || spec.startsWith('-')) { opaque = true; continue; }
        keys.push(`package-install:${canonicalActionPath('.', workspaceRoot)}:${words[0]}:${spec}`);
      }
    } else if (!(READ_COMMANDS.has(words[0]) || (words[0] === 'git' && ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'].includes(words[1]) && !words.some((word) => word.startsWith('--output'))))) {
      opaque = true;
    }
  }
  return { keys, mutationPaths, opaque };
}

/** Một key cho caller cũ; gate dùng actionKeys để kiểm riêng từng hành động. */
export function actionKey(name: string, args: Record<string, unknown>, workspaceRoot = process.cwd()): string {
  const keys = actionKeys(name, args, workspaceRoot);
  return keys.length === 1 ? keys[0] : `actions:${JSON.stringify(keys)}`;
}

export function actionKeys(name: string, args: Record<string, unknown>, workspaceRoot = process.cwd()): string[] {
  if (name === 'run_command') return commandActions(String(args.command ?? ''), workspaceRoot).keys;
  if (name === 'apply_patch') {
    return [...new Set(parseUnifiedDiff(String(args.patch ?? '')).flatMap((p) => [p.oldPath, p.newPath])
      .filter((p): p is string => p !== null).map((p) => `mutation:${canonicalActionPath(p, workspaceRoot)}`))];
  }
  if (typeof args.path === 'string') {
    const target = canonicalActionPath(args.path.trim(), workspaceRoot);
    return [`${['write_file', 'edit'].includes(name) ? 'mutation' : name}:${target}`];
  }
  return [`${name}:${stableJson(args)}`];
}

export class DeniedActions {
  private readonly keys = new Set<string>();
  add(key: string): void {
    // Caller seam cũ có thể lưu key tổng hợp; mở lại thành từng identity cho gate mới.
    if (key.startsWith('actions:')) {
      for (const action of JSON.parse(key.slice('actions:'.length)) as string[]) this.add(action);
    } else this.keys.add(key);
  }
  has(key: string): boolean {
    if (key.startsWith('actions:')) return (JSON.parse(key.slice('actions:'.length)) as string[]).some((action) => this.has(action));
    if (this.keys.has(key)) return true;
    if (!key.startsWith('mutation:')) return false;
    const target = key.slice('mutation:'.length);
    for (const denied of this.keys) {
      if (!denied.startsWith('mutation:')) continue;
      const previous = denied.slice('mutation:'.length);
      if (target.startsWith(previous + path.sep) || previous.startsWith(target + path.sep)) return true;
    }
    return false;
  }
  clear(): void { this.keys.clear(); }
  get size(): number { return this.keys.size; }
}
