#!/usr/bin/env node
// Validates the static site before it can be deployed.
// Checks only what a real visitor or Google's OAuth review would hit:
//   - wrangler serves ./public (else the deploy ships nothing)
//   - every page is complete HTML with a <title>
//   - every internal link points at a page that exists
//   - the privacy page keeps the Google API Services User Data Policy /
//     Limited Use disclosure (required for the uploader's OAuth consent screen)
//   - a wrong address gets the branded 404 page with a real 404 status
//     (wrangler not_found_handling "404-page" + public/404.html), never a blank one
//   - every page is phone-ready and on-brand: viewport, favicon, /site.css, the
//     brand fonts actually shipped (@font-face file present for each family the
//     CSS uses) and the ONE filled ember button
//   - every image a page or a link preview loads exists, at the size it declares
//     (og:image 1200x630), so nothing shifts and no preview card comes up empty
//   - nothing on a page is blocked by the Content-Security-Policy in _headers
//     (no inline style, no executable script, no other origin's files)
//   - every JSON-LD block parses
// Rule 0: zero pages examined is a failure, never a pass.
// Usage: node scripts/validate-site.mjs [siteRoot]   (siteRoot defaults to repo root)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] || new URL('..', import.meta.url).pathname;
const problems = [];

const wranglerPath = join(root, 'wrangler.jsonc');
let assetsDir = 'public';
let notFound = '';
if (!existsSync(wranglerPath)) {
  problems.push('wrangler.jsonc is missing');
} else {
  try {
    const cfg = JSON.parse(readFileSync(wranglerPath, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    assetsDir = (cfg.assets?.directory || '').replace(/^\.\//, '').replace(/\/$/, '');
    if (assetsDir !== 'public') problems.push(`wrangler.jsonc assets.directory is "${cfg.assets?.directory}", expected "./public"`);
    notFound = cfg.assets?.not_found_handling || '';
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

// --- A wrong address: the branded 404 page, served with a 404 status ---
// Without not_found_handling "404-page" Workers static assets answers a blank
// 404; without public/404.html there is nothing branded to serve.
if (notFound !== '404-page') problems.push(`wrangler.jsonc assets.not_found_handling is "${notFound}", expected "404-page" (else a wrong address gets a blank page)`);
if (!existsSync(join(pub, '404.html'))) problems.push('public/404.html is missing (a wrong address would get a blank page)');

// --- Image sizes, read from the file itself ---
const imageSize = (file) => {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) === '\x89PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
};
const KB = 1024;
const IMAGE_CAP = 250 * KB; // a phone on a slow line still paints the page

// --- The stylesheet every page shares ---
const cssPath = join(pub, 'site.css');
const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
if (!css) problems.push('public/site.css is missing');
else {
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    family: (body.match(/font-family:\s*"?([^";]+)"?/) || [])[1],
    weight: (body.match(/font-weight:\s*(\d+)/) || [, '400'])[1],
    src: (body.match(/url\(([^)]+)\)/) || [])[1],
  }));
  for (const f of faces) if (!f.src || !existsSync(join(pub, f.src.replace(/^["']|["']$/g, '')))) problems.push(`site.css: @font-face for ${f.family} points at ${f.src}, which is not in public/`);
  // Each brand family AND weight the CSS asks for must be one it ships; else the
  // browser silently falls back to Georgia / system sans, or fakes the weight
  // (Jost Regular where the brand says Jost Light): the 23 Nov 2026 review fail.
  const used = new Set();
  const rules = css.replace(/@font-face\s*{[^}]*}/g, '');
  for (const [, weight, family] of rules.matchAll(/font:\s*(\d{3})?[^;}]*?"?(DM Serif Display|Jost)\b/g)) used.add(`${family} ${weight || '400'}`);
  // Everything but the wordmark inherits the body's Jost, so a bare font-weight asks for Jost at that weight.
  for (const [, weight] of rules.matchAll(/font-weight:\s*(\d{3})/g)) used.add(`Jost ${weight}`);
  if (![...used].some((u) => u.startsWith('Jost')) || ![...used].some((u) => u.startsWith('DM Serif Display'))) problems.push('site.css does not use both brand families (DM Serif Display, Jost)');
  for (const u of used) if (!faces.some((f) => `${f.family} ${f.weight}` === u)) problems.push(`site.css uses ${u} but ships no @font-face for it (visitors get a fallback or faked font)`);
  const vars = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)].map(([, k, v]) => [k, v.toUpperCase()]));
  const btn = (css.match(/(?:^|})\s*\.btn\s*{([^}]*)}/) || [])[1] || '';
  const bg = (btn.match(/background(?:-color)?:\s*([^;]+)/) || [])[1]?.trim() || '';
  const bgHex = (bg.match(/^var\(--([\w-]+)\)$/) ? vars[bg.slice(6, -1)] : bg.toUpperCase()) || '';
  if (bgHex !== '#E89B4C') problems.push(`site.css: .btn background is "${bg}", expected the filled ember #E89B4C`);
}

// --- Content-Security-Policy: present, and nothing on a page breaks it ---
const headersPath = join(pub, '_headers');
const headers = existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : '';
const csp = (headers.match(/^\s+Content-Security-Policy:\s*(.+)$/m) || [])[1] || '';
if (!/^\/\*\s*$/m.test(headers) || !csp) problems.push('public/_headers sets no Content-Security-Policy for /*');
for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options']) if (!new RegExp(`^\\s+${h}:`, 'm').test(headers)) problems.push(`public/_headers is missing ${h}`);

let images = 0;
for (const page of pages) {
  const rel = relative(pub, page);
  const html = readFileSync(page, 'utf8');
  if (!/<meta name="viewport" content="width=device-width/.test(html)) problems.push(`${rel}: no viewport meta (a phone would render it at desktop width)`);
  if (!/<link rel="stylesheet" href="\/site\.css">/.test(html)) problems.push(`${rel}: does not load /site.css`);
  if (!/<link rel="icon" href="\/[^"]+"/.test(html)) problems.push(`${rel}: no favicon`);
  if (csp) {
    if (/<style[\s>]/i.test(html) || /\sstyle="/i.test(html)) problems.push(`${rel}: inline style, which the CSP (style-src 'self') blocks`);
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) if (!/type="application\/ld\+json"/.test(tag)) problems.push(`${rel}: executable <script>, which the CSP (no script-src) blocks`);
    for (const [, url] of html.matchAll(/<(?:img|source|link)\b[^>]*?(?:src|href)="(https?:[^"]+)"/gi)) problems.push(`${rel}: loads ${url} from another origin, which the CSP blocks`);
  }
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(json); } catch (e) { problems.push(`${rel}: JSON-LD does not parse: ${e.message}`); }
  }
  for (const [tag, src] of html.matchAll(/<img\b[^>]*\ssrc="(\/[^"]+)"[^>]*>/g)) {
    images++;
    const file = join(pub, src);
    if (!existsSync(file)) { problems.push(`${rel}: image ${src} has no file`); continue; }
    if (statSync(file).size > IMAGE_CAP) problems.push(`${rel}: image ${src} is ${Math.round(statSync(file).size / KB)} KB (cap ${IMAGE_CAP / KB} KB)`);
    const real = imageSize(file);
    const w = +(tag.match(/\swidth="(\d+)"/) || [])[1], h = +(tag.match(/\sheight="(\d+)"/) || [])[1];
    if (!real) problems.push(`${rel}: image ${src} is not a PNG, JPEG or WebP this check can read`);
    else if (w !== real.w || h !== real.h) problems.push(`${rel}: image ${src} declares ${w}x${h} but is ${real.w}x${real.h} (the page jumps as it loads)`);
  }
  for (const [, url] of html.matchAll(/<meta property="og:image" content="([^"]+)"/g)) {
    images++;
    const path = url.replace(/^https:\/\/whisperalmanac\.com/, '');
    const file = join(pub, path);
    const real = path.startsWith('/') && existsSync(file) ? imageSize(file) : null;
    if (!real) problems.push(`${rel}: og:image ${url} is not an image file this site serves`);
    else if (real.w !== 1200 || real.h !== 630) problems.push(`${rel}: og:image is ${real.w}x${real.h}, expected 1200x630 (link previews crop or drop it)`);
    else if (statSync(file).size > IMAGE_CAP) problems.push(`${rel}: og:image is ${Math.round(statSync(file).size / KB)} KB (cap ${IMAGE_CAP / KB} KB)`);
  }
}
if (images === 0) problems.push('no page shows an image or a link-preview image (examined 0 images)');

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
console.log(`VALIDATE_SITE OK: ${pages.length} pages, ${links} internal links, ${images} images checked; 404 page, fonts, button, CSP and privacy disclosure present`);
