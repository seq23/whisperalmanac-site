// The only door to a language model in this repository (Search Readiness i3). Nothing calls a model
// today; anything that ever does goes through chat() here, and test/zero-paid.test.mjs fails the build
// if any other file names a model endpoint. Rules: config/llm_routing.json, docs/cost/zero-paid-llm.md.
//   - only the :free model ids in config/llm_routing.json, tried in order
//   - max_cost_usd must be 0; a response that reports a non-zero usage.cost is NAMED STOP [PAID_MODEL]
import { readFileSync } from 'node:fs';

const CONFIG = new URL('../../config/llm_routing.json', import.meta.url);

/** The routing config, refused unless every model is :free and the cost cap is 0. */
export function routing(raw = readFileSync(CONFIG, 'utf8')) {
  const cfg = JSON.parse(raw);
  const ids = (cfg.models ?? []).map((m) => m.id);
  if (cfg.policy?.max_cost_usd !== 0) throw Error(`NAMED STOP [PAID_MODEL] max_cost_usd is ${cfg.policy?.max_cost_usd}, must be 0`);
  if (!ids.length) throw Error('NAMED STOP [NO_FREE_MODEL] config/llm_routing.json lists no models');
  const paid = ids.filter((id) => !/:free$/.test(id));
  if (paid.length) throw Error(`NAMED STOP [PAID_MODEL] non-free model ids: ${paid.join(', ')}`);
  return { ids, maxCostUsd: 0 };
}

/** One chat completion through OpenRouter's free models, first that answers wins. */
export async function chat(messages, { key = process.env.OPENROUTER_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw Error('NAMED STOP [SECRET_MISSING_OPENROUTER_API_KEY]');
  const { ids } = routing();
  const errors = [];
  for (const model of ids) {
    const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(90_000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, usage: { include: true } }),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (!r.ok) { errors.push(`${model}: ${r.status}`); continue; }
    const body = await r.json();
    if (Number(body.usage?.cost ?? 0) !== 0) throw Error(`NAMED STOP [PAID_MODEL] ${model} reported cost ${body.usage.cost}`);
    return { model, text: body.choices?.[0]?.message?.content ?? '' };
  }
  throw Error(`NAMED STOP [NO_FREE_MODEL_ANSWERED] ${errors.join('; ')}`);
}
