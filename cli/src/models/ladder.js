'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * The model ladder — cheap DeepSeek first, Codex next, everything else last.
 *
 * Owner (2026-11-23): "make sure hes on our cheap deepseek config always in
 * cli and codex fallback then others last … need auto handoff switch toggle".
 *
 * This file is the one place the CLI states that order. It does not pick a
 * model by itself, does not change a route and does not price anything —
 * it is an ordered list plus the two helpers the TUI uses to walk it:
 *
 *   MODEL_LADDER          the order, tier 1 first
 *   attemptsFor(model)    the attempts a run may make, current model first
 *   labelForModel(model)  the short name shown in the status bar and notices
 *
 * Tier 1 is the pinned Phantom Flash config (CLAUDE.md §22), driven by the
 * Claude Code CLI on the same wire model and relay this box's Claude Code
 * session runs on — the harness that keeps working through tool rounds. Tier 2
 * retries the identical turn on that relay through the server's own loop, Codex
 * is the paid fallback that costs nothing extra (Codex Pro auth), and the last
 * tier sends no provider at all, so the server's own waterfall decides —
 * "others last" without the CLI inventing a provider order of its own.
 * ════════════════════════════════════════════════════════════════════════ */

/** Tier 1 model — the cheap DeepSeek line, stated literally (§22). */
const PRIMARY_MODEL = 'deepseek-v4.1-flash:cloud';
const PRIMARY_PROVIDER = 'ollama';

const MODEL_LADDER = Object.freeze([
  Object.freeze({
    tier: 1,
    // The engine the TUI drives its turns with: the Claude Code CLI on the
    // owner's own DeepSeek route (owner, 2026-11-24: "just add my claude cli
    // with my deepseek model to the tui … and he will run like butter").
    // Same wire model, same base URL (127.0.0.1:11434), same context window as
    // the Claude Code session this box already runs (§22 — the model config is
    // unchanged; only the harness around it is Claude Code's own tool loop,
    // which keeps going across tool rounds instead of stopping after one).
    provider: 'claude-cli',
    model: PRIMARY_MODEL,
    label: 'DeepSeek Flash',
  }),
  Object.freeze({
    tier: 2,
    // The same model straight from the Ollama relay through the server's own
    // loop. Nothing was replaced: if the CLI engine fails, the identical turn
    // retries on this route before any other lane is tried.
    provider: PRIMARY_PROVIDER,
    model: PRIMARY_MODEL,
    label: 'DeepSeek direct',
  }),
  Object.freeze({
    tier: 3,
    provider: 'codex-cli',
    // Empty model: the server fills in the provider's own defaultModel, so the
    // CLI never invents a Codex model string of its own.
    model: '',
    label: 'Codex',
  }),
  Object.freeze({
    tier: 4,
    provider: '',
    model: '',
    label: 'waterfall',
  }),
]);

const isPrimary = (model) => String(model || '') === PRIMARY_MODEL;

/**
 * The attempts one run makes, in order.
 *
 *  - the primary, or nothing at all → the whole ladder, tier 1 first;
 *  - no model but a provider named (the picker's "Codex (Pro)") → from that
 *    tier on, so Codex stays first and the waterfall stays last;
 *  - any other explicit model → that pick alone. Choosing a model by hand is a
 *    decision, and a handoff must never quietly undo it.
 */
function attemptsFor(model, provider) {
  const chosen = String(model || '');
  const prov = String(provider || '');
  if (!chosen) {
    const start = MODEL_LADDER.findIndex((entry) => entry.provider && entry.provider === prov);
    if (start > 0) return MODEL_LADDER.slice(start).map((entry) => ({ ...entry }));
    if (prov && start === -1) return [{ tier: 0, provider: prov, model: '', label: prov }];
    return MODEL_LADDER.map((entry) => ({ ...entry }));
  }
  if (isPrimary(chosen)) return MODEL_LADDER.map((entry) => ({ ...entry }));
  return [{ tier: 0, provider: null, model: chosen, label: chosen }];
}

/** Short label for a model id, for the status bar and handoff notices. */
function labelForModel(model) {
  const chosen = String(model || '');
  const hit = MODEL_LADDER.find((entry) => entry.model && entry.model === chosen);
  return hit ? hit.label : chosen || PRIMARY_MODEL;
}

/** Which ladder tier a failure may hand off from — 1 = primary only. */
function tierOf(model) {
  const chosen = String(model || '');
  if (!chosen || isPrimary(chosen)) return 1;
  return 0;
}

module.exports = {
  MODEL_LADDER,
  PRIMARY_MODEL,
  PRIMARY_PROVIDER,
  attemptsFor,
  labelForModel,
  tierOf,
  isPrimary,
};
