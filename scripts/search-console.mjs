#!/usr/bin/env node
// Daily Search Console truth for whisperalmanac.com (Search Readiness e4, e5, i6), run by
// .github/workflows/search-console-daily.yml, which commits data/search-console/:
//   gsc_truth.json          query × page clicks, impressions, CTR and position, rolling 28 days, plus
//                           daily totals for 56 days (by_date) so the weekly report compares two weeks
//   gsc_query_history.json  every query ever seen, with first/last seen and best position, so a target
//                           does not vanish when it leaves the 28-day window
//   index_coverage.json     URL Inspection state per sitemap page, 150 URLs a day (oldest first), 8 at a time
//   gsc_sitemaps.json        submission status from Search Console
// Same collector as keepmyproof's scripts/search-console.mjs. Never prints a secret.
// Exit 2 = NAMED STOP [SECRET_MISSING_GSC_SERVICE_ACCOUNT_JSON]; 3 = [GSC_NO_ACCESS]; 4 = [URL_INSPECTION_FAILED].
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gscToken, gscProperty } from './lib/gsc.mjs';

const ORIGIN = 'https://whisperalmanac.com';
const DIR = new URL('../data/search-console/', import.meta.url);
const PER_DAY = 150, PARALLEL = 8;
const day = (d) => d.toISOString().slice(0, 10);
const read = (f, fallback) => (existsSync(new URL(f, DIR)) ? JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) : fallback);
const write = (f, o) => writeFileSync(new URL(f, DIR), JSON.stringify(o, null, 1) + '\n');
const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

async function sitemapUrls() {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw Error(`${u} HTTP ${r.status}`); return r.text(); };
  const index = await get(`${ORIGIN}/sitemap.xml`);
  return /<sitemapindex/.test(index) ? (await Promise.all(locsOf(index).map(get))).flatMap(locsOf) : locsOf(index);
}

async function query(auth, prop, body) {
  const rows = [];
  for (let startRow = 0; startRow < 100000; startRow += 25000) {
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(prop)}/searchAnalytics/query`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60000), body: JSON.stringify({ ...body, rowLimit: 25000, startRow, dataState: 'all' }) });
    if (!r.ok) throw Error(`searchAnalytics HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    const got = (await r.json()).rows || [];
    rows.push(...got);
    if (got.length < 25000) break;
  }
  return rows;
}

async function main() {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) { console.error('NAMED STOP [SECRET_MISSING_GSC_SERVICE_ACCOUNT_JSON] nothing read; set the Actions secret'); process.exit(2); }
  const auth = { authorization: `Bearer ${await gscToken(JSON.parse(raw))}` };
  const prop = await gscProperty(auth, ORIGIN, process.env.GSC_SITE_URL);
  if (!prop) { console.error(`NAMED STOP [GSC_NO_ACCESS] the service account cannot read a ${ORIGIN} property`); process.exit(3); }
  const sitemapStatus = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(prop)}/sitemaps`, {
    headers: auth, signal: AbortSignal.timeout(30000),
  });
  if (!sitemapStatus.ok) throw Error(`sitemaps.list HTTP ${sitemapStatus.status}`);
  const { sitemap = [] } = await sitemapStatus.json();
  mkdirSync(DIR, { recursive: true });
  const now = new Date(), end = new Date(now.getTime() - 3 * 86400000), start = new Date(end.getTime() - 27 * 86400000);

  // 1. Query × page truth, rolling 28 days (Search Console data lags about 3 days), and 56 days of daily totals.
  const rows = (await query(auth, prop, { startDate: day(start), endDate: day(end), dimensions: ['query', 'page'] }))
    .map((x) => ({ query: x.keys[0], page: x.keys[1], clicks: x.clicks, impressions: x.impressions, ctr: Number(x.ctr.toFixed(4)), position: Number(x.position.toFixed(1)) }));
  const byDate = (await query(auth, prop, { startDate: day(new Date(end.getTime() - 55 * 86400000)), endDate: day(end), dimensions: ['date'] }))
    .map((x) => ({ date: x.keys[0], clicks: x.clicks, impressions: x.impressions, position: Number(x.position.toFixed(1)) }));
  const windowDays = byDate.filter((row) => row.date >= day(start));
  const sum = (k) => windowDays.reduce((a, x) => a + x[k], 0);

  // 2. Query history: never forget a query once seen.
  const hist = read('gsc_query_history.json', { schema: 'wa-gsc-query-history-v1', queries: {} });
  for (const x of rows) {
    if (!Object.hasOwn(hist.queries, x.query)) {
      Object.defineProperty(hist.queries, x.query, {
        value: { first_seen: day(end), best_position: x.position, pages: [] }, enumerable: true,
      });
    }
    const h = hist.queries[x.query];
    h.last_seen = day(end); h.best_position = Math.min(h.best_position, x.position);
    if (!h.pages.includes(x.page)) h.pages = [...h.pages, x.page].slice(-10);
  }
  hist.updated_at = now.toISOString();

  // 3. URL Inspection, rotating: never-inspected first, then oldest.
  const cov = read('index_coverage.json', { schema: 'wa-index-coverage-v1', site: ORIGIN, urls: {} });
  const urls = await sitemapUrls();
  if (!urls.length) throw Error('the live sitemap returned no URLs');
  const live = new Set(urls);
  for (const u of Object.keys(cov.urls)) if (!live.has(u)) delete cov.urls[u];
  const queue = urls.slice().sort((a, b) => String(cov.urls[a]?.inspected_at || '').localeCompare(String(cov.urls[b]?.inspected_at || ''))).slice(0, PER_DAY);
  const deadline = Date.now() + 8 * 60000; // a slow API ends the day's rotation early instead of hanging the job
  let done = 0, failed = 0, skipped = 0, i = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (i < queue.length) {
      const u = queue[i++];
      if (Date.now() > deadline) { skipped++; continue; }
      const r = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { method: 'POST', signal: AbortSignal.timeout(30000), headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ inspectionUrl: u, siteUrl: prop }) }).catch(() => null);
      if (!r?.ok) { failed++; continue; }
      const s = (await r.json()).inspectionResult?.indexStatusResult || {};
      cov.urls[u] = { verdict: s.verdict || 'UNKNOWN', state: s.coverageState || 'unknown', last_crawl: s.lastCrawlTime || null, inspected_at: now.toISOString() };
      done++;
    }
  }));
  const states = {};
  for (const v of Object.values(cov.urls)) states[v.state] = (states[v.state] || 0) + 1;
  Object.assign(cov, { property: prop, generated_at: now.toISOString(), sitemap_urls: urls.length, inspected: Object.keys(cov.urls).length, states });
  if (queue.length && !done) { console.error(`NAMED STOP [URL_INSPECTION_FAILED] 0 of ${queue.length} inspections answered`); process.exit(4); }
  write('gsc_truth.json', { schema: 'wa-gsc-truth-v1', site: ORIGIN, property: prop, window: { start: day(start), end: day(end) }, generated_at: now.toISOString(),
    totals: { rows: rows.length, clicks: sum('clicks'), impressions: sum('impressions'), queries: new Set(rows.map((x) => x.query)).size, pages: new Set(rows.map((x) => x.page)).size }, by_date: byDate, rows });
  write('gsc_query_history.json', hist);
  write('index_coverage.json', cov);
  write('gsc_sitemaps.json', { property: prop, generated_at: now.toISOString(), sitemap });
  console.log(`OUTPUT search-console property=${prop} rows=${rows.length} clicks=${sum('clicks')} impressions=${sum('impressions')} inspected_today=${done} inspect_failed=${failed} inspect_skipped=${skipped} known=${cov.inspected}/${urls.length}`);
}
main().catch((e) => { console.error(`NAMED STOP [SEARCH_CONSOLE_FAILED] ${e.message}`); process.exit(1); });
