/* The autonomy dial under the input bar, pinned at the source.
 *
 * Owner, 2026-11-25: "in the tui under input bar says composer can we move
 * that somewhere else without breaking and add the auto mode on off where
 * composer was like this cli and work with shift+tab to cycle". Three things
 * have to stay true or the feature is gone, and each one is easy to undo by
 * accident in an unrelated edit:
 *
 *   1. `autoMode` is a real preference key, so a mode chosen with the dial
 *      survives a restart (it used to be dropped by prefs.save()).
 *   2. The dial owns the status bar's leading slot and shift+tab cycles it,
 *      ahead of the plain-tab focus handler so the two cannot collide.
 *   3. The old `⟪ composer ⟫` tag moved to the composer's own hint row — it
 *      is not deleted, only relocated, which is what "without breaking" meant.
 *
 * The rendered behaviour (labels, order, the round trip back to the saved
 * mode) is asserted with real OpenTUI frames in ui/__smoke__/render.jsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', '..', ...p), 'utf8');
const require = createRequire(import.meta.url);

const app = read('ui', 'src', 'App.jsx');
const statusBar = read('ui', 'src', 'components', 'StatusBar.jsx');
const composer = read('ui', 'src', 'components', 'Composer.jsx');

test('autoMode is a stored preference, so the dial survives a restart', () => {
  const prefs = require('../../src/prefs.js');
  assert.ok(prefs.KEYS.includes('autoMode'), 'autoMode must be in DEFAULTS or save() drops it');
  assert.equal(prefs.DEFAULTS.autoMode, 'auto-edit');
  // The round trip through the real file, restored to whatever the operator
  // had set — a test must never leave a chosen mode changed behind it.
  const before = prefs.load().autoMode;
  try {
    assert.equal(prefs.save({ autoMode: 'full-auto' }).autoMode, 'full-auto');
    assert.equal(prefs.load().autoMode, 'full-auto', 'the mode must read back from disk, not just from the patch');
    assert.equal(prefs.save({ autoMode: 'suggest' }).autoMode, 'suggest');
  } finally {
    prefs.save({ autoMode: before });
  }
  assert.equal(prefs.load().autoMode, before);
});

test('shift+tab cycles the three modes in one order, ahead of plain tab', () => {
  assert.match(app, /const AUTO_ORDER = \['suggest', 'auto-edit', 'full-auto'\]/);
  assert.match(app, /const AUTO_MODES = new Set\(\['suggest', 'auto-edit', 'full-auto'\]\)/);
  const shiftAt = app.indexOf("key.name === 'tab' && (key.shift || key.sequence === '\\x1b[Z')");
  assert.ok(shiftAt > 0, 'the shift+tab branch is missing');
  const plainAt = app.indexOf("if (key.name === 'tab') {\n      cycleFocus();");
  assert.ok(plainAt > shiftAt, 'shift+tab must be handled before plain tab, or focus moves instead');
  // The dial must persist and explain itself, not silently change the mode.
  assert.match(app, /writePrefs\(\{ autoMode: next \}\)/);
  assert.match(app, /showNotice\(autoNotice\(next\)\)/);
});

test('the status bar shows the dial where the focus tag used to be', () => {
  assert.match(statusBar, /auto ask/);
  assert.match(statusBar, /auto edit/);
  assert.match(statusBar, /auto full/);
  assert.match(statusBar, /shift\+tab/);
  // The tag is a fallback for callers that pass no autoMode, never the normal
  // state, and the duplicate right-hand `auto` segment is gone.
  // Written with ⟪ escapes in this file, so the check matches the escape
  // as well as the glyph.
  const codeOnly = statusBar
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const tagUses = codeOnly.match(/(?:⟪|\\u27ea) composer (?:⟫|\\u27eb)/g) || [];
  assert.equal(tagUses.length, 1, 'the status bar must not draw the focus tag twice');
  // The slot itself draws the dial when there is one, not the tag.
  assert.match(codeOnly, /const leftText = dial/);
  assert.match(statusBar, /const leftText = dial\s*\n\s*\?/);
});

test('the focus tag moved onto the composer hint row, and cannot wrap it', () => {
  assert.match(composer, /focusTag = 'composer'/);
  assert.match(composer, /⟪\$\{focusTag\}⟫ /);
  // The hint keeps its single clipped row: the tag eats into the budget rather
  // than being appended after a full-width hint.
  assert.match(composer, /clipHint\(hint \|\| /);
  assert.match(composer, /inner - focusTag\.length - 4/);
  assert.match(app, /focusTag=\{focus === 'ad' \? 'ad' : 'composer'\}/);
});
