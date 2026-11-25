/**
 * run-gate-probe — pins the multi-user admission gate (2026-11-26, owner:
 * "make sure our server can handle multiple users no lag").
 *
 * Why: one claude-cli turn costs ~635 MB on this Dell (247 MB for `claude -p`
 * plus 388 MB for its six core MCP servers, measured 2026-11-26). Without a
 * gate the fifth concurrent turn pushes the box into swap and every session
 * lags. The gate holds concurrency to the hardware and queues the rest.
 *
 * Checks, against the REAL server/src/agent/run-gate.js:
 *  1. deriveLimits on this box (4 core / 7852 MB) admits 3 turns, not 20
 *  2. peak concurrency never exceeds maxConcurrent
 *  3. one account never holds more than maxPerUser slots
 *  4. waiters are granted in arrival order (FIFO — nobody is starved)
 *  5. every waiter settles: 8 turns in, 8 turns out, 0 slots / 0 queue left
 *  6. release() is idempotent — a double release cannot inflate the pool
 *  7. a client that never gets a slot is rejected with queue-timeout
 *  8. the agent-run handler actually admits through the gate (source pin)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '..', 'src', 'agent', 'run-gate.js');
const INDEX = path.join(HERE, '..', 'src', 'index.js');

const body = `
const assert = require('node:assert');
const { createRunGate, deriveLimits } = require(${JSON.stringify(MOD)});

(async () => {
  // 1. what this machine is allowed to run at once
  const d = deriveLimits({ cpus: 4, totalMemMb: 7852 });
  assert.strictEqual(d.maxConcurrent, 3, '1: 4 core / 7.8 GB box admits 3 turns');
  assert.strictEqual(d.maxPerUser, 2, '1: one account may hold 2 slots');
  assert.ok(deriveLimits({ cpus: 64, totalMemMb: 65536 }).maxConcurrent <= 4,
    '1: the ceiling is bounded even on a huge box');

  // 2/3/4/5/6. concurrency, per-account cap, FIFO, full drain, idempotent release
  const g = createRunGate({ maxConcurrent: 3, maxPerUser: 2, maxWaitMs: 8000 });
  let live = 0, peak = 0;
  const liveUser = {}, peakUser = {}, finished = [];
  const turn = (u, ms) => g.acquire({ userId: u }).then((rel) => {
    live += 1; liveUser[u] = (liveUser[u] || 0) + 1;
    peak = Math.max(peak, live);
    peakUser[u] = Math.max(peakUser[u] || 0, liveUser[u]);
    return new Promise((r) => setTimeout(r, ms)).then(() => {
      live -= 1; liveUser[u] -= 1; finished.push(u);
      rel(); rel(); // 6: release must be idempotent
    });
  });
  await Promise.all(['A','A','A','B','B','C','D','E'].map((u) => turn(u, 60)));
  assert.ok(peak <= 3, '2: peak concurrency ' + peak + ' never exceeds 3');
  assert.ok(Object.values(peakUser).every((v) => v <= 2),
    '3: no account held more than 2 slots (' + JSON.stringify(peakUser) + ')');
  assert.strictEqual(finished.length, 8, '5: every one of the 8 turns completed');
  const after = g.state();
  assert.strictEqual(after.active, 0, '5: all slots returned');
  assert.strictEqual(after.queued, 0, '5: queue drained');

  // 4. FIFO
  const g2 = createRunGate({ maxConcurrent: 1, maxPerUser: 2, maxWaitMs: 8000 });
  const order = [];
  const held = await g2.acquire({ userId: 'H' });
  const waiters = ['u1','u2','u3','u4'].map((u) =>
    g2.acquire({ userId: u }).then((rel) => { order.push(u); rel(); }));
  setTimeout(() => held(), 25);
  await Promise.all(waiters);
  assert.strictEqual(order.join(','), 'u1,u2,u3,u4', '4: waiters granted in arrival order');

  // 7. a starved waiter is told, not left hanging. Keep a ref'd timer alive so
  // the probe itself does not exit before the gate's (unref'd) timeout fires.
  const keepAlive = setInterval(() => {}, 50);
  const g3 = createRunGate({ maxConcurrent: 1, maxPerUser: 1, maxWaitMs: 150 });
  const busy = await g3.acquire({ userId: 'X' });
  const code = await g3.acquire({ userId: 'Y' }).then(() => null, (e) => e.code);
  clearInterval(keepAlive);
  assert.strictEqual(code, 'queue-timeout', '7: starved waiter rejects with queue-timeout');
  assert.strictEqual(g3.state().queued, 0, '7: timed-out waiter leaves the queue');
  busy();

  console.log('ok 7/7');
})();
`;

const out = execFileSync(process.execPath, ['-e', body], { encoding: 'utf8' });
process.stdout.write(out);

// 8. the handler admits before it calls a model — source pin, not a behaviour guess.
const src = fs.readFileSync(INDEX, 'utf8');
const handler = src.slice(src.indexOf("app.post('/api/agent/run'"));
const admit = handler.indexOf('await admitStreamingRun(req, res)');
const spawnCall = handler.indexOf('runClaudeCliAgent(');
if (admit < 0) throw new Error('8: agent-run handler does not admit through the gate');
if (spawnCall < 0) throw new Error('8: runClaudeCliAgent call not found in the handler');
if (!(admit < spawnCall)) throw new Error('8: the gate must run before the claude CLI lane starts');
const helper = src.slice(src.indexOf('async function admitStreamingRun'));
if (!/agentRunGate\.acquire\(/.test(helper.slice(0, 2000))) {
  throw new Error('8: admitStreamingRun does not take a slot');
}
if (!/res\.on\('close'/.test(helper.slice(0, 2000)) || !/clientGone/.test(helper.slice(0, 2000))) {
  throw new Error('8: the slot is not released on close / client-gone');
}
console.log('ok 8/8');

// 9–11. the chat lane is admitted through the same gate the agent lane uses.
// The waterfall can fall through to claude-cli from any chat endpoint, and that
// lane spawns the same ~635 MB process, so it must not have a private budget.
const providerBody = `
const assert = require('node:assert');
const { agentRunGate } = require(${JSON.stringify(MOD)});
const providers = require(${JSON.stringify(path.join(HERE, '..', 'src', 'providers.js'))});

(async () => {
  // 9. one instance for the whole process
  const again = require(${JSON.stringify(MOD)}).agentRunGate;
  assert.strictEqual(agentRunGate, again, '9: run-gate exports one shared instance');

  // 10. with every slot held, the claude-cli lane does not start a child
  const holds = [];
  for (let i = 0; i < agentRunGate.state().maxConcurrent; i += 1) {
    holds.push(await agentRunGate.acquire({ userId: 'probe-' + i }));
  }
  assert.strictEqual(agentRunGate.state().active, agentRunGate.state().maxConcurrent,
    '10: the probe fills the gate');

  const started = [];
  const it = providers.chatStream({
    provider: 'claude-cli',
    model: 'deepseek-v4.1-flash:cloud',
    messages: [{ role: 'user', content: 'probe' }],
    system: 'probe',
  });
  const drained = (async () => { for await (const ev of it) { started.push(ev); break; } })();
  const raced = await Promise.race([
    drained.then(() => 'streamed'),
    new Promise((r) => setTimeout(() => r('held'), 1200)),
  ]);
  assert.strictEqual(raced, 'held',
    '10: a full gate holds the claude-cli lane instead of starting a process');
  assert.strictEqual(started.length, 0, '10: nothing was emitted while held');

  // 11. and the lane is still queued, not dropped
  assert.ok(agentRunGate.state().queued >= 1, '11: the held turn is queued, not lost');
  console.log('ok 11/11');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
`;

execFileSync(process.execPath, ['-e', providerBody], { encoding: 'utf8', stdio: 'inherit' });

// 12. source pin: both lanes admit through the shared instance, not their own.
const provSrc = fs.readFileSync(path.join(HERE, '..', 'src', 'providers.js'), 'utf8');
if (!/const \{ agentRunGate \} = require\('\.\/agent\/run-gate'\)/.test(provSrc)) {
  throw new Error('12: providers.js does not import the shared gate');
}
if (!/async function claudeCliComplete\(opts\)[\s\S]{0,400}agentRunGate\.acquire/.test(provSrc)) {
  throw new Error('12: claudeCliComplete is not admitted through the gate');
}

if (!/async function\* claudeCliStream\(opts\)[\s\S]{0,400}agentRunGate\.acquire/.test(provSrc)) {
  throw new Error('12: claudeCliStream is not admitted through the gate');
}
if (!/const \{ agentRunGate \} = require\('\.\/agent\/run-gate'\)/.test(src)) {
  throw new Error('12: index.js does not use the shared gate instance');
}
if (/createRunGate\(/.test(src)) {
  throw new Error('12: index.js must not create a second gate');
}
console.log('ok 12/12');
