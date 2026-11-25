/* The mark is on every card that opens, and the danger window opens from /menu.
 *
 * Owner, 2026-11-26: "make sure dangerous command window opens with our /menu
 * and password and our logo always on any terminal card that opens or popout".
 *
 * Two facts are pinned here, because both are the kind that silently regress:
 *
 *   1. Every surface that OPENS — the /menu gate windows, the popouts and the
 *      six full-screen pages — draws the brand mark. A new page that forgets it
 *      fails this test instead of quietly shipping unbranded.
 *   2. `/danger` with no argument (which is exactly what the /menu's "Approval
 *      password" row runs) opens the masked window, rather than only printing a
 *      notice. That is the "opens with our /menu" half of the request.
 *
 * The built bundle is checked too: `ui-fb.mjs` is what actually runs, so a
 * source change that was never rebuilt must not pass as shipped (§43).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

/* Every surface the CLI can put in front of the operator as its own card. */
const OPENED_SURFACES = [
  ['components/ApprovalPrompt.jsx', 'the dangerous-command / sudo gate'],
  ['components/DangerPasswordPrompt.jsx', 'the approval-password window'],
  ['components/CatalogPopout.jsx', 'the /menu popout'],
  ['components/MenuPalette.jsx', 'the menu palette'],
  ['components/McpView.jsx', '/mcp'],
  ['components/SettingsView.jsx', '/settings'],
  ['components/ScriptsView.jsx', '/scripts'],
  ['components/SquadView.jsx', '/squad'],
  ['components/UsageView.jsx', '/usage'],
  ['components/DebugView.jsx', '/debug'],
];

test('every card that opens carries the brand mark', () => {
  for (const [file, what] of OPENED_SURFACES) {
    const src = read('src', file);
    assert.match(
      src,
      /from '\.\/HeroLogo\.jsx'|from '\.\/components\/HeroLogo\.jsx'/,
      `${what} (${file}) does not import the mark from HeroLogo.jsx`,
    );
    assert.match(
      src,
      /<(HeroLogo|BrandLine)\b/,
      `${what} (${file}) imports the mark but never draws it`,
    );
  }
});

test('the one-row brand line exists and shares the wordmark', () => {
  const hero = read('src', 'components', 'HeroLogo.jsx');
  assert.match(hero, /export function BrandLine\(/, 'BrandLine is not exported');
  // One source of truth: the line must read the same name the block letters
  // spell, so the two can never drift into different brands.
  assert.match(hero, /◆ \$\{HERO_NAME\}/, 'BrandLine does not draw HERO_NAME');
  assert.match(hero, /export const HERO_NAME = 'HAKSTER-AI'/, 'HERO_NAME changed');
});

test('/danger with no argument opens the masked window (what /menu runs)', () => {
  const app = read('src', 'App.jsx');
  // The window itself must be mounted, or "opens" is a lie.
  assert.match(app, /<DangerPasswordPrompt\b/, 'the approval-password window is not rendered');
  // Bare `/danger` (and `set` / `open`) must reach setDangerSetup, not a notice.
  const branch = app.slice(app.indexOf("case '/danger'"), app.indexOf("case '/clear'"));
  assert.match(
    branch,
    /if \(verb === 'set' \|\| verb === 'open' \|\| verb === ''\) \{ setDangerSetup\(true\); return; \}/,
    'bare /danger no longer opens the window — the /menu row would only print a notice',
  );
  assert.match(branch, /dangerPasswordState\(\)/, 'the status report is gone');
  assert.match(branch, /clearDangerPassword\(\)/, '/danger clear is gone');
});

test('/menu still lists the approval-password command the row runs', () => {
  const menu = read('src', 'components', 'MenuPalette.jsx');
  assert.match(menu, /cmd: '\/danger'/, "the /menu no longer offers /danger");
});

test('the shipped bundle was rebuilt from this source', () => {
  const bundle = fs.readFileSync(path.join(here, '..', '..', 'ui-fb.mjs'), 'utf8');
  assert.ok(bundle.includes('BrandLine'), 'ui-fb.mjs has no BrandLine — run npm run build:ui');
  assert.ok(
    bundle.includes("'open'") || bundle.includes('"open"'),
    'ui-fb.mjs predates the /danger open verb — run npm run build:ui',
  );
});
