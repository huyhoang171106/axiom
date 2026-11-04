import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/tools/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';

const root = process.cwd();
test('every standard registered tool has an explicit catalog expectation', () => {
  const expected: Record<string, string> = { run_command: 'ask', read_file: 'allow', write_file: 'allow', edit: 'allow', list_dir: 'allow', search_code: 'allow', apply_patch: 'ask', run_tests: 'allow' };
  const names = new ToolRegistry().getDefinitions().map((tool) => tool.name);
  assert.deepEqual([...names].sort(), Object.keys(expected).sort());
  for (const name of names) assert.equal(decide(name, { path: 'src/example.ts' }, root).verdict, expected[name], name);
});
for (const name of ['', 'unknown_tool', 'constructor', 'submit_unknown', 'bash', 'read']) {
  test(`unmapped tool ${JSON.stringify(name)} asks`, () => {
    const result = decide(name, {}, root);
    assert.equal(result.verdict, 'ask');
    assert.equal(result.risk, 'medium');
  });
}
for (const command of ['pip install requests', 'pip3 install x', 'uv add x', 'poetry add x', 'npm install x', 'npm i x', 'pnpm add x', 'rm a.py', 'mv a.py b.py', 'git rm a.py', 'git mv a b', 'git commit -m x', 'ls && pip install x']) {
  test(`${command} requires medium risk approval`, () => {
    const result = decide('run_command', { command }, root);
    assert.equal(result.verdict, 'ask');
    assert.equal(result.risk, 'medium');
  });
}
for (const command of ['git push origin feature', 'git reset --hard', 'git clean -fd', 'rm -rf a']) {
  test(`${command} requires high risk approval`, () => {
    const result = decide('run_command', { command }, root);
    assert.equal(result.verdict, 'ask');
    assert.equal(result.risk, 'high');
  });
}
for (const path of ['.github/workflows/ci.yml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements-dev.txt', 'package.json', 'package-lock.json', 'SECURITY.md']) {
  test(`configuration write ${path} is high risk`, () => {
    for (const name of ['write_file', 'edit']) {
      const result = decide(name, { path }, root);
      assert.equal(result.verdict, 'ask');
      assert.equal(result.risk, 'high');
    }
  });
}
test('registered read tools and the actual submit tool are low risk', () => {
  for (const name of ['read_file', 'list_dir', 'search_code', 'run_tests', 'submit_issue_ticket']) {
    assert.equal(decide(name, { path: 'src' }, root).risk, 'low');
  }
});
test('registry passes risk to the approver without executing refused calls', async () => {
  const registry = new ToolRegistry();
  let called = false;
  registry.approver = async (request) => {
    called = true;
    assert.equal(request.risk, 'medium');
    return 'deny';
  };
  const result = await registry.executeTool('run_command', { command: 'pip install x' }, { workspaceRoot: root });
  assert.equal(called, true);
  assert.equal(result.isError, true);
});
