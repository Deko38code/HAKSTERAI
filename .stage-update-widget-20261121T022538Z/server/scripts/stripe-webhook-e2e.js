#!/usr/bin/env node
/**
 * End-to-end exercise of the LIVE haksterai Stripe webhook.
 * Fires correctly-signed events at 127.0.0.1:3579 and checks what the running
 * server actually did to the database. Uses throwaway rows prefixed
 * `test_stripe_` / `sub_TEST…` and removes only those at the end.
 * Never prints any secret.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const Stripe = require(path.join(ROOT, 'node_modules/stripe'));
const Database = require(path.join(ROOT, 'server/node_modules/better-sqlite3'));

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, 'server/.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SECRET = env.STRIPE_WEBHOOK_SECRET;
if (!SECRET) { console.log('FAIL: no STRIPE_WEBHOOK_SECRET in server/.env'); process.exit(1); }
const stripe = Stripe(env.STRIPE_SECRET_KEY || 'sk_test_unused');
const db = new Database(path.join(ROOT, 'data/hakster.db'));
db.pragma('busy_timeout = 5000');

const tag = Math.random().toString(36).slice(2, 8);
const USER_ID = 'test_stripe_' + tag;
const CUSTOMER = 'cus_TEST_' + tag;
const SUB_NEW = 'sub_TESTNEW_' + tag;
const SUB_OLD = 'sub_TESTOOLD_' + tag;
const INVOICE = 'in_TEST_' + tag;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (detail ? ' — ' + detail : '')); };

const post = async (type, object) => {
  const payload = JSON.stringify({ id: 'evt_TEST' + tag + '_' + type + '_' + Math.random().toString(36).slice(2, 6), object: 'event', type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const res = await fetch('http://127.0.0.1:3579/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
  const body = await res.text();
  return { status: res.status, body };
};

(async () => {
  // price ids from the live catalog (what checkout actually sells)
  const plans = await (await fetch('http://127.0.0.1:3579/api/stripe/plans')).json();
  const proPlan = plans.plans.find(p => p.id === 'pro');
  const proPrice = proPlan && proPlan.prices.find(p => p.priceId);
  if (!proPrice) { console.log('FAIL: no pro price in live catalog'); process.exit(1); }
  console.log('using pro price id from live catalog (redacted):', proPrice.priceId.slice(0, 8) + '…');

  // ── fixtures ──────────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO users (id, username, email, api_key, role, plan, status, stripe_customer_id)
              VALUES (?, ?, ?, ?, 'user', 'free', 'active', ?)`)
    .run(USER_ID, USER_ID, USER_ID + '@example.invalid', 'hkai_test_' + tag, CUSTOMER);
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan, billing_cycle, status, provider_sub_id) VALUES (?, ?, 'pro', 'monthly', 'active', ?)`)
    .run('test_sub_new_' + tag, USER_ID, SUB_NEW);
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan, billing_cycle, status, provider_sub_id) VALUES (?, ?, 'starter', 'monthly', 'active', ?)`)
    .run('test_sub_old_' + tag, USER_ID, SUB_OLD);

  const subPayload = (subId, status, priceId) => ({
    id: subId, object: 'subscription', customer: CUSTOMER, status,
    current_period_start: Math.floor(Date.now() / 1000) - 60,
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
    items: { object: 'list', data: [{ id: 'si_' + tag, object: 'subscription_item', price: { id: priceId, object: 'price' } }] },
    metadata: { userId: USER_ID },
  });

  // ── 1. subscription.updated → plan flips to pro ──────────────────────────
  let r = await post('customer.subscription.updated', subPayload(SUB_NEW, 'active', proPrice.priceId));
  let u = db.prepare('SELECT plan FROM users WHERE id = ?').get(USER_ID);
  check('subscription.updated switches user to pro', r.status === 200 && u.plan === 'pro', `http ${r.status}, plan ${u.plan}`);

  // ── 2. old subscription deleted during an upgrade keeps the new plan ─────
  db.prepare("UPDATE users SET plan = 'pro' WHERE id = ?").run(USER_ID);
  r = await post('customer.subscription.deleted', subPayload(SUB_OLD, 'canceled', proPrice.priceId));
  u = db.prepare('SELECT plan FROM users WHERE id = ?').get(USER_ID);
  const oldRow = db.prepare('SELECT status FROM subscriptions WHERE provider_sub_id = ?').get(SUB_OLD);
  check('old-sub delete does NOT downgrade an upgraded account', r.status === 200 && u.plan === 'pro' && oldRow.status === 'expired', `http ${r.status}, plan ${u.plan}, old sub ${oldRow.status}`);

  // ── 3. deleting the LAST active subscription does downgrade ──────────────
  r = await post('customer.subscription.deleted', subPayload(SUB_NEW, 'canceled', proPrice.priceId));
  u = db.prepare('SELECT plan FROM users WHERE id = ?').get(USER_ID);
  check('deleting the last subscription downgrades to free', r.status === 200 && u.plan === 'free', `http ${r.status}, plan ${u.plan}`);

  // ── 4. a paid renewal restores a plan a stale event dropped ──────────────
  db.prepare("UPDATE subscriptions SET status = 'active' WHERE provider_sub_id = ?").run(SUB_NEW);
  r = await post('invoice.payment_succeeded', {
    id: INVOICE, object: 'invoice', customer: CUSTOMER, subscription: SUB_NEW,
    paid: true, amount_paid: 1999, amount_due: 1999, currency: 'usd', attempt_count: 1,
  });
  u = db.prepare('SELECT plan FROM users WHERE id = ?').get(USER_ID);
  const payRow = db.prepare('SELECT amount, plan FROM payments WHERE provider_id = ?').get(INVOICE);
  check('paid invoice restores the paid plan on a free account', r.status === 200 && u.plan === 'pro' && !!payRow, `http ${r.status}, plan ${u.plan}, ledger ${payRow ? '$' + payRow.amount : 'none'}`);

  // ── 5. redelivery is idempotent (no second ledger row) ───────────────────
  await post('invoice.payment_succeeded', {
    id: INVOICE, object: 'invoice', customer: CUSTOMER, subscription: SUB_NEW,
    paid: true, amount_paid: 1999, amount_due: 1999, currency: 'usd', attempt_count: 1,
  });
  const count = db.prepare('SELECT COUNT(*) AS c FROM payments WHERE provider_id = ?').get(INVOICE).c;
  check('redelivered invoice writes no second ledger row', count === 1, `rows ${count}`);

  // ── 6. failed payment marks past_due and leaves the plan alone ───────────
  r = await post('invoice.payment_failed', { id: 'in_TESTFAIL_' + tag, object: 'invoice', customer: CUSTOMER, subscription: SUB_NEW, amount_due: 1999, currency: 'usd', attempt_count: 2 });
  const subStatus = db.prepare('SELECT status FROM subscriptions WHERE provider_sub_id = ?').get(SUB_NEW).status;
  u = db.prepare('SELECT plan FROM users WHERE id = ?').get(USER_ID);
  check('failed invoice marks past_due without changing the plan', r.status === 200 && subStatus === 'past_due' && u.plan === 'pro', `http ${r.status}, sub ${subStatus}, plan ${u.plan}`);

  // ── 7. bad signature is rejected ─────────────────────────────────────────
  const bad = await fetch('http://127.0.0.1:3579/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: '{"id":"evt_bad","type":"invoice.payment_succeeded","data":{"object":{}}}' });
  check('unsigned/forged delivery is rejected', bad.status === 400, `http ${bad.status}`);

  // ── 8. the log card API returns these outcomes to the owner ─────────────
  const owner = db.prepare("SELECT api_key FROM users WHERE lower(email) = 'dekekenneth840@gmail.com' AND api_key IS NOT NULL LIMIT 1").get();
  if (owner) {
    const res = await fetch('http://127.0.0.1:3579/api/admin/stripe-webhook-log?limit=50', { headers: { 'x-api-key': owner.api_key } });
    const data = await res.json();
    const mine = (data.events || []).filter(e => e.user_id === USER_ID);
    const outcomes = mine.map(e => e.outcome).sort();
    const hasAgo = mine.every(e => Number.isFinite(e.secondsAgo));
    check('owner log API shows every outcome with seconds-ago', res.status === 200 && outcomes.includes('plan-changed') && outcomes.includes('kept-plan') && outcomes.includes('downgraded') && outcomes.includes('renewal-paid') && outcomes.includes('plan-restored') && outcomes.includes('payment-failed') && hasAgo,
      `http ${res.status}, outcomes [${outcomes.join(',')}], secondsAgo ok=${hasAgo}`);
  } else {
    check('owner log API', false, 'no admin api key found');
  }

  // ── cleanup: only the rows this test created ─────────────────────────────
  db.prepare("DELETE FROM payments WHERE user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
  db.prepare("DELETE FROM stripe_webhook_events WHERE user_id = ?").run(USER_ID);
  const left = db.prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(USER_ID).c;
  check('test rows cleaned up', left === 0, `remaining users ${left}`);

  const failed = results.filter(x => !x.ok);
  console.log('\n' + (failed.length ? '❌ ' + failed.length + ' check(s) failed' : '✅ all ' + results.length + ' checks passed'));
  db.close();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('TEST HARNESS ERROR:', e && e.message);
  try {
    db.prepare("DELETE FROM payments WHERE user_id = ?").run(USER_ID);
    db.prepare("DELETE FROM subscriptions WHERE user_id = ?").run(USER_ID);
    db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
    db.prepare("DELETE FROM stripe_webhook_events WHERE user_id = ?").run(USER_ID);
    db.close();
  } catch {}
  process.exit(1);
});
