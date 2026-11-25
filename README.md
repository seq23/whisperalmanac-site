# whisperalmanac.com

Home page for the Whisper Almanac YouTube channel, an About page (who makes it, how it is voiced) and the uploader's privacy policy (needed by Google OAuth).

Deploy: `cd ~/GitHub/boss-os && npm run -s vault:run -- bash -c 'cd ~/GitHub/whisperalmanac-site && npx wrangler@4 deploy'`

Shared look: `public/site.css` (brand fonts self-hosted in `public/fonts/`, OFL licences beside them). A wrong address gets `public/404.html` with a 404 status (`not_found_handling` in `wrangler.jsonc`); security headers live in `public/_headers`. `node scripts/validate-site.mjs` (CI) checks all of it.

Identity: `config/entity.json` is the one definition (name, logo, sameAs, parent Spry Labs); the validator holds every page's Organization JSON-LD to it.

Workflows beside CI:
- `search-console-daily.yml` (daily): `scripts/search-console.mjs` writes and commits query truth, query history, URL inspection coverage and sitemap submission status under `data/search-console/`. The workflow uses the `GSC_SERVICE_ACCOUNT_JSON` Actions secret for the service account that has access to the site's Search Console property.
- `post-deploy-live-check.yml` (after each push to main, and daily): `scripts/live-check.mjs` waits for the deploy, then reads what the edge serves.
- `weekly-outcome-report.yml` (Mondays): `scripts/weekly-outcome-report.mjs`, week over week from `data/search-console/`, with one self-closing issue while the site is red.
- `entity-backlink-watch.yml` (Wednesdays and when entity configuration changes): checks the public profiles, records missing links in `reports/entity/backlink_watch.json`, and promotes pending profiles when they link to this site.
- Nothing paid: `config/llm_routing.json`, `scripts/lib/llm-router.mjs`, `docs/cost/zero-paid-llm.md`.

IndexNow: the key is `public/<key>.txt` (its body is its own name). `.github/workflows/indexnow.yml` runs `scripts/indexnow-ping.mjs` on every push to main: it waits until the live site serves that commit, then pings the changed pages.
