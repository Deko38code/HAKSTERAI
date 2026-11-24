/**
 * cli-attach-guard-probe — pins the "never auto-apply while a CLI session is
 * attached" rule (2026-11-24, owner: "no restart").
 *
 * Runs the REAL server/src/serverBuild.js in a child process with a shifted
 * Date.now, so uptime/quiet/attach windows can be crossed without waiting.
 *
 *  1. no CLI seen, box past boot + quiet  -> isIdle() true (apply allowed)
 *  2. CLI polled just now                 -> isIdle() false (held)
 *  3. hold reason names the CLI session
 *  4. CLI stops polling > CLI_ATTACH_MS   -> isIdle() true again (ages out)
 *  5. CLI polls again                     -> held again
 *  6. the explicit owner route is NOT gated by cliAttached (applyNow untouched)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '..', 'src', 'serverBuild.js');

const body = `
const assert = require('node:assert');
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const sb = require(${JSON.stringify(MOD)});

// 1. past the 90 s boot gate and the 60 s quiet window, no CLI
shift += 200000;
assert.strictEqual(sb.cliAttached(), false, '1: no CLI seen yet');
assert.strictEqual(sb.isIdle(), true, '1: idle, apply allowed');

// 2. CLI polls /api/tui/status now
sb.noteCliSeen();
assert.strictEqual(sb.cliAttached(), true, '2: CLI attached');
assert.strictEqual(sb.isIdle(), false, '2: held while CLI attached');

// 3. the status says why, for the log and /api/version
const st = sb.status();
assert.strictEqual(st.cliAttached, true, '3: status.cliAttached');
assert.strictEqual(st.idle, false, '3: status.idle');
assert.strictEqual(st.holdReason, 'CLI session attached', '3: holdReason');

// 4. CLI exits; a stale heartbeat ages out on its own
shift += sb._constants.CLI_ATTACH_MS + 1000;
assert.strictEqual(sb.cliAttached(), false, '4: heartbeat aged out');
assert.strictEqual(sb.isIdle(), true, '4: idle again, apply resumes');

// 5. CLI reattaches -> held again
sb.noteCliSeen();
assert.strictEqual(sb.isIdle(), false, '5: held again on reattach');

// 6. the CLI guard lives in isIdle() (the tick), never in applyNow (owner route)
assert.strictEqual(typeof sb.applyNow, 'function', '6: applyNow still exported');
const src = require('node:fs').readFileSync(${JSON.stringify(MOD)}, 'utf8');
const fn = src.slice(src.indexOf('function applyNow'));
assert.ok(!/cliAttached\\(\\)/.test(fn.slice(0, fn.indexOf('function tick'))),
  '6: applyNow itself is not CLI-gated');

console.log('ok 6/6');
`;

const out = execFileSync(process.execPath, ['-e', body], { encoding: 'utf8' });
process.stdout.write(out);
