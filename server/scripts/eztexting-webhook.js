#!/usr/bin/env node
'use strict';

// Register the Ez Texting inbound webhook so replies to the trial number reach
// the owner's Telegram (the "forwarding" half of the SMS infrastructure).
//
//   # in server/.env (owner writes these):
//   EZ_TEXTING_USER=...            EZ_TEXTING_PASSWORD=...
//   EZ_TEXTING_WEBHOOK_SECRET=...  (any long random string you choose)
//   EZ_TEXTING_WEBHOOK_URL=...     (optional; defaults to the public endpoint)
//
//   node server/scripts/eztexting-webhook.js            # show current subscriptions
//   node server/scripts/eztexting-webhook.js --create   # subscribe inbound_text.received
//
// Documentation facts this follows:
//   POST /v1/webhooks/subscriptions  { callbackUrl, type, secret? }   → 201 { id }
//   events: inbound_text.received | keyword.opt_in | contact.created
//   List: GET /v1/webhooks/subscriptions
// Nothing is created without --create, and an existing subscription for the same
// callback URL is reported instead of duplicated.

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const BASE = 'https://a.eztexting.com/v1';

function config() {
  return {
    user: String(process.env.EZ_TEXTING_USER || '').trim(),
    password: String(process.env.EZ_TEXTING_PASSWORD || ''),
    secret: String(process.env.EZ_TEXTING_WEBHOOK_SECRET || '').trim(),
    callback: String(process.env.EZ_TEXTING_WEBHOOK_URL || 'https://haksterai.com/api/eztexting/inbound').trim(),
  };
}

async function call(method, resource, authHeader, body) {
  const res = await fetch(BASE + resource, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      authorization: authHeader,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

(async () => {
  const c = config();
  if (!c.user || !c.password) {
    console.log('Add EZ_TEXTING_USER and EZ_TEXTING_PASSWORD to server/.env first (agents never write that file).');
    process.exit(2);
  }
  const auth = 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64');
  const create = process.argv.includes('--create');

  const listed = await call('GET', '/webhooks/subscriptions', auth);
  if (listed.status === 401) {
    console.log('❌ 401 from Ez Texting — the login in server/.env is not accepted.');
    process.exit(1);
  }
  const subs = Array.isArray(listed.data?.data) ? listed.data.data : (Array.isArray(listed.data) ? listed.data : []);
  console.log(`Existing subscriptions: ${subs.length}`);
  for (const sub of subs) {
    console.log(`  • ${sub.type || sub.event || 'unknown'} → ${sub.callbackUrl || sub.url || '(no url)'} (id ${sub.id || 'n/a'})`);
  }
  const existing = subs.find(sub => String(sub.callbackUrl || sub.url || '') === c.callback);
  if (existing) {
    console.log(`\nAlready subscribed: ${c.callback} — nothing to do.`);
    return;
  }
  if (!create) {
    console.log(`\nWould create: inbound_text.received → ${c.callback}`);
    console.log('Run again with --create to register it.');
    return;
  }
  if (!c.secret) {
    console.log('\nEZ_TEXTING_WEBHOOK_SECRET is not set. Add a long random value to server/.env so the receiver can verify deliveries.');
    process.exit(2);
  }
  const created = await call('POST', '/webhooks/subscriptions', auth, {
    callbackUrl: c.callback,
    type: 'inbound_text.received',
    secret: c.secret,
  });
  if (created.status === 201 || created.status === 200) {
    console.log(`\n✅ Subscribed inbound_text.received → ${c.callback} (id ${created.data?.id || 'n/a'})`);
  } else {
    console.log(`\n❌ Create failed: HTTP ${created.status} ${JSON.stringify(created.data)?.slice(0, 300)}`);
  }
})();
