/* §39 — the CLI compacts like the owner's own session, and a version change
 * shows up everywhere without a second edit.
 *
 * Owner, 2026-11-25: "make sure the cli auto compact is set like this cli is in
 * this session and make it to where each time the version changes it gets
 * updated also add rule … and add compacting conversation while doing it".
 *
 * Three things are pinned here, one per clause:
 *   1. every lane that spawns `claude` carries the session's compact window
 *      (200000) and max context (1048576) as literals;
 *   2. the conversation is compacted while the run works — a model summary of
 *      the older turns, round-safe, once per run — and the TUI renders the
 *      server's `compact` event;
 *   3. the CLI version has one source: `cli/package.json` feeds
 *      `/cli/latest.json`, and the site badge reads that endpoint, so bumping
 *      the version updates the site with no hardcoded copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', '..', '..', ...p), 'utf8');

const COMPACT_WINDOW = '200000';
const MAX_CONTEXT = '1048576';

test('every claude spawn carries this session’s compact window and max context', () => {
  // The value must be a literal in code (§22.4) — but there is ONE place that
  // defines it. A lane may carry the literals itself or delegate to
  // providers.claudeCliEnv(); a delegating lane is verified against the
  // canonical body, so the pin follows the value instead of demanding a copy.
  const canonical = read('server/src/providers.js');
  const cStart = canonical.indexOf('function claudeCliEnv()');
  const canonicalBody = canonical.slice(cStart, canonical.indexOf('\n}', cStart));
  for (const file of ['server/src/providers.js', 'server/src/agent/index.js']) {
    const src = read(file);
    const start = src.indexOf('function claudeCliEnv()');
    assert.ok(start !== -1, `${file} has no claudeCliEnv()`);
    let body = src.slice(start, src.indexOf('\n}', start));
    const delegates = /require\('\.\.\/providers'\)\.claudeCliEnv\s*\(/.test(body)
      || /require\('\.\.\/providers'\)\.claudeCliEnv/.test(body);
    if (delegates) body = canonicalBody;
    for (const [key, value] of [
      ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', COMPACT_WINDOW],
      ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', MAX_CONTEXT],
    ]) {
      const m = body.match(new RegExp(`${key}:\\s*'([^']*)'`));
      assert.ok(m, `${file}: ${key} is missing from claudeCliEnv()`);
      assert.equal(m[1], value, `${file}: ${key} is ${m[1]}, not this session's ${value}`);
    }
  }
});

test('the compact window is a literal in code, never env-driven (§22.4)', () => {
  const src = read('server/src/providers.js');
  const start = src.indexOf('function claudeCliEnv()');
  const body = src.slice(start, src.indexOf('\n}', start));
  // Values come from the literals above — an env lookup here would let a
  // settings edit move them, which §22.4 forbids.
  assert.doesNotMatch(body, /process\.env\.CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.doesNotMatch(body, /process\.env\.CLAUDE_CODE_MAX_CONTEXT_TOKENS/);
});

test('the run compacts its conversation while it works, once, round-safe', () => {
  const src = read('server/src/index.js');
  // The summarising pass exists and replaces older turns with one summary.
  assert.match(src, /async function summarizeOldTurns\(/);
  assert.match(src, /SESSION SUMMARY \(older turns compacted/);
  // Bounded to one pass per run.
  assert.match(src, /let _summaryDone = false;/);
  assert.match(src, /if \(_summaryDone\) return false;/);
  // Called both on the incoming history and mid-run, before the ceiling.
  assert.match(src, /summarizeOldTurns\(agentMessages, 'pre-flight'\)/);
  assert.match(src, /summarizeOldTurns\(agentMessages, `turn \$\{turn\}`\)/);
  // Dropping old history removes whole turns, so a tool_call never loses its
  // tool results (an orphaned pair makes the provider reject the call).
  assert.match(src, /function dropOldestTurn\(msgs\)/);
  assert.match(src, /const dropped = dropOldestTurn\(msgs\);/);
  assert.match(src, /dropOldestTurn\(agentMessages\); \/\/ whole turns only/);
  // The pass reports itself honestly to the client.
  assert.match(src, /type: 'compact'/);
  assert.match(src, /summarized: true/);
});

test('the TUI renders the server’s compact event without reshaping a panel', () => {
  const src = read('cli/ui/src/hooks/useAgentStream.js');
  assert.match(src, /case 'compact': \{/);
  // One activity line and one notice turn — no panel props, no layout change.
  const block = src.slice(src.indexOf("case 'compact'"), src.indexOf('break;', src.indexOf("case 'compact'")));
  assert.match(block, /pushActivity\('sys', text\)/);
  assert.match(block, /tone: 'notice'/);
  assert.doesNotMatch(block, /<[A-Z]/); // never JSX / panel markup in the stream hook
});

test('one version source: package.json → /cli/latest.json → the site badge', () => {
  // The endpoint computes from the file on every request — never a copy.
  const server = read('server/src/index.js');
  assert.match(server, /app\.get\('\/cli\/latest\.json'/);
  assert.match(server, /res\.json\(require\('\.\/cliBuild'\)\.cliBuildInfo\(\)\)/);
  // …computed from the file in the shared module, so /api/version and the site
  // badge read exactly the same values (§39.3).
  const cliBuild = read('server/src/cliBuild.js');
  assert.match(cliBuild, /readFileSync\(pkgPath, 'utf8'\)/);
  assert.match(cliBuild, /version: String\(pkg\.version \|\| ''\)/);

  // The site badge reads that file at build time…
  const hero = read('src/components/Hero.astro');
  assert.match(hero, /readCliVersion\(\)/);
  assert.match(hero, /path\.join\(dir, 'cli', 'package\.json'\)/);
  // …and refreshes from the same endpoint once the page is open, so a bump
  // reaches an already-loaded tab without a rebuild.
  assert.match(hero, /fetch\('\/cli\/latest\.json', \{ cache: 'no-store' \}\)/);
  assert.match(hero, /id="hero-cli-version"/);
  // No hardcoded version string may reappear in the badge's place.
  assert.doesNotMatch(hero, /v1\.0 · always running/);
});
