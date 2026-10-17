import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAuth, readAxiomEnv, removeCredential, saveCredential } from '../src/llm/auth/store.js';

const tempHome = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')), 'home');
const isPosix = process.platform !== 'win32';

test('saved credentials read back and logout removes only that provider', () => {
  const home = tempHome();
  saveCredential('deepseek', { type: 'api_key', key: 'sk-deep' }, home);
  saveCredential('kimi-code', { type: 'oauth', access: 'acc', refresh: 'ref', expires: 123 }, home);
  assert.deepEqual(readAuth(home), {
    deepseek: { type: 'api_key', key: 'sk-deep' },
    'kimi-code': { type: 'oauth', access: 'acc', refresh: 'ref', expires: 123 },
  });
  assert.equal(removeCredential('deepseek', home), true);
  assert.equal(removeCredential('deepseek', home), false);
  assert.deepEqual(Object.keys(readAuth(home)), ['kimi-code']);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
});

test('auth.json is 0600 and the home directory 0700', { skip: !isPosix && 'POSIX modes only' }, () => {
  const home = tempHome();
  saveCredential('groq', { type: 'api_key', key: 'gsk' }, home);
  assert.equal(fs.statSync(path.join(home, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});

test('a broken auth.json reads as empty but is never overwritten', () => {
  const home = tempHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), '{ not json');
  assert.deepEqual(readAuth(home), {});
  assert.throws(() => saveCredential('groq', { type: 'api_key', key: 'gsk' }, home), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), '{ not json');
});

test('entries with an unknown shape are skipped', () => {
  const home = tempHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ a: { type: 'api_key', key: 'k' }, b: { type: 'magic' } }));
  assert.deepEqual(Object.keys(readAuth(home)), ['a']);
});

test('~/.axiom/.env parses KEY=VALUE, export and quotes, skipping comments', () => {
  const home = tempHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.env'), '# comment\nGROQ_API_KEY=gsk-1\r\nexport ZAI_API_KEY="z 2"\nBAD LINE\nEMPTY=\n');
  assert.deepEqual(readAxiomEnv(home), { GROQ_API_KEY: 'gsk-1', ZAI_API_KEY: 'z 2', EMPTY: '' });
  assert.deepEqual(readAxiomEnv(tempHome()), {});
});
