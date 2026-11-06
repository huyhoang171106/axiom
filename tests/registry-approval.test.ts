// tests/registry-approval.test.ts - Kiểm tra policy của tham số thực sự được thực thi.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../src/tools/registry.js';

test('approval cannot authorize a path moved outside the workspace while waiting', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-wait-policy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  const configDir = path.join(root, '.github');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(outside);
  const registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => {
    asked++;
    // Mô phỏng filesystem đổi trong lúc người dùng đang xem hộp duyệt.
    fs.rmdirSync(configDir);
    fs.symlinkSync(outside, configDir, 'junction');
    return 'approve';
  };
  const result = await registry.executeTool('write_file', { path: '.github/new.yml', content: 'blocked' }, { workspaceRoot: root });
  assert.equal(asked, 1);
  assert.equal(result.isError, true);
  assert.equal(result.metadata?.success, false);
  assert.equal((result.metadata?.policy as { verdict: string }).verdict, 'deny');
  assert.equal(fs.existsSync(path.join(outside, 'new.yml')), false);
});

test('editedArgs are re-checked by decide and run with the edited args', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-edited-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  let asked = 0;
  registry.approver = async () => {
    asked++;
    return { editedArgs: { path: 'note.txt', content: 'approved content' } };
  };
  const result = await registry.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
  assert.equal(asked, 1);
  assert.equal(result.isError, false);
  assert.equal(result.metadata?.success, true);
  assert.deepEqual(result.metadata?.policy, { verdict: 'allow', risk: 'low', reason: 'allowed by policy', approval: 'edited' });
  assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'note.txt'), 'utf8'), 'approved content');
  assert.deepEqual(fs.readdirSync(root), ['note.txt']);
});

test('approve runs the tool once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-e3-approve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  let executions = 0;
  const tool = registry.getTool('write_file')!;
  const execute = tool.execute.bind(tool);
  tool.execute = async (args, context) => { executions++; return execute(args, context); };
  registry.approver = async () => 'approve';
  const result = await registry.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
  assert.equal(result.isError, false);
  assert.equal(executions, 1);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{}');
});

test('deny returns the refusal to the model and never runs the tool', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-e3-deny-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registry.approver = async () => 'deny';
  const result = await registry.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
  assert.equal(result.isError, true);
  assert.match(result.output, /Denied by user/);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
});

test('edited arguments cannot override a hard denial', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-edited-denial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registry.approver = async () => ({ editedArgs: { path: '.env', content: 'blocked' } });
  const result = await registry.executeTool('write_file', { path: 'package.json', content: '{}' }, { workspaceRoot: root });
  assert.equal(result.isError, true);
  assert.equal(result.metadata?.success, false);
  assert.equal((result.metadata?.policy as { verdict: string }).verdict, 'deny');
  assert.deepEqual(fs.readdirSync(root), []);
});
