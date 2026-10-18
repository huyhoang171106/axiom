import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { loadCatalog, readModelsCache } from '../src/llm/catalog/index.js';
import { CACHE_TTL_MS, refreshDiscovery } from '../src/llm/discovery.js';
import { startFakeServer } from './fake-server.js';

/** A home whose models.json adds a keyless provider `fake` with discovery at `baseUrl`. */
function homeFor(baseUrl: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-discovery-'));
  const fake = { baseUrl, api: 'openai-completions', auth: 'none', discovery: { type: 'openai-models' }, models: [{ id: 'seed', contextWindow: 4096 }] };
  fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { fake } }));
  return home;
}

const refresh = (home: string, extra: { force?: boolean; timeoutMs?: number } = {}) => refreshDiscovery({ home, providers: ['fake'], env: {}, ...extra });

test('discovery adds new models to the catalog and seed metadata survives', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'seed' }, { id: 'new-model', object: 'model' }] })));
  try {
    const home = homeFor(srv.url);
    assert.deepEqual(await refresh(home), { updated: ['fake'], errors: [] });
    assert.equal(srv.seen[0].url, '/models');
    const models = loadCatalog(home).models('fake');
    assert.deepEqual(models.map((m) => m.id).sort(), ['new-model', 'seed']);
    assert.equal(models.find((m) => m.id === 'seed')!.contextWindow, 4096);
  } finally {
    await srv.close();
  }
});

test('a fresh cache is not refetched unless forced; an expired one is', async () => {
  const srv = await startFakeServer((req, res) => res.writeHead(200).end(JSON.stringify({ data: [{ id: 'a' }] })));
  try {
    const home = homeFor(srv.url);
    await refresh(home);
    assert.deepEqual(await refresh(home), { updated: [], errors: [] });
    assert.equal(srv.seen.length, 1);
    await refresh(home, { force: true });
    assert.equal(srv.seen.length, 2);
    const cache = readModelsCache(home);
    cache.fake.fetchedAt = Date.now() - CACHE_TTL_MS - 1000;
    fs.writeFileSync(path.join(home, 'models-cache.json'), JSON.stringify(cache));
    assert.deepEqual((await refresh(home)).updated, ['fake']);
    assert.equal(srv.seen.length, 3);
  } finally {
    await srv.close();
  }
});

test('broken JSON is reported and the old cache entry is kept', async () => {
  let body = JSON.stringify({ data: [{ id: 'kept' }] });
  const srv = await startFakeServer((req, res) => res.writeHead(200).end(body));
  try {
    const home = homeFor(srv.url);
    await refresh(home);
    body = '<html>oops';
    assert.deepEqual(await refresh(home, { force: true }), { updated: [], errors: ['fake: /models did not return JSON'] });
    assert.deepEqual(readModelsCache(home).fake.models, [{ id: 'kept' }]);
  } finally {
    await srv.close();
  }
});

test('a server that does not answer in time, or is not running, is an error message, not a crash', async () => {
  const hanging: http.ServerResponse[] = [];
  const srv = await startFakeServer((req, res) => void hanging.push(res));
  try {
    const started = Date.now();
    const { errors } = await refresh(homeFor(srv.url), { timeoutMs: 200 });
    assert.ok(Date.now() - started < 2000);
    assert.match(errors[0], /^fake: cannot connect to 127\.0\.0\.1:\d+$/);
  } finally {
    hanging.forEach((res) => res.destroy());
    await srv.close();
  }
  assert.match((await refresh(homeFor('http://127.0.0.1:1/v1'))).errors[0], /fake: cannot connect to 127\.0\.0\.1:1/);
});
