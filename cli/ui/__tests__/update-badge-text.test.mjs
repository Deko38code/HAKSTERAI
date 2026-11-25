/* The installed-update row says exactly what the owner asked for.
 *
 * Owner, 2026-11-25: "i want our update to say this when its done in cli —
 * ✔ Update installed · Restart to update".
 *
 * Pinned here so a later edit cannot reword it, split it, or turn the check
 * into a colour-emoji variant (`️`) that the terminal draws double width:
 *   1. the exact string is in the source and in the built bundle;
 *   2. U+2714 carries no variation selector;
 *   3. the narrower forms keep the same instruction ("Restart to update"),
 *      and the "installs on restart" wording stays with the *staged* state,
 *      which is a different fact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(cliRoot, 'ui/src/App.jsx'), 'utf8');

const INSTALLED = '✔ Update installed · Restart to update';

test('the installed-update wording is the owner\'s, verbatim', () => {
  // Once as the top-line badge, once as the transcript line for the same state.
  assert.ok(app.includes(`showNotice('${INSTALLED}');`), 'the transcript line says it');
  assert.ok(app.includes(`'${INSTALLED}',`), 'the badge says it');
  const codeOnly = app.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(codeOnly.split(INSTALLED).length - 1, 2, 'and nowhere else in code');
});

test('the check is a mono glyph, not a colour emoji', () => {
  assert.ok(!app.includes('✔️'), 'no variation selector after U+2714');
  assert.ok(!app.includes('✅'), 'never the emoji check mark');
  const idx = app.indexOf(INSTALLED);
  assert.equal(app.codePointAt(idx), 0x2714, 'U+2714 heavy check mark');
});

test('narrow forms keep the instruction, and staged wording stays staged', () => {
  assert.ok(app.includes("'✔ Restart to update'"), 'the short form still says what to do');
  assert.ok(app.includes("'✔ restart'"), 'the shortest form too');
  // "installs on restart" belongs to a staged package, never to an installed one.
  const installedBlock = app.slice(app.indexOf('updateInstalled'), app.indexOf('const updateBadgeVariants'));
  assert.ok(!installedBlock.includes('installs on restart'));
  assert.ok(app.includes('installs on restart'), 'the staged state keeps its own wording');
});

test('the shipped bundle carries the new wording', () => {
  const bundlePath = path.join(cliRoot, 'ui-fb.mjs');
  assert.ok(fs.existsSync(bundlePath), 'ui-fb.mjs is missing — run `npm run build:ui`');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  // esbuild may leave the glyphs literal or escape them (✔, \xB7), so
  // accept either encoding of the same string.
  const present = bundle.includes(INSTALLED)
    || bundle.includes('\\u2714 Update installed \\xB7 Restart to update')
    || bundle.includes('\\u2714 Update installed \\u00b7 Restart to update');
  assert.ok(present, 'rebuild with `npm run build:ui` after changing the wording');
});
