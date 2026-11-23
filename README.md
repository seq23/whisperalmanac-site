# whisperalmanac.com

One-page site for the Whisper Almanac YouTube channel plus the uploader's privacy policy (needed by Google OAuth).

Deploy: `cd ~/GitHub/boss-os && npm run -s vault:run -- bash -c 'cd ~/GitHub/whisperalmanac-site && npx wrangler@4 deploy'`

Shared look: `public/site.css` (brand fonts self-hosted in `public/fonts/`, OFL licences beside them). A wrong address gets `public/404.html` with a 404 status (`not_found_handling` in `wrangler.jsonc`); security headers live in `public/_headers`. `node scripts/validate-site.mjs` (CI) checks all of it.
