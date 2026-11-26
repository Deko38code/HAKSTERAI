/* splash-art / cli-splash — the hacker-theme start screen.
 *
 * Owner, 2026-11-26: "we need it nice tho matching our hacker theme", after the
 * Surface Pro opened with "input bar tui only" and no logo or matrix. These
 * tests pin the two things that broke there: colour was never detected on
 * Windows (so the picture would have been one flat colour), and there was no
 * start screen at all outside the OpenTUI dashboard.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const art = require('../splash-art');
const splash = require('../cli-splash');

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s) => String(s).replace(ANSI, '');

// A TTY-shaped sink; the splash refuses a non-TTY on purpose.
const tty = (over = {}) => ({ isTTY: true, columns: 100, rows: 30, ...over });

test('colorDepth understands Windows Terminal, which sets neither TERM nor COLORTERM', () => {
  assert.equal(art.colorDepth({ WT_SESSION: 'abc', TERM_PROGRAM: 'Windows_Terminal' }, tty()), 'truecolor');
  assert.equal(art.colorDepth({ TERM_PROGRAM: 'vscode' }, tty()), 'truecolor');
});

test('colorDepth honours the documented overrides', () => {
  assert.equal(art.colorDepth({ NO_COLOR: '1' }, tty()), 'none');
  assert.equal(art.colorDepth({ COLORTERM: 'truecolor' }, tty()), 'truecolor');
  assert.equal(art.colorDepth({ TERM: 'xterm-256color' }, tty()), 'ansi256');
  assert.equal(art.colorDepth({ TERM: 'dumb' }, tty()), 'none');
  assert.equal(art.colorDepth({ HAKSTER_COLOR: 'off' }, tty()), 'none');
  // A pipe must never receive escape codes.
  assert.equal(art.colorDepth({ COLORTERM: 'truecolor' }, { isTTY: false }), 'none');
});

test('the shipped artwork loads and is the real 120x90 grid', () => {
  const file = art.splashImageFile();
  assert.ok(file.endsWith('.art.json'), 'a shipped art grid is chosen');
  const grid = art.loadArt(file);
  assert.ok(grid, 'the grid parses');
  assert.equal(grid.width, art.ART_W);
  assert.equal(grid.height, art.ART_H);
  assert.equal(grid.px.length, art.ART_W * art.ART_H * 3);
});

test('a source checkout gets the hero, an install gets the backdrop', () => {
  const root = path.join(__dirname, '..', '..');
  assert.ok(art.splashImageFile({ root, checkout: true }).endsWith('haksterai-hero.art.json'));
  assert.ok(art.splashImageFile({ root, checkout: false }).endsWith('haksterai-backdrop.art.json'));
});

test('every row is exactly the terminal width and the count fits the screen', () => {
  const cols = 100;
  const rows = 30;
  const lines = art.splashRows({ cols, rows, frame: 3, depth: 'truecolor', imageFile: art.splashImageFile() });
  assert.ok(lines.length <= rows, `got ${lines.length} lines for ${rows} rows`);
  // Every row is padded to the full width — frames are drawn without a per-line
  // erase, so a short caption row would otherwise show the previous frame's
  // characters to its right.
  for (const l of lines) {
    assert.equal(visible(l).length, cols, 'each row is exactly the terminal width');
  }
});

test('a narrow terminal still produces a start screen (wordmark fallback)', () => {
  const lines = art.splashRows({ cols: 20, rows: 10, frame: 0, depth: 'truecolor', imageFile: art.splashImageFile() });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(visible(l).length <= 20);
});

test('the picture is drawn as half blocks and the rain glyphs appear', () => {
  const out = art.splashRows({ cols: 110, rows: 34, frame: 6, depth: 'truecolor', imageFile: art.splashImageFile() }).join('\n');
  assert.ok(out.includes('▀'), 'half-block cells carry two pixels');
  assert.ok(/[ｱ-ﾟ0-9]/.test(out), 'Matrix rain glyphs are present');
  assert.ok(/\x1b\[38;2;/.test(out), 'truecolor foreground sequences are emitted');
  assert.ok(/\x1b\[48;2;/.test(out), 'truecolor background sequences are emitted');
});

test('no colour means no escape codes at all', () => {
  const lines = art.splashRows({ cols: 80, rows: 20, frame: 0, depth: 'none', imageFile: art.splashImageFile() });
  const out = lines.join('\n');
  assert.equal(ANSI.test(out), false);
  for (const l of lines) assert.ok(l.length <= 80);
});

test('a frame is deterministic, so an unchanged frame can be skipped', () => {
  const a = art.splashRows({ cols: 90, rows: 24, frame: 2, depth: 'truecolor', imageFile: art.splashImageFile() });
  const b = art.splashRows({ cols: 90, rows: 24, frame: 2, depth: 'truecolor', imageFile: art.splashImageFile() });
  assert.deepEqual(a, b);
  const c = art.splashRows({ cols: 90, rows: 24, frame: 9, depth: 'truecolor', imageFile: art.splashImageFile() });
  assert.notDeepEqual(a, c, 'the rain actually moves');
});

test('a missing artwork never throws — it falls back to the wordmark', () => {
  const lines = art.splashRows({ cols: 80, rows: 20, frame: 1, depth: 'truecolor', imageFile: '/nope/missing.art.json' });
  assert.ok(lines.length > 0);
  const joined = visible(lines.join('\n'));
  assert.ok(joined.includes('█'), 'the block wordmark is drawn instead');
  assert.ok(/HAKSTER-AI|█/.test(joined));
});

test('the version comes from package.json, never a frozen literal', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(art.cliVersion(), pkg.version);
});

test('the splash is skipped where it cannot be drawn', () => {
  assert.equal(splash.splashEnabled({ HAKSTER_NO_SPLASH: '1' }, tty()), false);
  assert.equal(splash.splashEnabled({}, { isTTY: false }), false);
  assert.equal(splash.splashEnabled({ NO_COLOR: '1' }, tty()), false);
  assert.equal(splash.splashEnabled({}, tty({ columns: 40, rows: 30 })), false, 'too narrow');
  assert.equal(splash.splashEnabled({}, tty({ columns: 100, rows: 10 })), false, 'too short');
  assert.equal(splash.splashEnabled({ COLORTERM: 'truecolor' }, tty()), true);
});

test('playSplash draws on the alternate screen and hands the terminal back', async () => {
  const chunks = [];
  const res = await splash.playSplash({
    force: true, frames: 2, stepMs: 16, cols: 80, rows: 20,
    write: (s) => chunks.push(s), out: tty(),
  });
  assert.equal(res.shown, true);
  const out = chunks.join('');
  assert.ok(out.startsWith('\x1b[?1049h'), 'enters the alternate screen');
  assert.ok(out.includes('\x1b[?25l'), 'hides the cursor');
  assert.ok(out.includes('▀'), 'paints the picture');
  assert.ok(out.endsWith('\x1b[?25h\x1b[?1049l'), 'restores the cursor and the screen');
});

test('playSplash on a caller-owned screen clears instead of leaving the picture behind', async () => {
  const chunks = [];
  await splash.playSplash({
    force: true, frames: 1, stepMs: 16, cols: 80, rows: 20, altScreen: false,
    write: (s) => chunks.push(s), out: tty(),
  });
  const out = chunks.join('');
  assert.equal(out.includes('\x1b[?1049h'), false, 'no nested alternate screen');
  assert.ok(out.endsWith('\x1b[H\x1b[0J\x1b[?25h'), 'clears the page for the TUI');
});

test('a dead terminal at setup cannot leave the cursor hidden or the alt screen on', async () => {
  // A closed pipe / detached console throws on the very first write. The setup
  // writes sit inside a guard for exactly this: the CLI opens either way, and
  // restore() gets its chance to put the terminal back.
  let restoredWrites = 0;
  const res = await splash.playSplash({
    force: true, frames: 1, stepMs: 16, cols: 80, rows: 20, out: tty(),
    write: () => { restoredWrites += 1; throw new Error('EPIPE'); },
  });
  assert.equal(res.shown, false);
  assert.equal(res.reason, 'write-failed');
  assert.ok(restoredWrites >= 1, 'the restore path was attempted');
});

test('playSplash is bounded and never throws, even with a broken asset', async () => {
  const chunks = [];
  const res = await splash.playSplash({
    force: true, frames: 40, stepMs: 50, budgetMs: 0, cols: 80, rows: 20,
    write: (s) => chunks.push(s), out: tty(), imageFile: '/nope/missing.art.json',
  });
  assert.equal(res.shown, true);
  assert.ok(chunks.join('').endsWith('\x1b[?25h\x1b[?1049l'), 'the terminal is restored even after the budget expires');
});
