# whisperalmanac.com

Home page for the Whisper Almanac YouTube channel, an About page (who makes it, how it is voiced) and the uploader's privacy policy (needed by Google OAuth).

Deploy: `cd ~/GitHub/boss-os && npm run -s vault:run -- bash -c 'cd ~/GitHub/whisperalmanac-site && npx wrangler@4 deploy'`

Shared look: `public/site.css` (brand fonts self-hosted in `public/fonts/`, OFL licences beside them). A wrong address gets `public/404.html` with a 404 status (`not_found_handling` in `wrangler.jsonc`); security headers live in `public/_headers`. `node scripts/validate-site.mjs` (CI) checks all of it.

IndexNow: the key is `public/<key>.txt` (its body is its own name). `.github/workflows/indexnow.yml` runs `scripts/indexnow-ping.mjs` on every push to main: it waits until the live site serves that commit, then pings the changed pages.
