#!/usr/bin/env node
// Weekly link-back watch (Search Readiness k6): profiles die, get renamed or stop linking back, and
// nothing notices. This fetches every sameAs and pending profile in config/entity.json and asks two
// things of each: does it still resolve, and does it link back to whisperalmanac.com?
//
//   node scripts/entity-backlink-watch.mjs           check and report, change nothing
//   node scripts/entity-backlink-watch.mjs --apply   also self-heal: drop a profile dead on two runs
//                                                    in a row, promote a pending profile that now
//                                                    resolves and links back, and rewrite every page's Organization
//                                                    JSON-LD to match (the validator holds them equal)
//
// Evidence: reports/entity/backlink_watch.json (also last run's memory: a profile is only dropped when
// it was dead last week too, so one bad fetch never edits the identity). Job summary when in Actions.
// Dead means 404, 410 or no DNS. 401/403/429/5xx/timeouts prove nothing and change nothing.
// A missing link-back is a NAMED STOP in the report and summary: the fix is on the profile (its own
// links), not in this repo, so the run stays green. sameAs is never emptied: the last profile stays.
// Exit 1 = the watch itself is broken (no entity, zero profiles examined, pages could not be rewritten).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const HOST = 'whisperalmanac.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// A link back in any form a profile page carries it: plain, URL-encoded (YouTube's redirect?q=) or
// JSON-escaped in an inline data blob.
export const linksBack = (html, host = HOST) => {
  const chr = (_, hex) => String.fromCharCode(parseInt(hex, 16));
  const text = html.replace(/%([0-9a-f]{2})/gi, chr).replace(/\\u00([0-9a-f]{2})/gi, chr).replace(/\\\//g, '/');
  return [...text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)].some(([link]) => {
    const target = URL.parse(link);
    return target?.hostname === host || target?.hostname === `www.${host}`;
  });
};

export const isDead = (r) => r.status === 404 || r.status === 410 || r.error === 'ENOTFOUND';

// The self-heal rules, pure so test/entity-backlink-watch.test.mjs can prove them.
// results: { [url]: { status, error?, linksBack } }; previous: last run's report (or null).
export function decide(entity, results, previous) {
  const wasDead = new Set((previous?.profiles ?? []).filter((p) => p.dead).map((p) => p.url));
  const stops = [];
  const removed = [];
  let sameAs = [...entity.sameAs];
  for (const url of entity.sameAs) {
    const r = results[url];
    if (!isDead(r)) continue;
    if (!wasDead.has(url)) { stops.push(`NAMED STOP [PROFILE_DEAD_ONCE] ${url} answered ${r.status || r.error}; dropped if it is dead again next run`); continue; }
    if (sameAs.length === 1) { stops.push(`NAMED STOP [LAST_PROFILE_DEAD] ${url} is dead two runs running but is the only sameAs; kept so the Organization keeps a profile`); continue; }
    sameAs = sameAs.filter((u) => u !== url);
    removed.push(url);
  }
  const promoted = [];
  const pending = [];
  for (const url of entity.profiles_pending ?? []) {
    if (results[url]?.status === 200 && results[url].linksBack && !sameAs.includes(url)) { sameAs.push(url); promoted.push(url); }
    else pending.push(url);
  }
  for (const url of sameAs) {
    const r = results[url];
    if (r?.status === 200 && !r.linksBack) stops.push(`NAMED STOP [NO_LINK_BACK] ${url} resolves but does not link to https://${HOST}/; add the site to that profile's links`);
    if (r && !isDead(r) && r.status !== 200) stops.push(`NAMED NOTE [UNVERIFIED] ${url} answered ${r.status || r.error}; not proof of a dead profile, left as is`);
  }
  return { sameAs, profiles_pending: pending, removed, promoted, stops, changed: removed.length + promoted.length > 0 };
}

// Every page's Organization node for this entity takes the entity's sameAs. The JSON-LD blocks are
// compact JSON.stringify output, so re-serialising an unchanged block gives back the same bytes.
export function rewritePage(html, entity) {
  return html.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (all, open, json, close) => {
    let data;
    try { data = JSON.parse(json); } catch { return all; }
    const nodes = data['@graph'] ?? [data];
    let hit = false;
    for (const n of nodes) if (n['@type'] === 'Organization' && n['@id'] === entity['@id']) { n.sameAs = [...entity.sameAs]; hit = true; }
    return hit ? open + JSON.stringify(data) + close : all;
  });
}

async function check(url) {
  try {
    const target = new URL(url);
    const youtubeHandle = ['youtube.com', 'www.youtube.com'].includes(target.hostname) && /^\/@[^/]+\/?$/.test(target.pathname);
    if (youtubeHandle) target.pathname = target.pathname.replace(/\/$/, '') + '/about';
    const res = await fetch(target, { redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en-US' }, signal: AbortSignal.timeout(20000) });
    const body = res.status === 200 ? await res.text() : '';
    if (youtubeHandle && res.ok && (!body.includes('aboutChannelRenderer') || !body.toLowerCase().includes(new URL(url).pathname.toLowerCase().replace(/\/$/, '')))) {
      return { status: 0, error: 'YouTube channel About panel unavailable', final_url: res.url, linksBack: false };
    }
    return { status: res.status, final_url: res.url, linksBack: linksBack(body) };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.name || 'fetch failed', linksBack: false };
  }
}

const htmlFiles = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? htmlFiles(p) : n.endsWith('.html') ? [p] : []; });

async function main() {
  const root = new URL('..', import.meta.url).pathname;
  const apply = process.argv.includes('--apply');
  const entityPath = join(root, 'config', 'entity.json');
  const reportPath = join(root, 'reports', 'entity', 'backlink_watch.json');
  const entity = JSON.parse(readFileSync(entityPath, 'utf8'));
  const urls = [...new Set([...(entity.sameAs ?? []), ...(entity.profiles_pending ?? [])])];
  if (!urls.length) { console.error('[entity-watch] FAIL: config/entity.json has no sameAs or pending profile; examined 0'); process.exit(1); }
  const previous = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;

  const results = {};
  for (const url of urls) results[url] = await check(url);
  const d = decide(entity, results, previous);

  if (apply && d.changed) {
    const next = { ...entity, sameAs: d.sameAs, profiles_pending: d.profiles_pending };
    writeFileSync(entityPath, JSON.stringify(next, null, 2).replace(/\[\n\s+("[^"\n]+")\n\s+\]/g, '[$1]') + '\n');
    let rewritten = 0;
    for (const page of htmlFiles(join(root, 'public'))) {
      const html = readFileSync(page, 'utf8');
      const out = rewritePage(html, next);
      if (out !== html) { writeFileSync(page, out); rewritten++; }
    }
    if (!rewritten) { console.error('[entity-watch] FAIL: sameAs changed but no page carried the Organization node to rewrite'); process.exit(1); }
    console.log(`[entity-watch] rewrote the Organization node on ${rewritten} pages; deploy to publish (README)`);
  }
  for (const u of d.removed) console.log(`[entity-watch] REMOVED ${u} (dead two runs running)${apply ? '' : ' (dry run: pass --apply)'}`);
  for (const u of d.promoted) console.log(`[entity-watch] PROMOTED ${u} (pending profile now resolves)${apply ? '' : ' (dry run: pass --apply)'}`);
  for (const s of d.stops) console.log(`[entity-watch] ${s}`);

  const report = {
    checked_at: new Date().toISOString(),
    host: HOST,
    examined: urls.length,
    profiles: urls.map((url) => ({ url, kind: (entity.sameAs ?? []).includes(url) ? 'sameAs' : 'pending', ...results[url], dead: isDead(results[url]) })),
    removed: d.removed,
    promoted: d.promoted,
    applied: apply && d.changed,
    stops: d.stops,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ examined: report.examined, removed: d.removed.length, promoted: d.promoted.length, stops: d.stops.length }));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## Entity backlink watch', '', '| profile | status | links back |', '|---|---|---|',
      ...report.profiles.map((p) => `| ${p.url} | ${p.status || p.error} | ${p.linksBack ? 'yes' : 'no'} |`), '',
      ...[...d.removed.map((u) => `- REMOVED ${u}`), ...d.promoted.map((u) => `- PROMOTED ${u}`), ...d.stops.map((s) => `- ${s}`)]];
    if (lines.length === report.profiles.length + 5) lines.push('- nothing to report');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[entity-watch] FAIL: ${e.stack || e}`); process.exit(1); });
