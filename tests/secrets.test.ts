import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, registerSecret, scrubEnv } from '../src/core/secrets.js';
import { decide } from '../src/tools/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { EventBus } from '../src/core/event-bus.js';

// Built at runtime so no key-shaped literal sits in the repo for secret scanners to flag.
const fakeKey = (prefix: string) => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;

test('scrubEnv drops credential variables and keeps PATH, HOME, LANG, TERM', () => {
  const env = {
    OPENROUTER_API_KEY: 'a',
    GITHUB_TOKEN: 'b',
    DB_PASSWORD: 'c',
    AWS_SECRET_ACCESS_KEY: 'd',
    SSH_AUTH_SOCK: 'e',
    PATH: '/usr/bin',
    Path: 'C:\\Windows',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    TERM: 'xterm',
    EDITOR: 'vim',
  };
  assert.deepEqual(scrubEnv(env), { PATH: '/usr/bin', Path: 'C:\\Windows', HOME: '/home/u', LANG: 'C.UTF-8', TERM: 'xterm', EDITOR: 'vim' });
  assert.equal(env.OPENROUTER_API_KEY, 'a', 'the input is not modified');
});

test('redact replaces every occurrence of a registered secret, longest first', () => {
  const key = fakeKey('sk-or');
  registerSecret(key);
  registerSecret(key.slice(0, 20));
  assert.equal(redact(`a ${key} b ${key}`), 'a ‹redacted› b ‹redacted›');
  assert.equal(redact('nothing secret here'), 'nothing secret here');
});

test('redact hides env values of secret-named variables that are at least 8 characters long', (t) => {
  const long = fakeKey('tok');
  process.env.MY_SERVICE_TOKEN = long;
  process.env.SHORT_TOKEN = 'abc1234';
  process.env.PLAIN_SETTING = 'not-a-secret-value';
  t.after(() => {
    delete process.env.MY_SERVICE_TOKEN;
    delete process.env.SHORT_TOKEN;
    delete process.env.PLAIN_SETTING;
  });
  assert.equal(redact(`${long} abc1234 not-a-secret-value`), '‹redacted› abc1234 not-a-secret-value');
});

test('env and printenv are no longer auto-allowed', () => {
  const root = os.tmpdir();
  assert.equal(decide('run_command', { command: 'printenv' }, root).verdict, 'ask');
  assert.equal(decide('run_command', { command: 'printenv OPENROUTER_API_KEY' }, root).verdict, 'ask');
  assert.equal(decide('run_command', { command: 'env' }, root).verdict, 'ask');
  assert.equal(decide('run_command', { command: 'echo hi' }, root).verdict, 'allow');
});

test('executeTool redacts tool output and error messages', async () => {
  const key = fakeKey('sk-ant');
  registerSecret(key);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-secrets-'));
  fs.writeFileSync(path.join(root, 'config.py'), `API_KEY = "${key}"\n`);
  const registry = new ToolRegistry(['read_file']);

  const ok = await registry.executeTool('read_file', { path: 'config.py' }, { workspaceRoot: root });
  assert.ok(!ok.isError && !ok.output.includes(key) && ok.output.includes('‹redacted›'));

  const failed = await registry.executeTool('read_file', { path: `missing-${key}.py` }, { workspaceRoot: root });
  assert.ok(failed.isError && !failed.output.includes(key) && !failed.error?.includes(key));
});

// bash.ts runs /bin/bash, which Windows does not have; CI (Linux) always runs this test.
test('printenv and echo $OPENROUTER_API_KEY do not reveal the key', { skip: !fs.existsSync('/bin/bash') && 'needs /bin/bash' }, async (t) => {
  const key = fakeKey('sk-or-v1');
  process.env.OPENROUTER_API_KEY = key;
  t.after(() => delete process.env.OPENROUTER_API_KEY);
  const registry = new ToolRegistry(['run_command']);
  registry.approver = async () => 'approve'; // the worst case: a human approved printenv
  const run = (command: string) => registry.executeTool('run_command', { command }, { workspaceRoot: os.tmpdir() });

  for (const command of ['printenv', 'env', 'echo $OPENROUTER_API_KEY', 'printenv OPENROUTER_API_KEY']) {
    const result = await run(command);
    assert.ok(!result.output.includes(key), command);
  }
  const kept = await run('echo "$PATH|$HOME"');
  assert.match(kept.output, /^[^|]+\|[^|]+$/, 'PATH and HOME still reach the child');
});

test('EventBus default error handler redacts secrets in emitted errors', (t) => {
  const key = fakeKey('sk-ant');
  registerSecret(key);
  const bus = new EventBus();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.error = originalError;
  });

  bus.emit('error', { message: `provider failed with token: ${key}` });
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes(key), 'Printed error must not contain raw secret');
  assert.ok(errors[0].includes('‹redacted›'), 'Raw secret must be redacted');
});
