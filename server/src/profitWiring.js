'use strict';

/**
 * Junkalot profit wiring — the owner's dashboard side of one read-only channel.
 *
 * Owner (2026-11-26): "makke sure all my stuff is wired to junkalot in haksterai.com dash profit section".
 *
 * The profit section used to show the "Junkalot · Mr Ed coach" card only when PhantomIDE's bridge
 * answered. PhantomIDE's endpoint is a separate project and can answer a paywall (402), which left
 * the card reading NO DATA even though Junkalot itself was healthy and reachable.
 *
 * Junkalot's own `/api/internal/profit-rates` payload already carries the client meter
 * (`profit.clients[]`) and the lane split (`profit.providers[]`), so this module derives the card
 * from that instead. It reads only; nothing is written into Junkalot (CLAUDE.md §16, §36.7), no
 * rate is invented (§19.4, §26.1), and a missing figure stays null rather than becoming a guess
 * (§10, §13).
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const round4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/**
 * Turn a Junkalot rate-card payload into the shape the profit card renders.
 * Returns null when the payload carries no measured usage at all — the card then
 * says there is nothing to show instead of rendering zeroes that look like data.
 */
function deriveJunkalotFromRates(rates) {
  if (!rates || typeof rates !== 'object') return null;

  const clients = Array.isArray(rates.clients) ? rates.clients.filter((c) => c && typeof c === 'object') : [];
  const providers = Array.isArray(rates.providers) ? rates.providers.filter((p) => p && typeof p === 'object') : [];

  let turns = clients.reduce((s, c) => s + num(c.turns30d), 0);
  let tokens = clients.reduce((s, c) => s + num(c.tokens30d), 0);
  let meterUsd30d = clients.reduce((s, c) => s + num(c.meterUsd30d), 0);
  let overageUsd = clients.reduce((s, c) => s + num(c.overageUsd), 0);

  // Fall back to the lane split when the client meter is absent, so a payload that
  // carries providers only still lights the card.
  if (!turns && providers.length) {
    turns = providers.reduce((s, p) => s + num(p.turns), 0);
    tokens = providers.reduce((s, p) => s + num(p.inTokens) + num(p.outTokens), 0);
    meterUsd30d = providers.reduce((s, p) => s + num(p.meteredUsd), 0);
  }

  if (!turns && !tokens) return null;

  const planUsdMonth = clients.length && num(clients[0].planUsdMonth)
    ? num(clients[0].planUsdMonth)
    : (num(rates.planUsdMonth) || null);

  const shareOfPlanPct = planUsdMonth > 0
    ? Math.round((meterUsd30d / planUsdMonth) * 10000) / 100
    : null;

  return {
    // Provenance — the card states where each figure came from.
    source: 'junkalot.co',
    live: rates.live === true,
    basis: 'locked-card',
    checkedAt: rates.checkedAt || null,

    clientName: clients.length && clients[0].name ? String(clients[0].name) : null,
    turns,
    tokens,
    planUsdMonth,
    includedInPlan: overageUsd <= 0,
    meterUsd30d: round2(meterUsd30d),
    overageUsd: round2(overageUsd),
    shareOfPlanPct,
    // The card's older fields, so both payloads render through one template.
    metered: false,
    estMarginalCostUsd: null,
    newestAt: null,
    model: rates.model || null,
    provider: rates.provider || null,
    rateInPerMTok: num(rates.rateInPerMTok) || null,
    rateOutPerMTok: num(rates.rateOutPerMTok) || null,
    providers: providers.map((p) => ({
      name: String(p.provider || 'lane'),
      calls: num(p.turns),
      billableTurns: num(p.billableTurns),
      ownerTestTurns: num(p.ownerTestTurns),
      meteredUsd: round4(p.meteredUsd),
    })),
    note: 'Read live from junkalot.co on every poll. Meter, not an invoice; nothing here charges her account (§19, §24).',
  };
}

module.exports = { deriveJunkalotFromRates };
