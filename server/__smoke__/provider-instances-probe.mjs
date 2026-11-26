/**
 * probe: one lane instance per model key (§29, §51)
 *
 * Checks the real module against the real registry — no fixtures invented:
 *   1. a lane resolves to the key that owns it, and an unknown lane resolves to
 *      a working unattributed instance (never a refusal)
 *   2. the transport of each instance is the one that key is actually reached by
 *   3. one key reuses ONE dispatcher (that is the warm pool)
 *   4. two keys never share a concurrency budget: a saturated key does not
 *      block another key's lane
 *   5. a saturated key queues, and releasing a slot lets the queue through
 *   6. measured calls move the instance's own health, per key
 *   7. status() lists every registered key under its user and carries no value
 *
 * Run: node server/__smoke__/provider-instances-probe.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const instances = require('../src/providerInstances');
const providerKeys = require('../src/providerKeys');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('provider-instances probe');

  // 1. lane → key ownership
  const byLane = {
    'deepseek-key2': instances.keyIdForLane('deepseek-key2'),
    ollama: instances.keyIdForLane('ollama'),
    'codex-cli': instances.keyIdForLane('codex-cli'),
    'no-such-lane': instances.keyIdForLane('no-such-lane'),
  };
  check('deepseek-key2 belongs to key-haksterai-1', byLane['deepseek-key2'] === 'key-haksterai-1', String(byLane['deepseek-key2']));
  check('ollama (relay) belongs to key-haksterai-relay', byLane.ollama === 'key-haksterai-relay', String(byLane.ollama));
  check('codex-cli belongs to its own codex key', byLane['codex-cli'] === 'key-haksterai-codex', String(byLane['codex-cli']));
  check('an unknown lane has no key id (never guessed)', byLane['no-such-lane'] === null, String(byLane['no-such-lane']));

  const unknown = instances.forLane('no-such-lane');
  check('an unknown lane still gets a working instance', unknown.keyId === instances.UNATTRIBUTED && unknown.attributed === false);

  // 2. transport per key
  check('keyed HTTP lane is http transport', instances.forLane('deepseek-key2').transport === 'http');
  check('relay lane is relay transport', instances.forLane('ollama').transport === 'relay');
  check('codex lane is cli transport', instances.forLane('codex-cli').transport === 'cli');

  // 3. one dispatcher per key
  const a1 = instances.dispatcherFor('key-haksterai-1');
  const a2 = instances.dispatcherFor('key-haksterai-1');
  const b1 = instances.dispatcherFor('key-haksterai-relay');
  check('one key reuses its own dispatcher (warm pool)', a1 === a2);
  check('a different key has a different dispatcher', a1 !== b1);

  // 4/5. isolation and queueing
  instances.reset();
  const httpLimit = instances.forLane('deepseek-key2').maxConcurrency;
  const held = [];
  for (let i = 0; i < httpLimit; i++) held.push(await instances.acquire('deepseek-key2'));
  check('key takes exactly its own concurrency budget', held.length === httpLimit, `${held.length}/${httpLimit}`);

  let keyedResolved = false;
  const queued = instances.acquire('deepseek-key2').then((slot) => { keyedResolved = true; return slot; });
  // another key must not wait behind the saturated one
  const otherStart = Date.now();
  const other = await instances.acquire('ollama');
  const otherWait = Date.now() - otherStart;
  check('a saturated key does not block another key', otherWait < 500 && !keyedResolved, `${otherWait}ms`);
  other.release();

  await settle();
  check('the saturated key queues its next caller', keyedResolved === false);

  held[0].release();
  const delivered = await queued;
  check('releasing a slot lets the queue through', Boolean(delivered) && keyedResolved === true);
  delivered.release();
  for (let i = 1; i < held.length; i++) held[i].release();

  // 6. measured health per key
  instances.reset();
  instances.note('deepseek-key2', { ok: true, ms: 120, model: 'test-model' });
  instances.note('deepseek-key2', { ok: true, ms: 180, model: 'test-model' });
  instances.note('ollama', { ok: false, ms: 900, model: 'test-model' });
  instances.note('ollama', { ok: false, ms: 800, model: 'test-model' });
  const stDeep = instances.status().find((s) => s.keyId === 'key-haksterai-1');
  const stRelay = instances.status().find((s) => s.keyId === 'key-haksterai-relay');
  check('a healthy key reads ok with a measured average', stDeep && stDeep.health === 'ok' && stDeep.avgLatencyMs > 0, `${stDeep && stDeep.avgLatencyMs}ms`);
  check('a failing key reads degraded, not healthy', stRelay && stRelay.health === 'degraded', stRelay && stRelay.health);
  check('a key that never ran reads idle, not zero-latency', instances.status().find((s) => s.keyId === 'key-haksterai-codex').health === 'idle');

  // 7. status shape and ownership
  const status = instances.status();
  const registry = providerKeys.loadRegistry();
  check('status lists every registered key', registry.keys.every((k) => status.some((s) => s.keyId === k.id)), `${status.length} rows`);
  check('every row names its user and userLabel', status.every((s) => s.user && s.userLabel));
  check('junkalot key is filed under its own user', (status.find((s) => s.keyId === 'key-junkalot-1') || {}).user === 'junkalot');
  const blob = JSON.stringify(status);
  check('status carries no secret-shaped value', !/apiKey|sk-|Bearer|fingerprint/i.test(blob));
  // A warm pool means the key's HTTP lane actually made a pooled call; a CLI key
  // (codex) has no HTTP pool at all and must never claim one.
  instances.dispatcherFor('key-haksterai-1');
  const warmed = instances.status();
  check('status reports the pool warm only after a call', warmed.find((s) => s.keyId === 'key-haksterai-1').poolWarm === true
    && warmed.find((s) => s.keyId === 'key-haksterai-codex').poolWarm === false);

  instances.reset();
  console.log(`\n${pass} pass · ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('probe crashed:', err && err.message);
  process.exit(1);
});
