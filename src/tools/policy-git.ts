// src/tools/policy-git.ts - Inspect push destinations without running a push or a shell.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { PolicyDecision } from './permissions.js';

const protectedRef = (ref: string) => /^(?:refs\/heads\/)?(?:main|master)$/.test(ref);
export function pushDecision(words: readonly string[], root: string): PolicyDecision | null {
  if (words[0] !== 'git') return null;
  let i = 1, cwd = root;
  const config: string[] = [];
  while (words[i] === '-C' || words[i] === '-c') {
    if (words[i] === '-C') cwd = path.resolve(cwd, words[i + 1] ?? '');
    else config.push('-c', words[i + 1] ?? '');
    i += 2;
  }
  if (words[i] !== 'push') return null;
  const ask: PolicyDecision = { verdict: 'ask', risk: 'high', reason: 'remote push requires approval' };
  const deny: PolicyDecision = { verdict: 'deny', risk: 'high', reason: 'push may update main or master' };
  const args = words.slice(i + 1);
  if (args.some((arg) => ['--all', '--mirror', '--prune'].includes(arg) || arg.includes('*') || arg === ':')) return deny;
  const operands = args.filter((arg) => !['--', '--force', '--force-with-lease', '--force-if-includes', '-f', '--tags', '--delete', '-d', '--dry-run', '-n', '--verbose', '-v', '--atomic', '--porcelain', '--no-verify', '--set-upstream', '-u'].includes(arg) && !arg.startsWith('--force-with-lease='));
  if (operands.some((arg) => arg.startsWith('-'))) {
    if (operands.some((arg) => protectedRef(arg.replace(/^\+/, '').split(':').at(-1) ?? ''))) return deny;
    return ask;
  }
  const git = (...argv: string[]) => {
    try { return execFileSync('git', ['-C', cwd, ...config, ...argv], { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; } // Missing context must never produce allow.
  };
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const remote = operands[0] || git('config', '--get', `branch.${branch}.pushRemote`) || git('config', '--get', 'remote.pushDefault') || git('config', '--get', `branch.${branch}.remote`) || 'origin';
  if (git('config', '--get', `remote.${remote}.mirror`) === 'true') return deny;
  let specs = operands.slice(1);
  if (!specs.length) {
    specs = git('config', '--get-all', `remote.${remote}.push`).split('\n').filter(Boolean);
    if (!specs.length) {
      const mode = git('config', '--get', 'push.default') || 'simple';
      if (mode === 'matching') return deny;
      if (protectedRef(branch)) return deny;
      if (['simple', 'upstream', 'tracking'].includes(mode)) {
        const upstream = git('config', '--get', `branch.${branch}.merge`);
        if (protectedRef(upstream)) return deny;
      }
      return ask;
    }
  }
  for (const spec of specs) {
    const clean = spec.replace(/^\+/, '');
    if (clean.includes('*') || clean === ':') return deny;
    const destination = clean.includes(':') ? clean.slice(clean.indexOf(':') + 1) : clean === 'HEAD' ? branch : clean;
    if (protectedRef(destination)) return deny;
  }
  return ask;
}
