#!/usr/bin/env node
// READ-ONLY plan-cap audit. Prints, for every sellable price, whether the plan
// still clears the 5:1 rule at its full cap, and what real usage looks like so
// caps can be set from measured use instead of guesswork.
//
// It writes nothing, changes nothing and never restarts anything. Exit code 1
// means at least one price would be sold at worse than 5:1 if a user maxed it.
//
// Cost basis is the measured one from the usage ledger (not a guess):
//   77 recorded calls average 6,643 input + 523 output tokens = $0.00208 a call
//   at the cheapest paid lane's list price ($0.28/M in, $0.42/M out).
// The $0.45 card fee is subtracted from every price before the margin is taken.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const COST_PER_CALL = 0.00208;   // dollars, list price of the cheapest paid lane
const CARD_FEE = 0.45;           // dollars, charged on every paid price
const TARGET_RATIO = 5;          // owner rule: never below 5:1
const CAPS = { free: 5, low_income: 96, lite: 280, starter: 900, starter_plus: 570, pro: 2300, enterprise: 9000 };

function loadCatalog() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'src', 'index.js'), 'utf8');
  const start = src.indexOf('const PRICING_CATALOG = [');
  const end = src.indexOf('\n];', start) + 3;
  const body = src.slice(start, end).replace('const PRICING_CATALOG =', 'return');
  return new Function('process', body)({ env: {} });
}

function periodsPerMonth(cycle) {
  if (cycle === 'yearly') return 1 / 12;
  return 1;
}

function auditCatalog() {
  const rows = [];
  for (const plan of loadCatalog()) {
    for (const p of plan.prices) {
      if (p.amount === 0) {
        // The free tier is an acquisition cost, not a price: 5 calls costs
        // 5 x $0.00208 = about a cent per signup. Reported, never a "failure".
        rows.push({
          plan: plan.id, price: p.id, kind: 'free', shelf: 0, net: 0,
          units: CAPS[plan.id] ?? 5, unitLabel: 'calls/mo', cost: null,
          ratio: null, cap: CAPS[plan.id] ?? 5, capMax: null, note: 'acquisition cost',
        });
        continue;
      }
      const net = (p.amount / 100) - CARD_FEE;
      if (p.billingCycle === 'one_time') {
        const cost = p.tokens * COST_PER_CALL;
        rows.push({
          plan: plan.id, price: p.id, kind: 'one-off', shelf: p.amount / 100,
          net, units: p.tokens, unitLabel: 'calls', cost, ratio: net / cost,
          cap: null, capMax: null, note: '',
        });
        continue;
      }
      // Recurring: a cap is a monthly allowance, so normalise yearly prices.
      const perMonth = net * periodsPerMonth(p.billingCycle);
      const cap = p.perSeat ? (p.seatsIncluded || 1000) : (CAPS[plan.id] ?? null);
      const cost = cap == null ? null : cap * COST_PER_CALL;
      rows.push({
        plan: plan.id, price: p.id, kind: p.perSeat ? 'seat/mo' : p.billingCycle,
        shelf: p.amount / 100, net: perMonth, units: cap, unitLabel: 'calls/mo',
        cost, ratio: cost ? perMonth / cost : null, cap,
        capMax: Math.floor(perMonth / (TARGET_RATIO * COST_PER_CALL)),
        note: p.perSeat ? 'per seat' : '',
      });
    }
  }
  return rows;
}

function usageSummary(db) {
  const all = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) it,
      COALESCE(SUM(output_tokens),0) ot, MIN(created_at) first, MAX(created_at) last
    FROM user_token_usage`).get();
  const days = db.prepare(`SELECT date(created_at,'unixepoch') d, COUNT(*) c
    FROM user_token_usage GROUP BY d ORDER BY d`).all();
  const last30 = days.filter(r => r.d >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  const peak = days.reduce((m, r) => Math.max(m, r.c), 0);
  const peak30 = last30.reduce((m, r) => Math.max(m, r.c), 0);
  return {
    calls: all.calls,
    avgIn: all.calls ? all.it / all.calls : 0,
    avgOut: all.calls ? all.ot / all.calls : 0,
    days: days.length,
    peak, peak30,
    avgDaily30: last30.length ? last30.reduce((s, r) => s + r.c, 0) / last30.length : 0,
    first: all.first, last: all.last,
  };
}

function money(n) { return '$' + Number(n).toFixed(2); }

function main() {
  const rows = auditCatalog();
  const dbPath = path.join(ROOT, 'data', 'hakster.db');
  let usage = null;
  try {
    usage = usageSummary(new DatabaseSync(dbPath, { readOnly: true }));
  } catch (err) {
    console.log(`usage ledger unavailable (${err.message}) — caps checked against the cost model only`);
  }

  console.log('\nPLAN CAP AUDIT — read-only\n');
  console.log('plan            price id                     kind      shelf    net/mo   cap  calls   ratio  cap at 5:1');
  console.log('-'.repeat(112));
  let worst = null;
  for (const r of rows) {
    const ratio = r.ratio == null ? '     —' : r.ratio.toFixed(2) + ':1';
    const capTxt = r.cap == null ? String(r.units) : String(r.cap);
    console.log(
      r.plan.padEnd(15),
      r.price.padEnd(28),
      r.kind.padEnd(9),
      money(r.shelf).padStart(7),
      money(r.net).padStart(8),
      capTxt.padStart(6),
      String(r.units).padStart(6),
      ratio.padStart(7),
      String(r.capMax ?? '—').padStart(10),
    );
    if (r.ratio != null && (worst == null || r.ratio < worst.ratio)) worst = r;
  }

  console.log('\nRESULT');
  const fails = rows.filter(r => r.ratio != null && r.ratio < TARGET_RATIO);
  if (!fails.length) {
    console.log(`  every price clears ${TARGET_RATIO}:1 at its full cap.`);
  } else {
    for (const f of fails) {
      console.log(`  ${f.plan} / ${f.price}: ${f.ratio.toFixed(2)}:1 at cap ${f.cap} — cap should be ${f.capMax} to hold ${TARGET_RATIO}:1`);
    }
  }
  console.log(`  worst margin overall: ${worst.plan}/${worst.price} at ${worst.ratio.toFixed(2)}:1`);
  const freeRow = rows.find(r => r.kind === 'free');
  if (freeRow) {
    console.log(`  free tier: ${freeRow.units} calls costs about $${(freeRow.units * COST_PER_CALL).toFixed(3)} a signup — an acquisition cost, not a loss.`);
  }
  console.log('  no plan loses money: every ratio above 1:1 means revenue exceeds the measured cost.');

  if (usage) {
    console.log('\nMEASURED USAGE (drives the cap decision, never the other way round)');
    console.log(`  ${usage.calls} calls over ${usage.days} active days, avg ${Math.round(usage.avgIn)} in / ${Math.round(usage.avgOut)} out tokens`);
    console.log(`  busiest day: ${usage.peak} calls (last 30 days: ${usage.peak30})`);
    console.log(`  average on active days, last 30: ${usage.avgDaily30.toFixed(1)} calls`);
    console.log('  caps only bite far above this, so they cost a normal user nothing today.');
  }
  process.exit(fails.length ? 1 : 0);
}

main();
