/* §28.5 — the paid-plan gate is server-side, and every CLI surface says it is
 * the CLI so the gate actually runs there.
 *
 * The hole this pins shut (found 2026-11-26 while checking the Windows install
 * for paid users): `/api/agent/run` only enforces `requireCliEntitlement` when
 * the request carries `x-hakster-client: cli`. `cli/index.js` sent it; the TUI's
 * agent call in `cli/ui/src/hooks/useAgentStream.js` did not. A signed-in
 * account whose plan does not include the CLI could therefore run the whole
 * agent through the TUI while every other command refused it.
 *
 * Four things are pinned here, so a later edit cannot quietly reopen it:
 *   1. the TUI's /api/agent/run request identifies as the CLI;
 *   2. the shipped bundle (ui-fb.mjs) carries the same header — a source-only
 *      fix has not shipped (§28.1);
 *   3. a 403 is reported with the server's own reason and upgrade path, not
 *      "server replied 403";
 *   4. the gate itself still sits on the route, and the non-TUI CLI still
 *      sends the header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', '..', '..', ...p), 'utf8');

/** The block around the `/api/agent/run` fetch in a file, wide enough to hold
 *  its headers and its !ok branch but narrow enough not to catch another call. */
function agentRunBlock(src) {
  // Anchor on the fetch call itself, not on the doc comment above it — the
  // header comment also mentions `/api/agent/run`, and slicing from there
  // examined prose instead of the request.
  const m = src.match(/fetch\(`[^`]*\/api\/agent\/run`/);
  assert.ok(m, 'no /api/agent/run fetch found');
  return src.slice(m.index, m.index + 4200);
}

test('the TUI’s agent call says it is the CLI', () => {
  const block = agentRunBlock(read('cli/ui/src/hooks/useAgentStream.js'));
  assert.match(
    block,
    /['"]x-hakster-client['"]\s*:\s*['"]cli['"]/,
    'useAgentStream.js must send x-hakster-client: cli on /api/agent/run (§28.5)',
  );
});

test('the shipped bundle carries the same header', () => {
  const block = agentRunBlock(read('cli/ui-fb.mjs'));
  assert.match(
    block,
    /["']x-hakster-client["']\s*:\s*["']cli["']/,
    'ui-fb.mjs is the file the installer ships — rebuild it after editing the hook (§28.1)',
  );
});

test('an entitlement 403 is reported as the server wrote it', () => {
  const block = agentRunBlock(read('cli/ui/src/hooks/useAgentStream.js'));
  const at = block.indexOf('res.status === 403');
  assert.ok(at !== -1, 'the run must handle a 403 refusal explicitly');
  const branch = block.slice(at, at + 600);
  assert.match(branch, /refusal\.error/, 'say the server’s reason');
  assert.match(branch, /refusal\.upgrade/, 'point at the upgrade path');
  assert.match(branch, /res\.json\(\)/, 'read the refusal body');
});

test('the gate is on the route, and the non-TUI CLI still identifies itself', () => {
  const server = read('server/src/index.js');
  const route = server.slice(
    server.indexOf("app.post('/api/agent/run'"),
    server.indexOf("app.post('/api/agent/run'") + 200,
  );
  assert.match(route, /requireCliEntitlement/, '/api/agent/run must keep the paid-plan gate');
  assert.match(read('cli/index.js'), /['"]x-hakster-client['"]\s*:\s*['"]cli['"]/);
});
