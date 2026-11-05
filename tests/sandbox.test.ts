// tests/sandbox.test.ts - bwrap argv: default run_command shape vs the isolated shape run_tests uses
import test from 'node:test';
import assert from 'node:assert/strict';
import { bwrapInvocation } from '../src/tools/sandbox.js';

const pairs = (args: string[]) => args.map((a, i) => `${a} ${args[i + 1] ?? ''}`);

test('isolateNetwork adds --unshare-net; default does not', () => {
  const plain = bwrapInvocation('true', '/work', { bwrap: 'bwrap', home: '/home/u' });
  const isolated = bwrapInvocation('true', '/work', { bwrap: 'bwrap', home: '/home/u', isolateNetwork: true });
  assert.ok(!plain.args.includes('--unshare-net'));
  assert.ok(isolated.args.includes('--unshare-net'));
  // The command stays last, after `--`.
  assert.deepEqual(isolated.args.slice(-4), ['--', '/bin/bash', '-c', 'true']);
});

test('default keeps the read-only root bind that run_command relies on', () => {
  const { args } = bwrapInvocation('true', '/work', { bwrap: 'bwrap', home: '/home/u' });
  assert.ok(pairs(args).includes('--ro-bind /'));
  assert.ok(pairs(args).includes('--bind /work'));
});

test('readableRoots replaces the read-only root bind and hides /home', () => {
  const { args } = bwrapInvocation('true', '/work', { bwrap: 'bwrap', home: '/home/u', readableRoots: ['/', '/does/not/exist'], extraWritable: [] });
  const p = pairs(args);
  assert.ok(!p.includes('--ro-bind /'), 'the host root must not be bound');
  assert.ok(p.includes('--ro-bind /usr'));
  assert.ok(p.includes('--tmpfs /home') && p.includes('--tmpfs /tmp'));
  assert.ok(!args.includes('/does/not/exist'), 'missing roots are skipped');
  // Package caches under $HOME are not writable here; only the workspace is.
  assert.ok(!args.some((a) => a.startsWith('/home/u/')));
  assert.ok(p.includes('--bind /work'));
  // The workspace bind comes after the tmpfs mounts, so a workspace under /tmp or /home stays visible.
  assert.ok(args.lastIndexOf('--bind') > args.indexOf('--tmpfs'));
});
