// Search Readiness k6: the link-back watch's self-heal rules, and that its page rewrite keeps every
// page's Organization node equal to config/entity.json without touching anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linksBack, decide, rewritePage } from '../scripts/entity-backlink-watch.mjs';

const root = new URL('..', import.meta.url).pathname;
const YT = 'https://www.youtube.com/@whisperalmanac';
const X = 'https://x.com/whisperalmanac';
const P = 'https://www.pinterest.com/whisperalmanac';
const entity = { '@id': 'https://whisperalmanac.com/#org', sameAs: [YT, X], profiles_pending: [P] };
const ok = { status: 200, linksBack: true };
const dead = { status: 404, linksBack: false };

test('linksBack finds the site plain, URL-encoded and JSON-escaped, and not a lookalike', () => {
  assert.ok(linksBack('<a href="https://whisperalmanac.com/">site</a>'));
  assert.ok(linksBack('/redirect?q=https%3A%2F%2Fwhisperalmanac%2Ecom%2F'));
  assert.ok(linksBack('"url":"https:\\/\\/whisperalmanac\\u002ecom"'));
  assert.ok(linksBack('<a href="https://www.whisperalmanac.com">www</a>'));
  assert.ok(!linksBack('https://notwhisperalmanac.com/'));
  assert.ok(!linksBack('https://whisperalmanac.company/'));
  assert.ok(!linksBack('https://whisperalmanac.com.example.com/'));
  assert.ok(!linksBack('https://whisperalmanac.com@example.com/'));
  assert.ok(!linksBack('no link here'));
});

test('a profile dead once is kept and named; dead two runs running it is dropped', () => {
  const results = { [YT]: ok, [X]: dead, [P]: dead };
  const first = decide(entity, results, null);
  assert.deepEqual(first.sameAs, [YT, X]);
  assert.equal(first.changed, false);
  assert.ok(first.stops.some((s) => s.includes('PROFILE_DEAD_ONCE') && s.includes(X)));
  const second = decide(entity, results, { profiles: [{ url: X, dead: true }] });
  assert.deepEqual(second.sameAs, [YT]);
  assert.deepEqual(second.removed, [X]);
});

test('the last profile is never dropped, and a 403 or timeout changes nothing', () => {
  const solo = { ...entity, sameAs: [YT], profiles_pending: [] };
  const d = decide(solo, { [YT]: dead }, { profiles: [{ url: YT, dead: true }] });
  assert.deepEqual(d.sameAs, [YT]);
  assert.ok(d.stops.some((s) => s.includes('LAST_PROFILE_DEAD')));
  const blocked = decide(entity, { [YT]: { status: 403 }, [X]: { status: 0, error: 'TimeoutError' }, [P]: dead }, { profiles: [{ url: YT, dead: true }, { url: X, dead: true }] });
  assert.deepEqual(blocked.sameAs, [YT, X]);
  assert.equal(blocked.changed, false);
});

test('a pending profile that resolves and links back is promoted; a live profile with no link-back is a named stop', () => {
  const d = decide(entity, { [YT]: { status: 200, linksBack: false }, [X]: ok, [P]: ok }, null);
  const unlinked = decide(entity, { [YT]: ok, [X]: ok, [P]: { status: 200, linksBack: false } }, null);
  assert.deepEqual(unlinked.profiles_pending, [P]);
  assert.equal(unlinked.changed, false);
  assert.deepEqual(d.sameAs, [YT, X, P]);
  assert.deepEqual(d.promoted, [P]);
  assert.deepEqual(d.profiles_pending, []);
  assert.ok(d.stops.some((s) => s.includes('NO_LINK_BACK') && s.includes(YT)));
});

test('rewritePage leaves every real page byte for byte when sameAs is unchanged, and follows a change', () => {
  const real = JSON.parse(readFileSync(`${root}config/entity.json`, 'utf8'));
  for (const page of ['index.html', 'about/index.html', 'privacy/index.html']) {
    const html = readFileSync(`${root}public/${page}`, 'utf8');
    assert.equal(rewritePage(html, real), html, page);
    const out = rewritePage(html, { ...real, sameAs: [...real.sameAs, P] });
    assert.notEqual(out, html, page);
    const org = [...out.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .flatMap(([, j]) => JSON.parse(j)['@graph']).find((n) => n['@id'] === real['@id']);
    assert.deepEqual(org.sameAs, [...real.sameAs, P], page);
  }
});
