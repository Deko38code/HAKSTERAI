'use strict';
/* one-tui.test.js — one TUI, two names.
 *
 * Owner, 2026-11-26: "rplace old with new tui".
 *
 * `hakster ui` used to open the older Ink/React renderer (cli/ui.mjs) while
 * bare `hakster` and `hakster tui` opened the dashboard (cli/ui-fb.mjs). Two
 * screens meant two things to keep in sync on every change, and the one a
 * person reached depended on which word they remembered.
 *
 * What is pinned here:
 *   1. the `ui` command dispatches to the dashboard — it re-enters `tui`, and
 *      it does not import the Ink bundle itself;
 *   2. the Ink bundle stays in the tree as the dashboard's *fallback*, so a
 *      machine that cannot load the native renderer still gets a screen
 *      (§43, §49.1 — a fallback is never deleted to tidy a diff);
 *   3. both commands say they are the same screen, so help output cannot
 *      promise a second renderer again.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI_DIR = path.join(__dirname, '..', '..');
const INDEX = fs.readFileSync(path.join(CLI_DIR, 'index.js'), 'utf8');

/** The source of one commander command block, from `.command('x')` to its `});`. */
function commandBlock(name) {
  const start = INDEX.indexOf(`  .command('${name}')`);
  assert.notStrictEqual(start, -1, `command '${name}' is missing from index.js`);
  const end = INDEX.indexOf('\n  });', start);
  assert.notStrictEqual(end, -1, `command '${name}' has no closing block`);
  return INDEX.slice(start, end);
}

test('hakster ui opens the dashboard, not the Ink renderer', () => {
  const ui = commandBlock('ui');
  assert.match(
    ui,
    /spawnSync\(process\.execPath, \[__filename, 'tui'\]/,
    'the ui command must re-enter the dashboard lane (`tui`)',
  );
  assert.doesNotMatch(
    ui,
    /import\('\.\/ui\.mjs'\)/,
    'the ui command must not import the Ink bundle directly',
  );
  assert.match(ui, /stdio: 'inherit'/, 'the dashboard needs the real terminal, so stdio is inherited');
});

test('the dashboard lane still owns the renderer choice', () => {
  const tui = commandBlock('tui');
  assert.match(tui, /ui-fb\.mjs/, 'the tui command must load the dashboard bundle');
  assert.match(
    tui,
    /fallbackInk|openInk/,
    'the dashboard must keep its Ink fallback for a machine without a usable renderer',
  );
});

test('the Ink bundle survives as the fallback, never as a command of its own', () => {
  assert.ok(fs.existsSync(path.join(CLI_DIR, 'ui.mjs')), 'cli/ui.mjs is the fallback and must stay');
  const ui = commandBlock('ui');
  assert.doesNotMatch(ui, /mod\.start\(\)/, 'the ui command must not start the Ink module itself');
});

test('help says both names are the same screen', () => {
  const ui = commandBlock('ui');
  assert.match(ui, /dashboard/i, 'the ui description must name the dashboard it opens');
  assert.match(ui, /hakster tui/, 'the ui description must say it is the tui screen');
});
