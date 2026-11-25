/* guard-colour — the file-guard count is green only when nothing is missing.

   Owner, 2026-11-26: "make it show green when thwy are all present 13/13 red
   when missing". The count used to render gray whenever the files were all
   there, so a healthy 13/13 was indistinguishable from a reading the panel
   could not take — and the agent's own FILE INTEGRITY bar stayed green at
   12/13 (`pct >= 90`). Both are pinned here, by reading the sources that
   render them, so a later edit cannot quietly put gray (or a 90 % bar) back.
*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const REPO = path.resolve(CLI_DIR, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SITES = [
  'cli/ui/src/components/StatusServicesPanel.jsx',
  'cli/ui/src/App.jsx',
];

test('every surface that draws the guard count colours it green/red, never gray', () => {
  for (const rel of SITES) {
    const src = read(rel);
    const lines = src.split('\n').filter((l) => /guardTxt|guard\.missing|guardBad/.test(l) && /fg=|color:/.test(l));
    assert.ok(lines.length > 0, `${rel} no longer draws the guard count — update this test`);
    for (const line of lines) {
      assert.ok(
        /'red'\s*:\s*'green'/.test(line),
        `${rel} draws the guard count without green/red: ${line.trim()}`,
      );
    }
  }
});

test('the chat status line and the header agree on the exact wording', () => {
  const panel = read('cli/ui/src/components/StatusServicesPanel.jsx');
  const app = read('cli/ui/src/App.jsx');
  assert.ok(panel.includes("fg={guardBad ? 'red' : 'green'}"), 'status line must be red only when a file is missing');
  assert.ok(app.includes("fg={guard.missing && guard.missing.length ? 'red' : 'green'}"), 'header must be red only when a file is missing');
});

test('the agent FILE INTEGRITY bar is green only at 13/13', () => {
  const src = read('server/src/agent/index.js');
  assert.ok(
    src.includes('const c = _fi.pct === 100 ? C.success : C.error;'),
    'the integrity bar must be red the moment one important file is missing',
  );
  assert.ok(
    !/const c = _fi\.pct >= 90/.test(src),
    'the old >= 90 % bar painted 12/13 green',
  );
});

test('the shipped bundle carries the green/red reading', () => {
  const bundle = read('cli/ui-fb.mjs');
  assert.ok(bundle.includes('guardBad ? "red" : "green"'), 'ui-fb.mjs is stale — run npm run build:ui');
  assert.ok(bundle.includes('missing.length ? "red" : "green"'), 'ui-fb.mjs is stale — run npm run build:ui');
});
