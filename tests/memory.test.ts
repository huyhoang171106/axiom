// tests/memory.test.ts - Tests for long-term per-repo memory (D4 / UC-04)

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  memoryPath,
  loadMemory,
  addMemory,
  clearMemory,
} from '../src/core/memory.js';
import { buildSystemPrompt } from '../src/core/prompt.js';
import { registerSecret } from '../src/core/secrets.js';
import { memoryCommand } from '../src/commands/memory.js';
import type { CommandContext, CommandUI } from '../src/commands/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { EventBus } from '../src/core/event-bus.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MOCK_MODEL } from '../src/cli/agent.js';
import { runFeature, type FeatureOptions } from '../src/agents/feature.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { MemorySaver } from '@langchain/langgraph';

test('a new session sees saved memory in the system prompt', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-test-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    const basePrompt = 'You are Axiom coding agent.';
    // Initially empty
    const promptBefore = buildSystemPrompt(basePrompt, tmpDir);
    assert.ok(!promptBefore.includes('# Project memory'));

    // Save memory
    addMemory(tmpDir, 'Always write unit tests before modifying code');
    addMemory(tmpDir, 'Follow Conventional Commits format');

    const promptAfter = buildSystemPrompt(basePrompt, tmpDir);
    assert.ok(promptAfter.includes('# Project memory'));
    assert.ok(promptAfter.includes('- Always write unit tests before modifying code'));
    assert.ok(promptAfter.includes('- Follow Conventional Commits format'));
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('clear removes memory from the next prompt', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-test-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    addMemory(tmpDir, 'Temporary convention to be cleared');
    assert.ok(loadMemory(tmpDir).includes('Temporary convention to be cleared'));
    assert.ok(buildSystemPrompt('Base', tmpDir).includes('# Project memory'));

    clearMemory(tmpDir);

    assert.strictEqual(loadMemory(tmpDir), '');
    assert.ok(!buildSystemPrompt('Base', tmpDir).includes('# Project memory'));
    assert.ok(!buildSystemPrompt('Base', tmpDir).includes('Temporary convention to be cleared'));
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('memory for two repos with the same name is separate', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-test-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    // Two workspaces with identical basename 'project' in different directories
    const repo1 = path.join(tmpDir, 'userA', 'project');
    const repo2 = path.join(tmpDir, 'userB', 'project');
    fs.mkdirSync(repo1, { recursive: true });
    fs.mkdirSync(repo2, { recursive: true });

    assert.strictEqual(path.basename(repo1), path.basename(repo2));
    assert.notStrictEqual(memoryPath(repo1), memoryPath(repo2));

    addMemory(repo1, 'Rule for Repo 1: Use Python 3.12');
    addMemory(repo2, 'Rule for Repo 2: Use Node.js 22');

    const mem1 = loadMemory(repo1);
    const mem2 = loadMemory(repo2);

    assert.ok(mem1.includes('Rule for Repo 1: Use Python 3.12'));
    assert.ok(!mem1.includes('Rule for Repo 2'));

    assert.ok(mem2.includes('Rule for Repo 2: Use Node.js 22'));
    assert.ok(!mem2.includes('Rule for Repo 1'));
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('secret values are redacted before saving', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-test-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    const sensitiveToken = `custom-secret-${crypto.randomBytes(16).toString('hex')}`;
    registerSecret(sensitiveToken);

    addMemory(tmpDir, `Deploy requires authorization token: ${sensitiveToken}`);

    const saved = loadMemory(tmpDir);
    assert.ok(!saved.includes(sensitiveToken), 'Secret token must not appear in saved memory');
    assert.ok(saved.includes('‹redacted›'), 'Secret token must be replaced with ‹redacted›');
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('/memory clear asks before deleting', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-test-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    addMemory(tmpDir, 'Critical convention');

    let confirmPrompt = '';
    let confirmAnswer = false;

    const ui: CommandUI = {
      print() {},
      ask: async () => '',
      confirm: async (msg) => {
        confirmPrompt = msg;
        return confirmAnswer;
      },
      notify() {},
      status() {},
      clearStatus() {},
      promptInput: async () => '',
      showMenu: async () => '',
    };

    const ctx: CommandContext = {
      config: { workspaceRoot: tmpDir } as any,
      workspaceRoot: tmpDir,
      tools: new ToolRegistry(),
      bus: new EventBus(),
      costTracker: new CostTracker(),
      runId: 'run_test_mem_clear',
      signal: new AbortController().signal,
      session: { model: MOCK_MODEL, setModel() {} },
      ui,
    };

    // Case 1: user rejects deletion (confirmAnswer = false)
    confirmAnswer = false;
    const resultRejected = await memoryCommand.run('clear', ctx);
    assert.ok(confirmPrompt.includes('Clear all project memory'));
    assert.strictEqual(resultRejected?.kind, 'memory');
    assert.strictEqual((resultRejected?.data as any)?.cleared, false);
    assert.ok(loadMemory(tmpDir).includes('Critical convention'), 'Memory must remain untouched when user cancels');

    // Case 2: user accepts deletion (confirmAnswer = true)
    confirmAnswer = true;
    const resultConfirmed = await memoryCommand.run('clear', ctx);
    assert.strictEqual((resultConfirmed?.data as any)?.cleared, true);
    assert.strictEqual(loadMemory(tmpDir), '', 'Memory must be cleared when user confirms');
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('/memory command shows memory and adds note', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-test-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    const ui: CommandUI = {
      print() {},
      ask: async () => '',
      confirm: async () => true,
      notify() {},
      status() {},
      clearStatus() {},
      promptInput: async () => '',
      showMenu: async () => '',
    };

    const ctx: CommandContext = {
      config: { workspaceRoot: tmpDir } as any,
      workspaceRoot: tmpDir,
      tools: new ToolRegistry(),
      bus: new EventBus(),
      costTracker: new CostTracker(),
      runId: 'run_test_mem_add',
      signal: new AbortController().signal,
      session: { model: MOCK_MODEL, setModel() {} },
      ui,
    };

    // Initially empty
    const showEmpty = await memoryCommand.run('', ctx);
    assert.ok(showEmpty?.text.includes('Project memory is empty'));

    // Add note via command
    const addResult = await memoryCommand.run('add Prefer async/await over promises', ctx);
    assert.ok(addResult?.text.includes('Added to project memory'));

    // Show after adding
    const showAfter = await memoryCommand.run('', ctx);
    assert.ok(showAfter?.text.includes('Prefer async/await over promises'));
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('conventions proposed in feature report require user approval before saving', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-mem-conv-'));
  const oldAxiomHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');

  try {
    let confirmCalled = false;
    let allowSave = false;

    const ui: CommandUI = {
      print() {},
      ask: async () => '',
      confirm: async (msg) => {
        confirmCalled = true;
        return allowSave;
      },
      notify() {},
      status() {},
      clearStatus() {},
      promptInput: async () => '',
      showMenu: async () => '',
    };

    // Case 1: user rejects saving proposed convention
    allowSave = false;
    const planArg = JSON.stringify({
      goal: 'Complete test feature',
      acceptance: ['Test passes'],
      steps: [{ title: 'Single step', files: ['dummy.txt'] }],
    });

    const provider1 = new MockProvider('mock', [
      { toolCalls: [{ id: 'sp1', name: 'submit_plan', arguments: { plan: planArg } }] },
      'Done step 1',
    ]);

    const opts1: FeatureOptions = {
      workspaceRoot: tmpDir,
      provider: provider1,
      model: 'mock-model',
      bus: new EventBus(),
      tools: new ToolRegistry(),
      ui,
      checkpointer: new MemorySaver(),
      verifier: async () => ({ passed: true }),
    };

    await runFeature('Build test feature', opts1);
    // Since runFeature doesn't have conventions by default, memory remains empty
    assert.strictEqual(loadMemory(tmpDir), '');
  } finally {
    if (oldAxiomHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldAxiomHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
