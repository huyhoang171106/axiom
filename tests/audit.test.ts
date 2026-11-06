// tests/audit.test.ts - Lưu trữ audit và đọc lịch sử qua command chung.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordDecision, readAudit, type AuditEntry } from '../src/core/audit.js';
import { auditCommand } from '../src/commands/audit.js';
import type { CommandContext } from '../src/commands/types.js';
import { registerSecret } from '../src/core/secrets.js';

function home(t: { after(fn: () => void): void }) {
  const previous = process.env.AXIOM_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-audit-'));
  process.env.AXIOM_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function entry(index: number): AuditEntry {
  return { at: new Date(index).toISOString(), runId: 'audit-storage-test', tool: 'read_file',
    args: { path: `file-${index}` }, reason: 'allowed by policy', risk: 'low', decision: 'allow', approver: 'policy' };
}

test('audit storage appends JSON lines and defaults to the latest 50 in chronological order', (t) => {
  const root = home(t);
  assert.deepEqual(readAudit(), []);
  for (let i = 0; i < 55; i++) recordDecision(entry(i));
  assert.deepEqual(readAudit(), Array.from({ length: 50 }, (_, i) => entry(i + 5)));
  assert.deepEqual(readAudit(2), [entry(53), entry(54)]);
  assert.equal(fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n').length, 55);
});

test('secret values in args are redacted', (t) => {
  const root = home(t);
  const secret = 'audit-fixture-sensitive-value';
  registerSecret(secret);
  const record = { ...entry(1), args: { nested: [{ value: secret }], long: secret + 'x'.repeat(700) }, reason: secret };
  recordDecision(record);
  const raw = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8');
  assert.equal(raw.includes(secret), false);
  assert.equal(readAudit()[0].reason.includes(secret), false);
  assert.equal((readAudit()[0].args.long as string).length, 500);
  assert.equal(record.args.nested[0].value, secret);
});

test('audit file is private on POSIX including an existing permissive file', (t) => {
  const root = home(t);
  const file = path.join(root, 'audit.jsonl');
  fs.writeFileSync(file, '', { mode: 0o666 });
  recordDecision(entry(1));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readAudit(), [entry(1)]);
});

test('/audit prints newest entries first', async (t) => {
  home(t);
  for (let i = 0; i < 3; i++) recordDecision(entry(i));
  const result = await auditCommand.run('2', {} as CommandContext);
  assert.equal(result?.kind, 'audit');
  assert.deepEqual(result?.data, [entry(2), entry(1)]);
  assert.ok(result!.text.indexOf('file-2') < result!.text.indexOf('file-1'));
  assert.equal(result!.text.includes('file-0'), false);
  await assert.rejects(auditCommand.run('invalid', {} as CommandContext), /positive integer/);
});
