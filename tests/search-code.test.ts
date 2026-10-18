import { spawnSync } from 'node:child_process';
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SearchCodeTool } from '../src/tools/search-code.js';
import { ToolRegistry } from '../src/tools/registry.js';

function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-search-code-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

// CI installs ripgrep, so these always run there; a laptop without rg skips them instead of failing `npm test`.
const hasRipgrep = !spawnSync('rg', ['--version']).error;
const test = (name: string, fn: () => Promise<void>) =>
  nodeTest(name, { skip: !hasRipgrep && 'ripgrep (rg) is not installed' }, fn);

const tool = new SearchCodeTool();

nodeTest('search_code explains how to get ripgrep when rg is missing', { skip: hasRipgrep && 'ripgrep is installed' }, async () => {
  await assert.rejects(new SearchCodeTool().execute({ pattern: 'x' }, { workspaceRoot: os.tmpdir() }), /ripgrep \(rg\) is not installed/);
});

test('search_code returns path:line: text for each match', async () => {
  const root = makeTree({ 'src/users.py': 'import os\n\ndef find_user(name):\n    return name\n', 'README.md': 'nothing here\n' });
  const out = await tool.execute({ pattern: 'def find_user' }, { workspaceRoot: root });
  assert.equal(out, 'src/users.py:3: def find_user(name):');
});

test('search_code filters by glob and path', async () => {
  const root = makeTree({ 'src/a.py': 'TODO py\n', 'src/b.js': 'TODO js\n', 'docs/c.py': 'TODO docs\n' });
  assert.equal(await tool.execute({ pattern: 'TODO', glob: '*.py', path: 'src' }, { workspaceRoot: root }), 'src/a.py:1: TODO py');
});

test('search_code caps the number of results and says more were left out', async () => {
  const root = makeTree({ 'big.txt': 'hit\n'.repeat(300) });
  const lines = (await tool.execute({ pattern: 'hit', maxResults: 5 }, { workspaceRoot: root })).split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines.at(-1)!, /more matches not shown \(limit 5\)/);
});

test('search_code truncates very long lines', async () => {
  const root = makeTree({ 'min.js': `${'a'.repeat(1000)}needle\n` });
  const out = await tool.execute({ pattern: 'needle' }, { workspaceRoot: root });
  assert.ok(out.length < 400, `got ${out.length} chars`);
  assert.match(out, /\(1006 chars\)$/);
});

test('search_code reports no match without failing', async () => {
  const root = makeTree({ 'a.py': 'x = 1\n' });
  assert.match(await tool.execute({ pattern: 'missing_symbol' }, { workspaceRoot: root }), /^No matches/);
});

test('search_code never returns lines from secret files, even when a glob selects them', async () => {
  const root = makeTree({ '.env': 'API_TOKEN=find_user_secret\n', 'conf/key.pem': 'find_user_secret\n', 'a.py': 'find_user_secret = None\n' });
  for (const glob of [undefined, '.env', '*.pem']) {
    const out = await tool.execute({ pattern: 'find_user_secret', ...(glob && { glob }) }, { workspaceRoot: root });
    assert.ok(!out.includes('API_TOKEN') && !out.includes('key.pem'), `glob ${glob}: ${out}`);
  }
});

test('search_code treats a pattern that looks like an rg option as text', async () => {
  const root = makeTree({ 'a.sh': 'rg --pre=cat\n' });
  assert.equal(await tool.execute({ pattern: '--pre=cat' }, { workspaceRoot: root }), 'a.sh:1: rg --pre=cat');
});

test('search_code rejects an empty pattern and an invalid regex', async () => {
  const root = makeTree({ 'a.py': 'x\n' });
  await assert.rejects(tool.execute({ pattern: '' }, { workspaceRoot: root }), /non-empty/);
  await assert.rejects(tool.execute({ pattern: '(' }, { workspaceRoot: root }), /rg failed/);
});

test('search_code is registered and goes through the policy', async () => {
  const root = makeTree({ 'a.py': 'needle\n' });
  const registry = new ToolRegistry(['read_file', 'search_code']);
  assert.deepEqual(registry.getDefinitions().map((d) => d.name).sort(), ['read_file', 'search_code']);
  for (const p of ['.env', '../..']) {
    const result = await registry.executeTool('search_code', { pattern: 'x', path: p }, { workspaceRoot: root });
    assert.ok(result.isError && /Blocked by policy/.test(result.output), p);
  }
  const ok = await registry.executeTool('search_code', { pattern: 'needle' }, { workspaceRoot: root });
  assert.equal(ok.output, 'a.py:1: needle');
});
