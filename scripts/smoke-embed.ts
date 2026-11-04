// scripts/smoke-embed.ts - Real embedding smoke: @embed from config (or argv) through createEmbedder
// Run: npx tsx scripts/smoke-embed.ts [provider/model]. Calls the real endpoint, so it is a script, not a test.
import { loadConfig } from '../src/core/config.js';
import { createEmbedder, embedIdentity, embedModelFromConfig } from '../src/core/rag/embedder.js';
import { CostTracker } from '../src/llm/cost-tracker.js';

const config = loadConfig();
const selector = process.argv[2];
const info = embedModelFromConfig(selector ? { ...config, modelRoles: { ...config.modelRoles, embed: selector } } : config);
const tracker = new CostTracker();
const embed = createEmbedder(info, { costTracker: tracker });

const texts = [
  'def insert(self, document): insert a new document into the table',
  'Table.insert stores one document and returns its id',
  'a recipe for vegetable soup with carrots',
];
const started = Date.now();
const vectors = await embed(texts);
const cosine = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
const related = cosine(vectors[0], vectors[1]);
const unrelated = cosine(vectors[0], vectors[2]);
const usage = tracker.getSessionSummary();

console.log(`identity   ${embedIdentity(info)}`);
console.log(`vectors    ${vectors.length} x ${vectors[0].length} (createEmbedder already checked one dimension, finite values)`);
console.log(`cosine     related ${related.toFixed(3)}, unrelated ${unrelated.toFixed(3)}`);
console.log(`usage      ${usage.totalPromptTokens} prompt tokens`);
console.log(`latency    ${Date.now() - started} ms`);
if (vectors.length !== texts.length || !(related > unrelated)) {
  console.error('smoke failed: expected one vector per text and related texts closer than unrelated ones');
  process.exit(1);
}
console.log('smoke ok');
