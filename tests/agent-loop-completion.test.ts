// tests/agent-loop-completion.test.ts - Phân biệt đủ đầu ra workflow với hủy thật sau lượt tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/core/agent-loop.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { EventBus } from '../src/core/event-bus.js';
import { SessionManager } from '../src/core/session.js';
import { CostTracker } from '../src/llm/cost-tracker.js';
import { MockProvider } from '../src/llm/providers/mock.js';

for (const mode of ['complete', 'continue', 'abort'] as const) {
  test(`workflow completion after tools: ${mode}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-completion-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'input.txt'), 'workflow input');
    const provider = new MockProvider('mock', [
      { content: '', toolCalls: [{ id: 'read-input', name: 'read_file', arguments: { path: 'input.txt' } }] },
      'finished normally',
    ]);
    const bus = new EventBus();
    const errors: string[] = [];
    const controller = new AbortController();
    bus.on('error', e => errors.push(e.message));
    // Hủy ngay sau tool mô phỏng người dùng dừng cùng lúc workflow đã đủ đầu ra.
    if (mode === 'abort') bus.on('tool_call_end', () => controller.abort());
    const agent = new AgentLoop({
      config: { ...DEFAULT_CONFIG, workspaceRoot: root },
      provider,
      eventBus: bus,
      costTracker: new CostTracker(),
      sessionManager: new SessionManager({ workspaceRoot: root, sessionsDir: path.join(root, 'sessions'), autoSave: false }),
      signal: controller.signal,
      isComplete: () => mode !== 'continue',
      // Đủ đầu ra ngay ở bước cuối vẫn phải completed, không báo vượt giới hạn bước.
      maxSteps: mode === 'continue' ? 2 : 1,
    });
    const result = await agent.runTask('read the input');
    assert.equal(result.status, mode === 'abort' ? 'aborted' : 'completed');
    assert.equal(provider.callHistory.length, mode === 'continue' ? 2 : 1);
    // Kết quả tool phải nằm trong transcript trước khi AgentLoop kết thúc sớm.
    assert.ok(agent.transcript().some(m => m.role === 'tool' && m.toolCallId === 'read-input' && m.content.includes('workflow input')));
    if (mode === 'abort') assert.match(errors[0], /aborted/i);
    else assert.deepEqual(errors, []);
  });
}
