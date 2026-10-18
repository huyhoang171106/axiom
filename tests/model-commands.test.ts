import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/index.js';
import { modelCommand } from '../src/commands/model.js';
import { modelsCommand, type ModelRow } from '../src/commands/models.js';
import type { CommandContext } from '../src/commands/types.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { ModelInfo } from '../src/llm/catalog/index.js';
import { fakeUI } from './fake-ui.js';
import { startFakeServer } from './fake-server.js';

function useTempHome(t: { after(fn: () => void): void }): string {
  const saved = process.env.AXIOM_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-models-'));
  process.env.AXIOM_HOME = home;
  t.after(() => (saved === undefined ? delete process.env.AXIOM_HOME : (process.env.AXIOM_HOME = saved)));
  return home;
}

function context(): CommandContext & { current?: ModelInfo } {
  const ctx = {
    config: { ...DEFAULT_CONFIG },
    workspaceRoot: '.',
    ui: fakeUI(),
    signal: new AbortController().signal,
    current: undefined as ModelInfo | undefined,
    session: {
      get model(): ModelInfo {
        return ctx.current!;
      },
      setModel: (info: ModelInfo) => void (ctx.current = info),
    },
  };
  return ctx;
}

const readConfig = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));

test('axiom models --json prints valid JSON covering the 87 supported providers', async (t) => {
  useTempHome(t);
  const log = t.mock.method(console, 'log', () => {});
  await runCli(['models', '--json']);
  const rows = JSON.parse(String(log.mock.calls[0].arguments[0])) as ModelRow[];
  assert.equal(new Set(rows.map((r) => r.provider)).size, 87);
  for (const r of rows.slice(0, 50)) {
    assert.equal(r.selector, `${r.provider}/${r.id}`);
    assert.equal(typeof r.contextWindow, 'number');
  }
});

test('models filters by provider and by text, and rejects an unknown provider', async (t) => {
  useTempHome(t);
  const deepseek = (await modelsCommand.run('deepseek', context()))!;
  assert.ok((deepseek.data as ModelRow[]).every((r) => r.provider === 'deepseek'));
  assert.match(deepseek.text, /^deepseek \((not )?connected\)\n  deepseek\/deepseek-v4-pro/);
  const found = (await modelsCommand.run('find V4-PRO', context()))!.data as ModelRow[];
  assert.ok(found.length > 0 && found.every((r) => r.selector.toLowerCase().includes('v4-pro') || r.name.toLowerCase().includes('v4-pro')));
  await assert.rejects(modelsCommand.run('nope', context()), /Unknown provider nope/);
});

test('/model <selector> switches the session and remembers it as the last used model', async (t) => {
  const home = useTempHome(t);
  const ctx = context();
  const result = (await modelCommand.run('zai/glm-5.3:high', ctx))!;
  assert.equal(result.text, 'Model: zai/glm-5.3 (thinking high)');
  assert.equal(ctx.current?.id, 'glm-5.3');
  assert.equal(readConfig(home).defaultModel, 'zai/glm-5.3');
  await assert.rejects(modelCommand.run('zai/glm-9', ctx), /Unknown model/);
});

test('/model role writes the role to config.json and keeps other settings', async (t) => {
  const home = useTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ budgetLimitDollars: 2, modelRoles: { default: 'zai/glm-5.3' } }));
  const ctx = context();
  ctx.config.modelRoles = { default: 'zai/glm-5.3' };
  assert.match((await modelCommand.run('role smol deepseek/deepseek-v4-pro', ctx))!.text, /@smol = deepseek\/deepseek-v4-pro/);
  assert.deepEqual(readConfig(home), { budgetLimitDollars: 2, modelRoles: { default: 'zai/glm-5.3', smol: 'deepseek/deepseek-v4-pro' } });
  assert.match((await modelCommand.run('role smol', ctx))!.text, /@smol = deepseek\/deepseek-v4-pro/);
  await assert.rejects(modelCommand.run('role boss zai/glm-5.3', ctx), /Roles: default, smol/);
});

test('/model with no selector refreshes discovery and lists only connected providers', async (t) => {
  const home = useTempHome(t);
  const srv = await startFakeServer((req, res) => res.writeHead(200).end(JSON.stringify({ data: [{ id: 'found-by-discovery' }] })));
  try {
    const fake = { baseUrl: srv.url, api: 'openai-completions', auth: 'none', discovery: { type: 'openai-models' }, models: [{ id: 'seed', contextWindow: 8000 }] };
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { fake } }));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ enabledProviders: ['fake'] }));
    const rows = (await modelCommand.run('', context()))!.data as ModelRow[];
    assert.deepEqual(rows.map((r) => r.selector).sort(), ['fake/found-by-discovery', 'fake/seed']);
  } finally {
    await srv.close();
  }
});
