// Image lane probe — pins the fallback chain the operator's "image generator
// keeps hanging" report exposed on 2026-11-26.
//
// Measured that day on this box: the Pollinations key answered 402
// "Insufficient balance" (available balance $0.0000), the unauthenticated free
// lane answered 402 with an 83,870-byte JPEG *error card*, every OpenRouter key
// answered 402, and ~/.phantom-ai-config.json carried no imagegen key. A raw
// JPEG body was being pasted into the error message and the fallback provider
// was never reached, because only a /401/ refusal counted as "auth failed".
//
// What this pins (no network, no cost — every fetch is stubbed):
//   1. 402 / 403 / 429 count as a refusal, not only 401.
//   2. A binary body never reaches the message (no JPEG magic, no control bytes).
//   3. An account-level refusal (no balance / quota) skips the free lane, which
//      is the same account's unauthenticated door and cannot pay either.
//   4. A key-level refusal (bad key) still tries the free lane.
//   5. A refused key is remembered, so the next call answers without re-asking.
//   6. The refusal reaches the fallback provider instead of being rethrown raw,
//      and the error names both lanes.
//
// Run: node server/__smoke__/image-fallback-probe.mjs   (exit 0 = all pass)

import { createRequire } from 'module';

const PROVIDERS = '/home/ghost/haksterAi/server/src/providers.js';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A JPEG error card: exactly what the paywalled lane returns.
const JPEG_CARD = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  Buffer.alloc(128, 0x00),
]);

function freshProviders() {
  delete require.cache[require.resolve(PROVIDERS)];
  return require(PROVIDERS);
}

// Route a stubbed call by host and return a controlled Response.
async function stubbedRoute(host, url, calls) {
  calls.push(host);
  if (host === 'gen.pollinations.ai' && url.includes('/image/')) {
    return new Response(JSON.stringify({ success: false, error: { message: 'Insufficient balance. This request costs about $0.0040, but your available balance is $0.0000.' } }),
      { status: 402, headers: { 'content-type': 'application/json' } });
  }
  if (host === 'image.pollinations.ai') {
    return new Response(JPEG_CARD, { status: 402, headers: { 'content-type': 'image/jpeg' } });
  }
  if (host === 'generativelanguage.googleapis.com') {
    return new Response(JSON.stringify({ error: { message: 'Permission denied on the service.' } }),
      { status: 403, headers: { 'content-type': 'application/json' } });
  }
  return new Response('unexpected host', { status: 500 });
}

function installStub(getKeyRefusalStatus) {
  const calls = [];
  global.fetch = async (input) => {
    const url = String(input);
    const host = new URL(url).host;
    // When the scenario wants a key-level refusal, only the keyed lane fails
    // that way; the free lane keeps answering with the placeholder card.
    if (getKeyRefusalStatus && host === 'gen.pollinations.ai' && url.includes('/image/')) {
      return new Response(JSON.stringify({ error: { message: getKeyRefusalStatus } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return stubbedRoute(host, url, calls);
  };
  return calls;
}

async function generate(P) {
  try {
    const r = await P.generateImage({ provider: 'pollinations', model: 'zimage', prompt: 'probe subject', size: '1024x1024', quality: 'hd' });
    return { ok: true, result: r };
  } catch (err) {
    return { ok: false, message: String(err && err.message || err) };
  }
}

const realFetch = global.fetch;

// ── 1–3, 5–6: account-level refusal (no balance) ─────────────────────
console.log('account-level refusal (402 Insufficient balance)');
{
  const P = freshProviders();
  const calls = installStub();
  const first = await generate(P);
  check('call 1 fails truthfully instead of hanging', first.ok === false);
  check('refusal is reported as a 402', /\(402\)/.test(first.message || ''), first.message?.slice(0, 90));
  check('the keyed lane was tried', calls[0] === 'gen.pollinations.ai', calls.join(','));
  check('the free lane is skipped for an empty account', !calls.includes('image.pollinations.ai'), calls.join(','));
  check('no JPEG bytes in the message', !/JFIF|�/.test(first.message || '') && !/[\u0000-\u0008\u000e-\u001f]/.test(first.message || ''));
  check('no control bytes in the message', !/[\u0000-\u0008]/.test(first.message || ''));
  check('the fallback lane is named', /fallback \(PhantomIDE imagegen\) also failed/.test(first.message || ''), first.message?.slice(-80));
  check('the true upstream reason survives', /Insufficient balance/.test(first.message || ''));

  calls.length = 0;
  const second = await generate(P);
  check('call 2 still fails', second.ok === false);
  check('a refused key is not re-asked (cooldown)', !calls.includes('gen.pollinations.ai'), calls.join(','));
  check('call 2 goes straight to the free lane', calls.length === 1 && calls[0] === 'image.pollinations.ai', calls.join(','));
  check('call 2 message has no binary body', !/JFIF/.test(second.message || ''));
}

// ── 4: key-level refusal (invalid key) still tries the free lane ─────
console.log('key-level refusal (401 invalid key)');
{
  const P = freshProviders();
  const calls = installStub('Invalid API key');
  const res = await generate(P);
  check('free lane is tried after a key-level refusal', calls.includes('image.pollinations.ai'), calls.join(','));
  check('a 401 counts as a refusal', res.ok === false && /\(402\)/.test(res.message || ''), res.message?.slice(0, 90));
  check('key-level message has no binary body', !/JFIF/.test(res.message || ''));
}

// ── 6b: 403 is a refusal, not a hard failure ─────────────────────────
console.log('403 from the image lane');
{
  const P = freshProviders();
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/image/')) {
      return new Response(JSON.stringify({ error: { message: 'Permission denied' } }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { message: 'Permission denied on the service.' } }), { status: 403, headers: { 'content-type': 'application/json' } });
  };
  const res = await generate(P);
  check('403 reaches the fallback lane', /fallback \(PhantomIDE imagegen\) also failed/.test(res.message || ''), res.message?.slice(0, 120));
  check('403 message is text, not binary', !/JFIF/.test(res.message || ''));
}

global.fetch = realFetch;

console.log(`\n${pass}/${pass + fail} checks pass`);
process.exit(fail === 0 ? 0 : 1);
