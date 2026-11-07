// tests/session-mode-prompt.test.ts - Kiểm tra API trạng thái phiên, cập nhật prompt và kiểm soát side effects
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/core/session.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  READ_ONLY_TOOLS,
  PLAN_MODE_SYSTEM_DIRECTIVE,
  applyMode,
  type PolicyDecision,
} from '../src/tools/permissions.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { MockProvider } from '../src/llm/providers/mock.js';
import { fixIssue } from '../src/agents/fix.js';
import { runFeature } from '../src/agents/feature.js';
import { defaultEventBus } from '../src/core/event-bus.js';

test('SessionManager manages permissionMode and planMode with defaults and persistence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-session-mode-'));
  try {
    const sm = new SessionManager({ sessionsDir: tmpDir, autoSave: true });
    sm.createSession('test prompt');

    // Default mode is 'edit', default planMode is false
    assert.equal(sm.getPermissionMode(), 'edit');
    assert.equal(sm.getPlanMode(), false);

    // Switch mode to 'read-only'
    sm.setPermissionMode('read-only');
    assert.equal(sm.getPermissionMode(), 'read-only');

    // Enable plan mode, remembering previous mode
    sm.setPlanMode(true, 'read-only');
    assert.equal(sm.getPlanMode(), true);
    assert.equal(sm.getSession()?.previousMode, 'read-only');

    // Reload from disk to verify atomic persistence
    const smReloaded = new SessionManager({ sessionsDir: tmpDir });
    smReloaded.loadSession(sm.requireSession().id);
    assert.equal(smReloaded.getPermissionMode(), 'read-only');
    assert.equal(smReloaded.getPlanMode(), true);
    assert.equal(smReloaded.getSession()?.previousMode, 'read-only');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('applyMode adjusts policy decisions according to permission mode', () => {
  const allowDecision: PolicyDecision = { verdict: 'allow', risk: 'low', reason: 'read tool' };
  const askLowDecision: PolicyDecision = { verdict: 'ask', risk: 'low', reason: 'small edit' };
  const askDangerousDecision: PolicyDecision = { verdict: 'ask', risk: 'medium', reason: 'pip install requests' };
  const denyDecision: PolicyDecision = { verdict: 'deny', risk: 'high', reason: 'secret path' };

  // edit mode (default): giữ nguyên
  assert.equal(applyMode(allowDecision, 'edit').verdict, 'allow');
  assert.equal(applyMode(askLowDecision, 'edit').verdict, 'ask');
  assert.equal(applyMode(askDangerousDecision, 'edit').verdict, 'ask');
  assert.equal(applyMode(denyDecision, 'edit').verdict, 'deny');

  // read-only mode: ask biến thành deny; allow và deny giữ nguyên
  assert.equal(applyMode(allowDecision, 'read-only').verdict, 'allow');
  assert.equal(applyMode(askLowDecision, 'read-only').verdict, 'deny');
  assert.equal(applyMode(askDangerousDecision, 'read-only').verdict, 'deny');
  assert.equal(applyMode(denyDecision, 'read-only').verdict, 'deny');

  // auto mode: allow nếu risk low/medium và không nguy hiểm; nguy hiểm giữ ask; deny giữ nguyên
  assert.equal(applyMode(allowDecision, 'auto').verdict, 'allow');
  assert.equal(applyMode(askLowDecision, 'auto').verdict, 'allow');
  assert.equal(applyMode(askDangerousDecision, 'auto').verdict, 'ask');
  assert.equal(applyMode(denyDecision, 'auto').verdict, 'deny');
});

test('ToolRegistry correctly reports isReadOnly for read-only vs full registries', () => {
  const readOnlyRegistry = new ToolRegistry(READ_ONLY_TOOLS);
  assert.equal(readOnlyRegistry.isReadOnly(), true);
  assert.ok(readOnlyRegistry.hasTool('read_file'));
  assert.ok(readOnlyRegistry.hasTool('list_dir'));
  assert.ok(readOnlyRegistry.hasTool('search_code'));
  assert.ok(!readOnlyRegistry.hasTool('write_file'));
  assert.ok(!readOnlyRegistry.hasTool('edit'));
  assert.ok(!readOnlyRegistry.hasTool('apply_patch'));

  const fullRegistry = new ToolRegistry();
  assert.equal(fullRegistry.isReadOnly(), false);
  assert.ok(fullRegistry.hasTool('write_file'));
});

test('AgentLoop supports dynamic prompt updates, directives, and tool registry swapping', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-agent-loop-prompt-'));
  try {
    const sm = new SessionManager({ sessionsDir: tmpDir, autoSave: true });
    sm.createSession('initial task');

    const provider = new MockProvider({
      chat: async () => ({
        content: 'done',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costEstimate: 0.0001 },
      }),
    });

    const agent = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: tmpDir },
      provider,
      sessionManager: sm,
      systemPrompt: 'Base prompt',
    });

    assert.equal(agent.getSystemPrompt(), 'Base prompt');

    // Run first task
    await agent.runTask('Hello');
    let session = sm.requireSession();
    assert.equal(session.messages[0].role, 'system');
    assert.equal(session.messages[0].content, 'Base prompt');

    // Dynamically update system prompt
    agent.setSystemPrompt('Updated prompt for coding');
    assert.equal(agent.getSystemPrompt(), 'Updated prompt for coding');
    assert.equal(session.messages[0].content, 'Updated prompt for coding');

    // Append directive (e.g. /plan)
    agent.appendSystemPrompt(PLAN_MODE_SYSTEM_DIRECTIVE);
    assert.ok(agent.getSystemPrompt().includes(PLAN_MODE_SYSTEM_DIRECTIVE));
    assert.ok(session.messages[0].content.includes(PLAN_MODE_SYSTEM_DIRECTIVE));

    // Remove directive (e.g. /plan off)
    agent.removeSystemPromptDirective(PLAN_MODE_SYSTEM_DIRECTIVE);
    assert.ok(!agent.getSystemPrompt().includes(PLAN_MODE_SYSTEM_DIRECTIVE));
    assert.ok(!session.messages[0].content.includes(PLAN_MODE_SYSTEM_DIRECTIVE));

    // Swap tool registry
    const readOnlyReg = new ToolRegistry(READ_ONLY_TOOLS);
    agent.setToolRegistry(readOnlyReg);
    assert.equal(agent.toolRegistry.isReadOnly(), true);

    // Running next task keeps updated prompt in session
    await agent.runTask('Second turn');
    session = sm.requireSession();
    assert.equal(session.messages[0].content, 'Updated prompt for coding');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fixIssue fails immediately without file modifications when tools are read-only', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fix-readonly-'));
  try {
    const testFile = path.join(tmpDir, 'sample.py');
    fs.writeFileSync(testFile, 'x = 1\n');

    const readOnlyTools = new ToolRegistry(READ_ONLY_TOOLS);
    const provider = new MockProvider();

    const report = await fixIssue({
      issue: 'Fix a bug',
      workspaceRoot: tmpDir,
      provider,
      model: 'mock-model',
      bus: defaultEventBus,
      tools: readOnlyTools,
    });

    assert.equal(report.status, 'failed');
    assert.match(report.summary, /read-only mode/i);
    assert.equal(report.filesChanged.length, 0);
    // File content remains strictly unchanged
    assert.equal(fs.readFileSync(testFile, 'utf8'), 'x = 1\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runFeature prevents step mutations when tools are read-only', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-feature-readonly-'));
  const oldHome = process.env.AXIOM_HOME;
  process.env.AXIOM_HOME = path.join(tmpDir, '.axiom');
  try {
    const testFile = path.join(tmpDir, 'module.py');
    fs.writeFileSync(testFile, '# original\n');

    const readOnlyTools = new ToolRegistry(READ_ONLY_TOOLS);
    const plan = {
      goal: 'Read-only feature test',
      constraints: [],
      acceptance: ['no side effects in read-only'],
      steps: [
        { title: 'Step 1: Inspect', files: ['module.py'] },
        { title: 'Step 2: Check logic', files: ['module.py'] },
        { title: 'Step 3: Conclude', files: ['module.py'] },
      ],
    };
    let stepCount = 0;
    const provider = new MockProvider('mock', [
      {
        content: '',
        toolCalls: [
          {
            id: 'call_plan_1',
            name: 'submit_plan',
            arguments: { plan },
          },
        ],
      },
      'Step done',
    ]);

    const report = await runFeature('Implement test feature', {
      workspaceRoot: tmpDir,
      provider,
      model: 'mock-model',
      bus: defaultEventBus,
      tools: readOnlyTools,
      ui: {
        print() {},
        async confirm() {
          return true;
        },
        async ask() {
          return 'yes';
        },
      },
    });

    // Step node fails safely because read-only mode prevents mutation
    assert.equal(report.status, 'failed');
    assert.match(report.summary, /read-only mode/i);
    // Workspace file remains pristine
    assert.equal(fs.readFileSync(testFile, 'utf8'), '# original\n');
  } finally {
    if (oldHome === undefined) delete process.env.AXIOM_HOME;
    else process.env.AXIOM_HOME = oldHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
