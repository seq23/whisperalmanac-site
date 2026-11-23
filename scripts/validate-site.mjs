#!/usr/bin/env node
// Validates the static site before it can be deployed.
// Checks only what a real visitor or Google's OAuth review would hit:
//   - wrangler serves ./public (else the deploy ships nothing)
//   - every page is complete HTML with a <title>
//   - every internal link points at a page that exists
//   - the privacy page keeps the Google API Services User Data Policy /
//     Limited Use disclosure (required for the uploader's OAuth consent screen)
// Rule 0: zero pages examined is a failure, never a pass.
// Usage: node scripts/validate-site.mjs [siteRoot]   (siteRoot defaults to repo root)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] || new URL('..', import.meta.url).pathname;
const problems = [];

const wranglerPath = join(root, 'wrangler.jsonc');
let assetsDir = 'public';
if (!existsSync(wranglerPath)) {
  problems.push('wrangler.jsonc is missing');
} else {
  try {
    const cfg = JSON.parse(readFileSync(wranglerPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    assetsDir = (cfg.assets?.directory || '').replace(/^\.\//, '').replace(/\/$/, '');
    if (assetsDir !== 'public') problems.push(`wrangler.jsonc assets.directory is "${cfg.assets?.directory}", expected "./public"`);
  } catch (e) {
    problems.push(`wrangler.jsonc does not parse: ${e.message}`);
  }
}

const pub = join(root, 'public');
const pages = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.html')) pages.push(p);
  }
};
walk(pub);

if (pages.length === 0) {
  console.error(`VALIDATE_SITE FAIL: examined 0 pages under ${pub}`);
  process.exit(1);
}

const urlToFile = (href) => {
  const path = href.split(/[?#]/)[0];
  const candidates = path.endsWith('/') ? [join(pub, path, 'index.html')] : [join(pub, path), join(pub, path + '.html'), join(pub, path, 'index.html')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
};

let links = 0;
for (const page of pages) {
  const rel = relative(pub, page);
  const html = readFileSync(page, 'utf8');
  if (!/^<!doctype html>/i.test(html.trim())) problems.push(`${rel}: missing <!doctype html>`);
  if (!/<title>[^<]+<\/title>/i.test(html)) problems.push(`${rel}: missing or empty <title>`);
  if (!/<\/html>\s*$/i.test(html)) problems.push(`${rel}: truncated (no closing </html>)`);
  for (const [, href] of html.matchAll(/href="(\/[^"]*)"/g)) {
    links++;
    if (!urlToFile(href)) problems.push(`${rel}: internal link ${href} has no page`);
  }
}

const privacy = join(pub, 'privacy', 'index.html');
if (!existsSync(privacy)) {
  problems.push('privacy/index.html is missing (Google OAuth consent screen links to it)');
} else {
  const html = readFileSync(privacy, 'utf8');
  // An exact href, not a substring: the policy URL must be a link, not words on the page.
  const POLICY = 'https://developers.google.com/terms/api-services-user-data-policy';
  const linksToPolicy = [...html.matchAll(/href="([^"]*)"/g)].some(([, href]) => href === POLICY);
  if (!linksToPolicy) problems.push('privacy page lost its link to the Google API Services User Data Policy');
  if (!/Limited Use/.test(html)) problems.push('privacy page lost its Limited Use statement');
}

if (problems.length) {
  for (const p of problems) console.error(`VALIDATE_SITE FAIL: ${p}`);
  process.exit(1);
}
console.log(`VALIDATE_SITE OK: ${pages.length} pages, ${links} internal links checked, privacy disclosure present`);
