#!/usr/bin/env node
// Post-deploy live check for whisperalmanac.com (Search Readiness h4): the build can pass and the
// edge can still serve the wrong thing, so this reads what the live site really answers. Read-only.
// Run by .github/workflows/post-deploy-live-check.yml after each push to main, and daily.
//
//   node scripts/live-check.mjs            check now
//   node scripts/live-check.mjs --wait     first wait (bounded, WAIT_MINUTES, default 30) until the
//                                          live site serves this commit's public/ files byte for byte;
//                                          deploy is a manual wrangler step (README)
//
// Checks: robots.txt and sitemap.xml (and every sitemap URL answering 200 on the first hop, with a
// self canonical), llms.txt, the manifest and every icon it names, favicon and apple-touch icon,
// the og image (1200x630 JPEG), the homepage's JSON-LD types and its Organization matching
// config/entity.json, the IndexNow key, http and www redirecting 301 to the bare https address,
// and a wrong address getting the branded 404 with a 404 status.
// Exit 1 = one or more checks failed; 2 = NAMED STOP [DEPLOY_NOT_LIVE].
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'whisperalmanac.com';
const ORIGIN = `https://${HOST}`;
const root = new URL('..', import.meta.url).pathname;
const pub = join(root, 'public');
const bust = () => `lc=${Date.now()}`;
const get = (url, opts = {}) => fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache', 'user-agent': 'whisperalmanac-live-check' }, signal: AbortSignal.timeout(20000), ...opts }).catch((e) => ({ status: 0, error: e.message, headers: new Headers(), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }));
const withBust = (url) => `${url}${url.includes('?') ? '&' : '?'}${bust()}`;

// The files that prove which commit is live: every page and crawl file, compared byte for byte.
const LIVE_FILES = ['index.html', 'about/index.html', 'privacy/index.html', 'sitemap.xml', 'robots.txt', 'llms.txt'];
const pathOf = (f) => '/' + f.replace(/index\.html$/, '');

async function waitForDeploy(minutes) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const stale = [];
    for (const f of LIVE_FILES) {
      const r = await get(withBust(ORIGIN + pathOf(f)));
      if (r.status !== 200 || (await r.text()) !== readFileSync(join(pub, f), 'utf8')) stale.push(pathOf(f));
    }
    if (!stale.length) return console.log('live: the site serves this commit');
    if (Date.now() > deadline) { console.error(`NAMED STOP [DEPLOY_NOT_LIVE] after ${minutes} min ${HOST} still serves an older ${stale.join(', ')}`); process.exit(2); }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const jpegSize = (b) => {
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
};

async function main() {
  if (process.argv.includes('--wait')) await waitForDeploy(Number(process.env.WAIT_MINUTES ?? 30));
  const fails = [], oks = [];
  const check = (ok, good, bad) => (ok ? oks.push(good) : fails.push(bad));

  // Crawl files
  const robots = await get(withBust(`${ORIGIN}/robots.txt`));
  const robotsText = await robots.text();
  check(robots.status === 200 && /text\/plain/.test(robots.headers.get('content-type') ?? '') && /^Sitemap: https:\/\/whisperalmanac\.com\/sitemap\.xml$/m.test(robotsText), 'robots.txt 200 text/plain with its Sitemap line', `robots.txt answered ${robots.status} ${robots.headers.get('content-type')}${/Sitemap:/.test(robotsText) ? '' : ' with no Sitemap line'}`);
  const sm = await get(withBust(`${ORIGIN}/sitemap.xml`));
  const locs = [...(await sm.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check(sm.status === 200 && locs.length > 0, `sitemap.xml 200 with ${locs.length} URLs`, `sitemap.xml answered ${sm.status} with ${locs.length} URLs`);
  for (const u of locs) {
    const r = await get(withBust(u));
    const canonical = (await r.text()).match(/<link rel="canonical" href="([^"]+)">/)?.[1];
    check(r.status === 200 && canonical === u, `${u} 200, self canonical`, `${u} answered ${r.status}${r.headers.get('location') ? ` -> ${r.headers.get('location')}` : ''}, canonical ${canonical ?? 'missing'}`);
  }
  const llms = await get(withBust(`${ORIGIN}/llms.txt`));
  check(llms.status === 200, 'llms.txt 200', `llms.txt answered ${llms.status}`);

  // Icons, manifest, og image
  const mf = await get(withBust(`${ORIGIN}/site.webmanifest`));
  let manifest = null; try { manifest = JSON.parse(await mf.text()); } catch {}
  check(mf.status === 200 && manifest, 'site.webmanifest 200 and parses', `site.webmanifest answered ${mf.status}${manifest ? '' : ', not JSON'}`);
  const icons = [...new Set(['/favicon.ico', '/apple-touch-icon.png', ...(manifest?.icons ?? []).map((i) => i.src)])];
  for (const src of icons) {
    const r = await get(withBust(ORIGIN + src));
    check(r.status === 200 && /^image\//.test(r.headers.get('content-type') ?? ''), `${src} 200 image`, `${src} answered ${r.status} ${r.headers.get('content-type')}`);
  }
  const og = await get(withBust(`${ORIGIN}/og.jpg`));
  const ogSize = og.status === 200 ? jpegSize(Buffer.from(await og.arrayBuffer())) : null;
  check(ogSize?.w === 1200 && ogSize?.h === 630, 'og.jpg 1200x630', `og.jpg answered ${og.status}${ogSize ? ` at ${ogSize.w}x${ogSize.h}` : ''}`);

  // Homepage structured data, held to config/entity.json
  const home = await (await get(withBust(`${ORIGIN}/`))).text();
  const nodes = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(([, j]) => { try { const d = JSON.parse(j); return d['@graph'] ?? [d]; } catch { return []; } });
  const types = new Set(nodes.flatMap((n) => [].concat(n['@type'] ?? [])));
  for (const t of ['Organization', 'WebSite', 'WebPage']) check(types.has(t), `homepage JSON-LD has ${t}`, `homepage JSON-LD has no ${t}`);
  const entity = JSON.parse(readFileSync(join(root, 'config', 'entity.json'), 'utf8'));
  const org = nodes.find((n) => n['@id'] === entity['@id']);
  check(org && JSON.stringify(org.sameAs) === JSON.stringify(entity.sameAs) && org.parentOrganization?.['@id'] === entity.parentOrganization['@id'], 'homepage Organization matches config/entity.json', `homepage Organization differs from config/entity.json (${org ? `sameAs ${JSON.stringify(org.sameAs)}, parent ${org.parentOrganization?.['@id']}` : 'missing'})`);

  // IndexNow key
  const key = readdirSync(pub).find((f) => /^[A-Za-z0-9-]{8,128}\.txt$/.test(f) && readFileSync(join(pub, f), 'utf8').trim() === f.slice(0, -4))?.slice(0, -4);
  const k = key ? await get(withBust(`${ORIGIN}/${key}.txt`)) : null;
  check(k?.status === 200 && (await k.text()).trim() === key, `IndexNow key /${key}.txt answers with its key`, key ? `IndexNow key /${key}.txt answered ${k.status}` : 'no IndexNow key file in public/');

  // Redirects of the measured addresses: one hop, 301, to the bare https address, path kept
  for (const from of [`http://${HOST}/about/`, `https://www.${HOST}/about/`, `http://www.${HOST}/`]) {
    const r = await get(from);
    const want = `${ORIGIN}${new URL(from).pathname}`;
    check(r.status === 301 && r.headers.get('location') === want, `${from} 301 -> ${want}`, `${from} answered ${r.status} -> ${r.headers.get('location') ?? 'nothing'}, expected 301 -> ${want}`);
  }

  // A wrong address
  const nf = await get(`${ORIGIN}/no-such-page-${Date.now()}/`);
  check(nf.status === 404 && /<title>[^<]+<\/title>/.test(await nf.text()), 'a wrong address gets the branded 404 with status 404', `a wrong address answered ${nf.status}`);

  for (const o of oks) console.log(`ok   ${o}`);
  for (const f of fails) console.error(`FAIL ${f}`);
  console.log(`LIVE_CHECK ${fails.length ? 'FAIL' : 'OK'}: ${oks.length} passed, ${fails.length} failed on ${HOST}`);
  if (fails.length) process.exit(1);
}
main().catch((e) => { console.error(`NAMED STOP [LIVE_CHECK_FAILED] ${e.message}`); process.exit(1); });
