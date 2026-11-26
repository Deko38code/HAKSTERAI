#!/usr/bin/env node
/**
 * Probe: the Junkalot coach card is wired to Junkalot's own payload.
 * Owner (2026-11-26): "makke sure all my stuff is wired to junkalot in haksterai.com dash profit section".
 *
 * Runs the derivation against a real captured payload (and a few edge cases) and prints what the
 * card would render. Read-only; it contacts nothing.
 *
 *   node server/__smoke__/profit-wiring-probe.mjs [path-to-profit-rates.json]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { deriveJunkalotFromRates } = require('../src/profitWiring.js');

let failures = 0;
const check = (name, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// --- 1. real payload, if given -------------------------------------------------
const arg = process.argv[2];
if (arg) {
  const raw = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const rates = raw.profit ? Object.assign({}, raw.profit, { live: raw.live, checkedAt: raw.checkedAt }) : raw;
  const j = deriveJunkalotFromRates(rates);
  check('real payload derives a card', j && (j.turns || j.tokens), j ? `${j.turns} turns / ${j.tokens} tokens` : 'null');
  check('source states junkalot.co', j && j.source === 'junkalot.co', j && j.source);
  check('plan comes from her record', j && j.planUsdMonth === 249, j && String(j.planUsdMonth));
  check('meter is a real figure, not invented', j && typeof j.meterUsd30d === 'number' && j.meterUsd30d > 0, j && String(j.meterUsd30d));
  check('lanes carried through', j && Array.isArray(j.providers) && j.providers.length > 0, j && String(j.providers.length) + ' lanes');
  check('no per-token cost invented (quota basis)', j && j.estMarginalCostUsd === null);
  console.log('\ncard would render:');
  console.log(JSON.stringify({ turns: j.turns, tokens: j.tokens, planUsdMonth: j.planUsdMonth, includedInPlan: j.includedInPlan, meterUsd30d: j.meterUsd30d, shareOfPlanPct: j.shareOfPlanPct, clientName: j.clientName, model: j.model, lanes: j.providers.map((p) => `${p.name}:${p.calls}`) }, null, 2));
}

// --- 2. edge cases -------------------------------------------------------------
check('null payload → null (nothing invented)', deriveJunkalotFromRates(null) === null);
check('empty object → null', deriveJunkalotFromRates({}) === null);
check('zero usage → null, not a row of zeroes', deriveJunkalotFromRates({ clients: [{ turns30d: 0, tokens30d: 0 }] }) === null);

const providersOnly = deriveJunkalotFromRates({
  live: true,
  planUsdMonth: 249,
  providers: [{ provider: 'a', turns: 3, inTokens: 100, outTokens: 50, meteredUsd: 1.5 }],
});
check('providers-only payload still lights the card', providersOnly && providersOnly.turns === 3 && providersOnly.tokens === 150);
check('providers-only meter sums lanes', providersOnly && providersOnly.meterUsd30d === 1.5);

const overage = deriveJunkalotFromRates({
  clients: [{ name: 'x', planUsdMonth: 249, turns30d: 10, tokens30d: 5000, meterUsd30d: 300, overageUsd: 51, shareOfPlanPct: 120 }],
});
check('overage is surfaced, not hidden', overage && overage.overageUsd === 51 && overage.includedInPlan === false);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
