# whisperalmanac-site

The website for the Whisper Almanac YouTube channel: a static Workers-assets site (`public/`) with a
redirect Worker (`src/index.js`). How it deploys and what each workflow does: `README.md`.

- Fast check (CI runs exactly this): `node scripts/validate-site.mjs && node --test test/*.test.mjs`
- Identity: `config/entity.json` is the one definition. Every page's Organization JSON-LD must match it,
  and the validator fails if one drifts.
- Nothing paid. No paid model, API or service. Any model call goes through `scripts/lib/llm-router.mjs`
  and only the `:free` models in `config/llm_routing.json` (`docs/cost/zero-paid-llm.md`).
  `test/zero-paid.test.mjs` enforces it.
- Never commit an address, key or secret. Workflows read `GSC_SERVICE_ACCOUNT_JSON` from Actions secrets.
