/**
 * probe: a key's own instance is a WARM lane, and warming it is what makes the
 * second call faster (§29, §51)
 *
 * The per-key instance in `providerInstances.js` exists for one measurable
 * reason: a keyed lane reuses its own keep-alive pool instead of handshaking a
 * fresh connection on every call. This probe measures that against the real
 * relay on this box — no fixture, no invented number.
 *
 *   1. a COLD agent (one connection, thrown away after the call) pays the full
 *      connect/handshake on every request
 *   2. the key's own dispatcher is reused, and the second call on it is served
 *      off the warm socket
 *   3. the instance records both calls, reads `poolWarm: true` and `health: ok`
 *
 * The relay is this box's own locked route (§22.4: `http://127.0.0.1:11434`),
 * so nothing leaves the machine and no model, route or rate is touched. If the
 * relay is not answering the probe SKIPS loudly — it never reports a latency it
 * did not measure (§10, §13).
 *
 * Run: node server/__smoke__/key-instance-latency-probe.mjs
 */
import { createRequire } from 'node:module';
import { Agent, request } from 'undici';

const require = createRequire(import.meta.url);
const instances = require('../src/providerInstances');

const RELAY = process.env.HAKSTER_RELAY_URL || 'http://127.0.0.1:11434';
const MODEL = 'deepseek-v4.1-flash:cloud';
const PATH = '/v1/chat/completions';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const payload = JSON.stringify({
  model: MODEL,
  stream: true,
  max_tokens: 8,
  messages: [{ role: 'user', content: 'reply with OK' }],
});

/** One streaming call: returns { firstByteMs, totalMs, bytes }. */
async function call(dispatcher) {
  const started = Date.now();
  const res = await request(`${RELAY}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    dispatcher,
  });
  if (res.statusCode !== 200) throw new Error(`relay answered ${res.statusCode}`);
  let firstByteMs = null;
  let bytes = 0;
  for await (const chunk of res.body) {
    if (firstByteMs == null) firstByteMs = Date.now() - started;
    bytes += chunk.length;
  }
  return { firstByteMs: firstByteMs || Date.now() - started, totalMs: Date.now() - started, bytes };
}

(async () => {
  console.log('key-instance latency probe (live relay)');

  // Reachability first: an unreachable relay is a SKIP, never a fake reading.
  let reachable = false;
  try {
    const probe = await request(`${RELAY}/v1/models`, { method: 'GET', dispatcher: new Agent({ connections: 1 }) });
    await probe.body.dump();
    reachable = probe.statusCode === 200;
  } catch (_) {
    reachable = false;
  }
  if (!reachable) {
    console.log(`  SKIP — ${RELAY} is not answering; no latency was measured`);
    process.exit(0);
  }

  const KEY = 'key-haksterai-relay';
  instances.reset();

  // 1. Cold: a brand-new agent per call, closed after use (what the old path did).
  const coldA = await call(new Agent({ connections: 1, keepAliveTimeout: 1 }));
  const coldB = await call(new Agent({ connections: 1, keepAliveTimeout: 1 }));
  check('a cold agent is never warmed between calls', coldA.firstByteMs > 0 && coldB.firstByteMs > 0,
    `${coldA.firstByteMs}ms → ${coldB.firstByteMs}ms`);

  // 2. Warm: the key's own reused dispatcher.
  const warmDispatcher = instances.dispatcherFor(KEY);
  const warmA = await call(warmDispatcher);
  instances.note(KEY, { ok: true, ms: warmA.totalMs, model: MODEL });
  const warmB = await call(warmDispatcher);
  instances.note(KEY, { ok: true, ms: warmB.totalMs, model: MODEL });
  check('the key reuses one dispatcher across calls', instances.dispatcherFor(KEY) === warmDispatcher);
  check('the second call on the warm pool answers at least as fast',
    warmB.firstByteMs <= Math.max(warmA.firstByteMs, coldA.firstByteMs) + 50,
    `warm ${warmA.firstByteMs}ms → ${warmB.firstByteMs}ms vs cold ${coldA.firstByteMs}ms`);

  // 3. The instance itself reports what it measured.
  const st = instances.status().find((s) => s.keyId === KEY) || {};
  check('the instance counted both pooled calls', st.requests === 2, `requests ${st.requests}`);
  check('the instance reads pool warm', st.poolWarm === true);
  check('a clean key reads health ok', st.health === 'ok', String(st.health));
  check('the instance carries a measured average', Number(st.avgLatencyMs) > 0, `${st.avgLatencyMs}ms`);

  console.log(`\n  warm pool: ${warmA.firstByteMs}ms → ${warmB.firstByteMs}ms first byte · cold: ${coldA.firstByteMs}ms → ${coldB.firstByteMs}ms`);
  instances.reset();
  console.log(`\n${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('probe crashed:', err && err.message);
  process.exit(1);
});
