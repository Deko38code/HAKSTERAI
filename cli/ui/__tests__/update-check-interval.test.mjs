/* The update check runs every 5 minutes.
 *
 * Owner, 2026-11-26: "lets make the update check faster then 30 min" → 15, then
 * "make sure are cli updates poll servere every 5 min" → 5. A check while the
 * install is current is one small GET of /cli/latest.json, so the interval is
 * cheap to shorten; the pref makes 1 minute a setting, not a code change.
 *
 * Pinned here:
 *   1. the default is 5 minutes and lives in prefs, not a literal in the hook;
 *   2. the interval is clamped to 1–240 minutes, so a typo cannot poll every
 *      second or silently disable the check;
 *   3. the timer is fixed per session (ref), jitter included, so a re-render
 *      never resets it and sessions do not fire in lockstep;
 *   4. no 30-minute default survives in the hook.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..', '..');
const HOOK = fs.readFileSync(path.join(cliRoot, 'ui', 'src', 'hooks', 'useCliUpdate.js'), 'utf8');
const PREFS = fs.readFileSync(path.join(cliRoot, 'src', 'prefs.js'), 'utf8');

test('the default interval comes from prefs and is 5 minutes', () => {
  assert.match(PREFS, /updateCheckMinutes: 5,/, 'the default is 5 minutes');
  assert.match(HOOK, /prefs\.load\(\)\.updateCheckMinutes/, 'the hook reads the pref');
  assert.ok(!/intervalMs\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(HOOK), 'no 30-minute default in the hook');
});

test('the interval is clamped to 1–240 minutes', () => {
  assert.match(HOOK, /Math\.min\(240, Math\.max\(1, mins\)\)/, 'clamped, so a typo cannot break the check');
});

test('the timer is fixed per session, with jitter', () => {
  assert.match(HOOK, /const tickMs = useRef\(0\);/, 'the interval is resolved once per session');
  assert.match(HOOK, /setInterval\(tick, tickMs\.current\)/, 'the effect uses the resolved value');
  assert.match(HOOK, /Math\.random\(\)/, 'a per-session jitter spreads the checks');
  // A re-render must not restart the timer, so the reset cannot key on a value
  // that changes between renders.
  assert.ok(!/setInterval\(tick, intervalMs\)/.test(HOOK), 'never the raw argument');
});

test('the settings panel can show and change the interval', () => {
  assert.match(PREFS, /updateCheckMinutes: \{ label: 'Check every'/, 'it appears in the settings metadata');
});
