// The redirect Worker: http and www go to https://whisperalmanac.com with path and query kept;
// the canonical https address and non-site hosts are served from assets untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = { ASSETS: { fetch: async (req) => new Response('asset:' + new URL(req.url).href, { status: 200 }) } };
const go = (u) => worker.fetch(new Request(u), env);

test('plain http and www redirect permanently to the https bare domain, path and query kept', async () => {
  for (const [from, to] of [
    ['http://whisperalmanac.com/', 'https://whisperalmanac.com/'],
    ['https://www.whisperalmanac.com/privacy/?a=1', 'https://whisperalmanac.com/privacy/?a=1'],
    ['http://www.whisperalmanac.com/x', 'https://whisperalmanac.com/x'],
  ]) {
    const r = await go(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get('location'), to, from);
  }
});

test('the canonical address and preview hosts are served, never redirected', async () => {
  for (const u of ['https://whisperalmanac.com/', 'https://whisperalmanac-site.example.workers.dev/']) {
    const r = await go(u);
    assert.equal(r.status, 200, u);
    assert.equal(await r.text(), 'asset:' + u);
  }
});
