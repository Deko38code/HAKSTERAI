'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Model catalog — reference data for the harness model picker.
 *
 * This records the model catalog Freebuff PUBLISHES on its README, so the TUI
 * can label a model with the same context window and capability hints. It is
 * factual reference data: a list of model names, vendors and published limits.
 *
 * THREE THINGS THIS IS NOT:
 *  - It is NOT access. These models are served by Freebuff's own backend on
 *    their own keys. Selecting one here does not reach it. Point
 *    `providers.js` at a provider account you hold; the `access` field below
 *    describes Freebuff's tier, not what this harness can call.
 *  - It is NOT scraped. Everything here is from their public README table.
 *  - It is NOT complete. Where the README does not state a context window,
 *    `context` is null rather than guessed.
 *
 * The `CONTEXT_BY_MODEL` map below the catalog is this harness's OWN data
 * (carried over from the CLI's existing model-context table) and is the one
 * used for the token bar.
 * ════════════════════════════════════════════════════════════════════════ */

/** @typedef {{id:string,vendor:string,bestFor:string,access:string,context:number|null,images:boolean,audio:boolean}} CatalogModel */

/** The regular picker, as published. `context: null` = not stated upstream. */
const REFERENCE_CATALOG = [
  {
    id: 'MiMo 2.6 Flash', vendor: 'Xiaomi', access: 'full+limited',
    bestFor: 'The default everywhere; balanced performance with image support.',
    context: null, images: true, audio: false,
  },
  {
    id: 'GLM 5.3 Flash', vendor: 'Zhipu', access: 'full+limited',
    bestFor: 'Deepest reasoning, unmetered.',
    context: null, images: false, audio: false,
  },
  {
    id: 'DeepSeek V4.1 Flash', vendor: 'DeepSeek', access: 'full+limited',
    bestFor: 'Fast coding and tool use, unmetered.',
    context: null, images: false, audio: false,
  },
  {
    id: 'DeepSeek V4.1 Flash Fast', vendor: 'DeepSeek', access: 'full',
    bestFor: 'Fast mode: splits work across parallel subagents and verifies the result.',
    context: null, images: false, audio: false,
  },
  {
    id: 'GPT-6 Luna', vendor: 'OpenAI', access: 'full',
    bestFor: 'Strong all-around with native images; runs on flex capacity.',
    context: null, images: true, audio: false,
  },
  {
    id: 'MiMo 2.6 Pro', vendor: 'Xiaomi', access: 'full',
    bestFor: "Xiaomi's stronger reasoning model, with image support.",
    context: null, images: true, audio: false,
  },
  {
    id: 'Solar Mini 4', vendor: 'Upstage', access: 'full+limited',
    bestFor: 'Fast, compact; text only.',
    context: 524000, images: false, audio: false,
  },
  {
    id: 'Solar Pro 4', vendor: 'Upstage', access: 'full+limited',
    bestFor: 'Larger, stronger; text only.',
    context: 524000, images: false, audio: false,
  },
  {
    id: 'Gemini 3.8 Flash', vendor: 'Google', access: 'paid',
    bestFor: '1M context, and the only model that accepts audio, video and PDF.',
    context: 1000000, images: true, audio: true,
  },
  {
    id: 'Muse Spark 1.3', vendor: 'Meta', access: 'paid',
    bestFor: 'Agentic coding, 1M context.',
    context: 1000000, images: false, audio: false,
  },
  {
    id: 'GPT-6.1 Sol', vendor: 'OpenAI', access: 'region/paid',
    bestFor: "OpenAI's flagship; one session a day per account, 1M context, images.",
    context: 1000000, images: true, audio: false,
  },
  {
    id: 'Gemini 3.1 Flash Lite', vendor: 'Google', access: 'specialist',
    bestFor: 'Powers specialist tasks such as file finding and research rather than the main picker.',
    context: null, images: false, audio: false,
  },
];

/** Retired upstream; kept so an old config still resolves to something. */
const RETIRED = [
  { id: 'DeepSeek V4 Pro', vendor: 'DeepSeek', replacedBy: 'GLM 5.3 Flash', note: 'Retired from the catalog; GLM 5.3 Flash replaces it as the deep-reasoning pick.' },
];

/* This harness's own context windows, used for the token bar and the
 * compaction threshold. Unrelated to the tier column above. */
const CONTEXT_BY_MODEL = {
  'glm-5.2:cloud': 128000,
  'thudm/glm-5.2:cloud': 128000,
  'thudm/glm-5.1:cloud-ctx': 128000,
  'thudm/glm-5.1:cloud': 128000,
  'gpt-oss:120b-cloud': 131072,
  'openai/gpt-oss-120b': 131072,
  'claude-sonnet-4-5': 200000,
  'claude-opus-4-5': 200000,
  'claude-haiku-3-5': 200000,
  'gpt-4o': 128000,
  'openai/gpt-5.5': 128000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.0-flash-lite': 1000000,
};

const DEFAULT_CONTEXT = 128000;

/**
 * Context window for a model id, resolving in three steps: this harness's own
 * table, then a family heuristic, then the default. Never returns 0 — a zero
 * here would make the token bar divide by zero.
 */
function contextMaxFor(model) {
  if (!model) return DEFAULT_CONTEXT;
  if (CONTEXT_BY_MODEL[model]) return CONTEXT_BY_MODEL[model];
  const m = String(model).toLowerCase();
  if (m.includes('claude')) return 200000;
  if (m.includes('gpt-oss') || m.includes('120b')) return 131072;
  if (m.includes('glm')) return 128000;
  // The reference catalog states a window for a few models by display name.
  const hit = REFERENCE_CATALOG.find((c) => c.id.toLowerCase() === m);
  if (hit && hit.context) return hit.context;
  const env = parseInt(process.env.HAKSTER_CONTEXT_MAX || '', 10);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_CONTEXT;
}

function findModel(name) {
  const q = String(name || '').toLowerCase();
  return REFERENCE_CATALOG.find((m) => m.id.toLowerCase() === q)
    || REFERENCE_CATALOG.find((m) => m.id.toLowerCase().includes(q))
    || null;
}

/** The catalog grouped as the picker shows it. */
function byAccess() {
  const groups = {};
  for (const m of REFERENCE_CATALOG) (groups[m.access] ||= []).push(m);
  return groups;
}

/** One-line label for a picker row. */
function labelFor(m) {
  const ctx = m.context ? `${Math.round(m.context / 1000)}K` : 'ctx n/s';
  const flags = [m.images && 'img', m.audio && 'av/pdf'].filter(Boolean).join('+');
  return `${m.id} — ${m.vendor} · ${ctx}${flags ? ' · ' + flags : ''}`;
}

module.exports = {
  REFERENCE_CATALOG,
  RETIRED,
  CONTEXT_BY_MODEL,
  DEFAULT_CONTEXT,
  contextMaxFor,
  findModel,
  byAccess,
  labelFor,
};
