import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/tools/permissions.js';
for (const command of ['echo "$(rm a)"', 'echo "`rm a`"', 'cat "$FILE"', 'cat /etc/passwd', 'cat ../../outside', 'ls && cat /etc/passwd', 'cat <(cat /etc/passwd)', '(git push origin main)', 'cat *.pem']) {
  test(`shell cannot silently execute ${command}`, () => {
    assert.notEqual(decide('run_command', { command }, process.cwd()).verdict, 'allow');
  });
}
