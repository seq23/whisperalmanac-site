#!/usr/bin/env node
// Search Readiness i9: the weekly outcome report for whisperalmanac.com, run by
// .github/workflows/weekly-outcome-report.yml. Same rules as heygetonmylevel's report.
//
// It reads only what search-console-daily.yml collected (data/search-console/gsc_truth.json and
// index_coverage.json), compares the last 7 days of Search Console data with the 7 before, and says
// green, amber or red with the reason. It invents nothing: no data is a red "nothing read", never a
// green report; a first week with no prior week says so instead of showing a delta against nothing.
//
//   node scripts/weekly-outcome-report.mjs          markdown on stdout
//   REPORT_OUT=<file>                               also writes the report object there (the workflow
//                                                   files the one self-closing issue from its verdict)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOMAIN = 'whisperalmanac.com';
const DATA = new URL('../data/search-console/', import.meta.url);
/** Under one impression per ten sitemap pages is the grid's own floor for "Google stopped showing it". */
const IMPRESSIONS_PER_PAGE_FLOOR = 0.1;
const pct = (now, before) => (before > 0 ? ((now - before) / before) * 100 : null);

/** The verdict rules, pure so test/weekly-report.test.mjs can hold them. */
export function verdictOf({ impressions, prevImpressions, clicks, sitemapUrls, indexed, notIndexed, missing = [] }) {
  const reasons = [];
  let verdict = 'green';
  const red = (why) => { verdict = 'red'; reasons.push(why); };
  const amber = (why) => { if (verdict !== 'red') verdict = 'amber'; reasons.push(why); };
  if (missing.length) { red(`nothing read: ${missing.join(', ')} not written yet by search-console-daily.yml`); return { verdict, reasons }; }
  const drop = pct(impressions, prevImpressions);
  if (drop !== null && drop <= -50) red(`impressions fell ${Math.abs(drop).toFixed(0)}% week over week (${prevImpressions} -> ${impressions})`);
  else if (drop !== null && drop <= -20) amber(`impressions fell ${Math.abs(drop).toFixed(0)}% week over week (${prevImpressions} -> ${impressions})`);
  if (sitemapUrls > 0 && impressions / sitemapUrls < IMPRESSIONS_PER_PAGE_FLOOR) red(`${impressions} impressions across ${sitemapUrls} sitemap pages is under one per ten pages (Google is barely showing the site)`);
  if (sitemapUrls > 0 && indexed === 0) red(`no sitemap URL is indexed (${sitemapUrls} submitted)`);
  else if (notIndexed > indexed) amber(`${notIndexed} sitemap URLs are not indexed against ${indexed} that are`);
  if (!reasons.length) reasons.push(`${impressions} impressions, ${clicks} clicks, ${indexed} of ${sitemapUrls} sitemap URLs indexed`);
  return { verdict, reasons };
}

/** Two 7-day windows from gsc_truth.json's by_date rows: the newest 7 days and the 7 before. */
export function weeks(byDate) {
  const days = [...byDate].sort((a, b) => a.date.localeCompare(b.date));
  const total = (rows) => ({ start: rows[0]?.date ?? null, end: rows.at(-1)?.date ?? null, days: rows.length, clicks: rows.reduce((a, x) => a + x.clicks, 0), impressions: rows.reduce((a, x) => a + x.impressions, 0) });
  const week = days.slice(-7), prev = days.slice(-14, -7);
  return { week: total(week), prev: prev.length === 7 ? total(prev) : null };
}

export function build() {
  const missing = ['gsc_truth.json', 'index_coverage.json'].filter((f) => !existsSync(new URL(f, DATA))).map((f) => `data/search-console/${f}`);
  const read = (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));
  const truth = missing.length ? null : read('gsc_truth.json');
  const cov = missing.length ? null : read('index_coverage.json');
  const { week, prev } = weeks(truth?.by_date ?? []);
  const states = cov?.states ?? {};
  const indexed = states['Submitted and indexed'] ?? 0;
  const notIndexed = Object.entries(states).filter(([k]) => k !== 'Submitted and indexed').reduce((n, [, v]) => n + v, 0);
  const sitemapUrls = cov?.sitemap_urls ?? 0;
  const { verdict, reasons } = verdictOf({ impressions: week.impressions, prevImpressions: prev?.impressions ?? null, clicks: week.clicks, sitemapUrls, indexed, notIndexed, missing });
  const top = Object.values((truth?.rows ?? []).reduce((m, r) => { const q = (m[r.query] ??= { query: r.query, impressions: 0, clicks: 0 }); q.impressions += r.impressions; q.clicks += r.clicks; return m; }, {}))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 10);
  return {
    schema_version: '1.0', domain: DOMAIN, generated_at: new Date().toISOString(),
    read_from: ['data/search-console/gsc_truth.json', 'data/search-console/index_coverage.json'],
    week, previous_week: prev,
    week_over_week: prev ? { impressions_change_pct: pct(week.impressions, prev.impressions), clicks_change_pct: pct(week.clicks, prev.clicks) } : { note: 'no full prior week recorded: nothing to compare with' },
    coverage: { sitemap_urls: sitemapUrls, indexed, not_indexed: notIndexed, states, collected_at: cov?.generated_at ?? null },
    top_queries_28d: top, verdict, reasons,
    summary: missing.length ? `RED: nothing read (${missing.join(', ')} missing).` : `${verdict.toUpperCase()}: ${week.impressions} impressions and ${week.clicks} clicks in ${week.start}..${week.end}, ${indexed} of ${sitemapUrls} sitemap URLs indexed.`,
  };
}

const markdown = (r) => [
  `## Weekly outcome — ${r.domain}`, '', `**${r.summary}**`, '', ...r.reasons.map((x) => `- ${x}`), '',
  r.previous_week ? `| measure | ${r.previous_week.end} | ${r.week.end} |\n|---|---|---|\n| impressions | ${r.previous_week.impressions} | ${r.week.impressions} |\n| clicks | ${r.previous_week.clicks} | ${r.week.clicks} |` : '_No full prior week recorded: nothing to compare with._',
  '', r.top_queries_28d.length ? ['| query (28 days) | impressions | clicks |', '|---|---|---|', ...r.top_queries_28d.map((q) => `| ${q.query} | ${q.impressions} | ${q.clicks} |`)].join('\n') : '_Search Console attributed no queries in the window._',
  '', `Read from ${r.read_from.join(', ')}.`,
].join('\n');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = build();
  if (process.env.REPORT_OUT) writeFileSync(process.env.REPORT_OUT, `${JSON.stringify(r, null, 2)}\n`);
  console.log(markdown(r));
}
