import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/tools/permissions.js';
for (const command of ['echo "$(rm a)"', 'echo "`rm a`"', 'cat "$FILE"', 'cat /etc/passwd', 'cat ../../outside', 'ls && cat /etc/passwd', 'cat <(cat /etc/passwd)', '(git push origin main)', 'cat *.pem']) {
  test(`shell cannot silently execute ${command}`, () => {
    assert.notEqual(decide('run_command', { command }, process.cwd()).verdict, 'allow');
  });
}
test('quoted helper options do not bypass the read-only allowlist', () => {
  for (const command of ['rg "--pre" "sh helper" pattern', 'sort "-o" output input', 'git branch "-D" feature']) {
    assert.equal(decide('run_command', { command }, process.cwd()).verdict, 'ask', command);
  }
  assert.equal(decide('run_command', { command: 'cat "README.md"' }, process.cwd()).verdict, 'allow');
});
