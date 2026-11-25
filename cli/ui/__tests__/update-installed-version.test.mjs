/* An installed update states its version, in the same top-right slot an
 * available update would use.
 *
 * Owner, 2026-11-26: "we need it to say the version up top when its installed
 * where update avalible would be." Before this the header said
 * "✔ Update installed · Restart to update" with no version, while the available
 * path said "⬆ update v0.3.69 · …" — so once a build had landed the header
 * stopped naming it.
 *
 * Pinned here:
 *   1. the richest installed form carries the version, built from updateVer —
 *      the same suffix the available-update badge uses;
 *   2. the §43.2 wording stays in the ladder (byte-for-byte) as a narrower form,
 *      so a small header still says what happened;
 *   3. the transcript notice names the version too;
 *   4. the shipped bundle carries the versioned form, not only the old one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, '..', 'src', 'App.jsx'), 'utf8');
const BUNDLE = path.join(here, '..', '..', 'ui-fb.mjs');

test('the installed badge states the version, in the available-update slot', () => {
  assert.match(APP, /`✔ update\$\{updateVer\} installed · Restart to update`/,
    'the widest installed form names the version, like "⬆ update vX · …" does');
  // It is the first rung of the ladder, so it is what a normal-width header shows.
  const ladder = APP.slice(APP.indexOf('const updateBadgeVariants'));
  const firstRung = ladder.indexOf('`✔ update${updateVer} installed');
  const pinned = ladder.indexOf("'✔ Update installed · Restart to update'");
  assert.ok(firstRung > -1 && firstRung < pinned, 'the versioned form is shown before the version-less one');
});

test('the §43.2 wording survives as a narrower form', () => {
  assert.ok(APP.includes("'✔ Update installed · Restart to update'"),
    'the wording the owner asked for on 2026-11-25 is kept byte-for-byte');
  assert.ok(APP.includes("'✔ installed · Restart to update'"));
  assert.ok(APP.includes("'✔ Restart to update'"));
});

test('the transcript notice names the version as well', () => {
  assert.match(APP, /showNotice\(`✔ Update v\$\{update\.version\} installed · Restart to update`\)/,
    'a landed build is named in the transcript, not only in the header');
});

test('the shipped bundle carries the versioned installed form', () => {
  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(bundle.includes('\\u2714 update') || bundle.includes('✔ update'),
    'ui-fb.mjs was rebuilt after the wording change (npm run build:ui)');
  assert.ok(bundle.includes(' Update installed \\xB7 Restart to update')
    || bundle.includes(' Update installed \\u00b7 Restart to update')
    || bundle.includes(' Update installed · Restart to update'),
    'the §43.2 form is still in the shipped bundle');
});
