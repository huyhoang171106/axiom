import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCommandRouter } from '../src/commands/index.js';
import { CommandRouter, parseCommand, unknownCommandMessage } from '../src/commands/router.js';
import type { Command } from '../src/commands/types.js';
import { createHeadlessUI, runCli } from '../src/cli/index.js';

const stub = (name: string): Command => ({ name, summary: name, usage: `/${name}`, run: async () => {} });

test('parseCommand splits name and args only for input starting with /', () => {
  assert.deepEqual(parseCommand('/triage  abc'), { name: 'triage', args: 'abc' });
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '' });
  assert.deepEqual(parseCommand('/triage line 1\nline 2'), { name: 'triage', args: 'line 1\nline 2' });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('/'), null);
});

test('complete matches by prefix, with or without the slash', () => {
  assert.ok(defaultCommandRouter.complete('/tr').some((c) => c.name === 'triage'));
  assert.deepEqual(defaultCommandRouter.complete('model').map((c) => c.name), ['model', 'models']);
  assert.equal(defaultCommandRouter.complete('/').length, defaultCommandRouter.list().length);
});

test('every phase 1 command is registered and listed by help', async () => {
  const names = defaultCommandRouter.list().map((c) => c.name);
  for (const n of ['help', 'clear', 'exit', 'triage', 'login', 'logout', 'model', 'models']) assert.ok(names.includes(n), n);
  const help = await defaultCommandRouter.get('help')!.run('', {} as never);
  assert.ok(help && names.every((n) => help.text.includes(`/${n}`)));
});

test('registering a name twice throws', () => {
  const router = new CommandRouter();
  router.register(stub('a'));
  assert.throws(() => router.register(stub('a')), /already registered/);
});

test('unknown command suggests the closest names from complete', () => {
  assert.match(unknownCommandMessage(defaultCommandRouter, 'trage'), /Did you mean \/triage\?/);
  assert.match(unknownCommandMessage(defaultCommandRouter, 'zzz'), /Type \/help/);
});

test('axiom <command>, axiom /<command> and -p "/<command>" run the same router entry', async () => {
  const seen: string[] = [];
  defaultCommandRouter.register({ ...stub('probe'), run: async (args) => void seen.push(args) });
  await runCli(['probe', 'a', 'b']);
  await runCli(['/probe', 'a', 'b']);
  await runCli(['-p', '/probe a b']);
  assert.deepEqual(seen, ['a b', 'a b', 'a b']);
  await assert.rejects(runCli(['-p', '/prob']), /Did you mean \/probe/);
});

test('headless UI without a terminal refuses to ask and never confirms', async () => {
  const ui = createHeadlessUI();
  await assert.rejects(ui.ask('Key?'), /no terminal/);
  assert.equal(await ui.confirm('Proceed?'), false);
});
