# Zero paid LLM — whisperalmanac.com

Owner policy: nothing paid. The site is static HTML. Nothing in this repository calls a model today.

| Call site | What it does | Models | Guard |
|---|---|---|---|
| `scripts/lib/llm-router.mjs` (no caller yet) | The only door to a model, if one is ever needed | the `:free` OpenRouter models in `config/llm_routing.json`, in order | `max_cost_usd` must be 0 and every id must end in `:free`, or the router refuses to start; a response with a non-zero `usage.cost` is `NAMED STOP [PAID_MODEL]` |

`test/zero-paid.test.mjs` (run in CI) reads this file, the "nothing paid" line in `CLAUDE.md` and
`config/llm_routing.json`. It fails if any of them goes missing, if a paid model id appears, or if
any file other than the router names a model endpoint.

To refresh the list, fetch `https://openrouter.ai/api/v1/models` (no key), keep models whose prompt and
completion prices are `"0"`, and update `models` and `pricing_snapshot.date`.
