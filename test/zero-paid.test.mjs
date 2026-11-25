// Search Readiness i3, i10: the "nothing paid" rule is read by code, not just written down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { routing } from '../scripts/lib/llm-router.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), 'utf8');

test('CLAUDE.md says nothing paid and points at the cost doc', () => {
  assert.match(read('CLAUDE.md'), /nothing paid/i);
  assert.ok(existsSync(join(root, 'docs/cost/zero-paid-llm.md')));
  assert.match(read('docs/cost/zero-paid-llm.md'), /nothing paid/i);
});

test('config/llm_routing.json: max_cost_usd 0, every model :free, snapshot dated', () => {
  const cfg = JSON.parse(read('config/llm_routing.json'));
  assert.equal(cfg.policy.max_cost_usd, 0);
  assert.match(cfg.pricing_snapshot.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(routing().ids.length > 0);
});

test('the router refuses a paid model or a non-zero cost cap', () => {
  const ok = { policy: { max_cost_usd: 0 }, models: [{ id: 'a/b:free' }] };
  assert.deepEqual(routing(JSON.stringify(ok)).ids, ['a/b:free']);
  assert.throws(() => routing(JSON.stringify({ ...ok, models: [{ id: 'openai/gpt-5' }] })), /PAID_MODEL/);
  assert.throws(() => routing(JSON.stringify({ ...ok, policy: { max_cost_usd: 1 } })), /PAID_MODEL/);
  assert.throws(() => routing(JSON.stringify({ ...ok, models: [] })), /NO_FREE_MODEL/);
});

test('the router reads a reported cost and stops', async () => {
  const { chat } = await import('../scripts/lib/llm-router.mjs');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ usage: { cost: 0.002 }, choices: [{ message: { content: 'x' } }] }) });
  await assert.rejects(chat([{ role: 'user', content: 'hi' }], { key: 'k', fetchImpl }), /PAID_MODEL/);
});

test('no file but the router names a model endpoint', () => {
  const ENDPOINT = /openrouter\.ai\/api|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.groq\.com/;
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { if (['node_modules', '.git'].includes(n)) continue; const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(m?js|ya?ml|html|json)$/.test(n) && files.push(p); } };
  // config/ is data (llm_routing.json names its pricing source), not a call site
  for (const d of ['scripts', 'src', 'public', '.github']) if (existsSync(join(root, d))) walk(join(root, d));
  const hits = files.map((f) => relative(root, f)).filter((f) => f !== 'scripts/lib/llm-router.mjs' && ENDPOINT.test(read(f)));
  assert.deepEqual(hits, []);
});
