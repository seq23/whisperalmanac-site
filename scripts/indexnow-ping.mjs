#!/usr/bin/env node
// Tells IndexNow (Bing, Yandex, Seznam, Naver; DuckDuckGo reads Bing) which pages changed, once
// the deploy that changed them is live. Run by .github/workflows/indexnow.yml on every push to main.
//
//   node scripts/indexnow-ping.mjs [changed-file ...]   (paths under public/, from git diff)
//
// 1. The key is the one public/<key>.txt whose body is its own name (IndexNow's contract).
// 2. Changed public/**/index.html files become their URLs; none given (or none that are pages)
//    means every URL in public/sitemap.xml.
// 3. It waits until the live site serves this commit: the key file answers with the key AND the
//    live sitemap.xml is byte-identical to the repo's. Deploy is a manual wrangler step (README), so
//    it polls for up to WAIT_MINUTES; a deploy that never comes is a skipped ping, said out loud.
// 4. One POST to api.indexnow.org. 200 or 202 is success; anything else fails the job.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'whisperalmanac.com';
const root = new URL('..', import.meta.url).pathname;
const pub = join(root, 'public');
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES ?? 30);

const keys = readdirSync(pub).filter((f) => /^[A-Za-z0-9-]{8,128}\.txt$/.test(f) && readFileSync(join(pub, f), 'utf8').trim() === f.slice(0, -4));
if (keys.length !== 1) { console.error(`INDEXNOW FAIL: expected one key file in public/, found ${keys.length}`); process.exit(1); }
const key = keys[0].slice(0, -4);
const keyLocation = `https://${HOST}/${key}.txt`;

const sitemap = readFileSync(join(pub, 'sitemap.xml'), 'utf8');
const all = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const changed = process.argv.slice(2)
  .filter((f) => /^public\/(?:.*\/)?index\.html$/.test(f) && existsSync(join(root, f)))
  .map((f) => `https://${HOST}/${f.replace(/^public\//, '').replace(/index\.html$/, '')}`)
  .filter((u) => all.includes(u));
const urlList = changed.length ? changed : all;

const live = async (path) => {
  const r = await fetch(`https://${HOST}${path}?indexnow=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } }).catch(() => null);
  return r?.ok ? r.text() : null;
};
const deadline = Date.now() + WAIT_MINUTES * 60_000;
for (;;) {
  const [k, s] = await Promise.all([live(`/${key}.txt`), live('/sitemap.xml')]);
  if (k?.trim() === key && s === sitemap) break;
  if (Date.now() > deadline) { console.log(`INDEXNOW SKIPPED: this commit was not live after ${WAIT_MINUTES} min (key ${k?.trim() === key ? 'served' : 'not served'}, sitemap ${s === sitemap ? 'current' : 'not current'}); nothing pinged`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 30_000));
}

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation, urlList }),
});
if (res.status !== 200 && res.status !== 202) { console.error(`INDEXNOW FAIL: ${res.status} ${(await res.text()).slice(0, 200)}`); process.exit(1); }
console.log(`INDEXNOW OK ${res.status}: ${urlList.length} URL(s): ${urlList.join(' ')}`);
