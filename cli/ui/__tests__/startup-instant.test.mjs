/* The start card is never cut short by a command that exits at once (§10, §50.1).
 *
 * Owner, 2026-11-26: "fix" — `hakster --version` printed one card line and then
 * the version, on the animated path (a TTY with NO_COLOR unset). Measured
 * before: 2 lines. Measured after: 24 (the whole card, then the version).
 *
 * Cause: the reveal draws one line per 22 ms timer, and `--version` / `--help`
 * answer and exit inside the same synchronous load, so every pending tick was
 * killed. Note the trap that hid it on the first reading: with NO_COLOR set the
 * card takes the plain synchronous branch and looks fine.
 *
 * Pinned here:
 *   1. `instant: true` draws every line in one write, with no timer pending;
 *   2. the animated path still reveals, and if the process exits mid-reveal the
 *      remaining lines are flushed exactly once — never dropped, never doubled;
 *   3. `cli/index.js` asks for the instant card on `--version` / `--help` (and
 *      only those flags), which is what makes the real command whole;
 *   4. end to end through a real PTY, `--version` renders the full card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.join(here, '..', '..');
const INDEX = path.join(CLI_DIR, 'index.js');

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Call showIntro with stdout pretending to be a colour terminal, capturing
 *  every write. Restores the real stdout and the env afterwards. */
function capture(fn, { tty = true } = {}) {
  const logo = require(path.join(CLI_DIR, 'logo.js'));
  const expected = logo.renderStartup({ version: '9.9.9' }).length;
  const out = [];
  const realWrite = process.stdout.write;
  const hadNoColor = Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR');
  const savedNoColor = process.env.NO_COLOR;
  const savedNoAnim = process.env.HAKSTER_NO_ANIM;
  const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  delete process.env.NO_COLOR;
  delete process.env.HAKSTER_NO_ANIM;
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  // A reveal still in flight when a test ends would keep writing into the NEXT
  // test's capture. Record the handles and clear them on the way out.
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (cb, ms, ...rest) => {
    const id = realSetTimeout(cb, ms, ...rest);
    timers.push(id);
    return id;
  };

  try {
    fn(logo, out, expected);
    return { out, expected, logo };
  } finally {
    global.setTimeout = realSetTimeout;
    for (const id of timers) clearTimeout(id);
    process.stdout.write = realWrite;
    if (ttyDesc) Object.defineProperty(process.stdout, 'isTTY', ttyDesc);
    else delete process.stdout.isTTY;
    if (hadNoColor) process.env.NO_COLOR = savedNoColor; else delete process.env.NO_COLOR;
    if (savedNoAnim === undefined) delete process.env.HAKSTER_NO_ANIM;
    else process.env.HAKSTER_NO_ANIM = savedNoAnim;
  }
}

const lineCount = (chunks) => chunks.join('').split('\n').filter((l) => l.length).length;

/* ── 1. instant: one write, nothing pending ──────────────────────────── */

test('instant draws the whole card synchronously, with no timer left pending', () => {
  const { out, expected } = capture((logo) => logo.showIntro('9.9.9', { instant: true }));
  assert.equal(out.length, 1, 'instant must be a single write, not a timer chain');
  assert.equal(lineCount(out), expected, 'every card line is present');
  assert.match(out[0], /\x1b\[/, 'colour is kept — instant is not the plain/pipe branch');
});

/* ── 2. animated reveal, and the exit flush ──────────────────────────── */

test('animated reveal draws one line first, and an exit mid-reveal flushes the rest once', () => {
  let startedWith = 0;
  const { out, expected } = capture((logo, written, cardLines) => {
    logo.showIntro('9.9.9');
    startedWith = written.length;
    assert.equal(startedWith, 1, 'the reveal starts with a single line');
    assert.ok(startedWith < cardLines, 'and is not finished yet');

    // What process.exit does to a listener, without leaving this process.
    process.emit('exit', 0);
  });

  assert.equal(lineCount(out), expected, 'nothing is lost when the process exits mid-reveal');
  assert.equal(out.filter((c) => c.includes('CHECKLIST')).length, 1, 'the card is not printed twice');
});

test('a completed reveal is never re-printed by the exit flush', () => {
  const { out, expected } = capture((logo) => {
    logo.showIntro('9.9.9', { instant: true });
    process.emit('exit', 0);
  });
  assert.equal(lineCount(out), expected, 'exit after a full card adds nothing');
});

test('a pipe or NO_COLOR still takes the plain, synchronous branch', () => {
  const piped = capture((logo) => logo.showIntro('9.9.9'), { tty: false });
  assert.equal(piped.out.length, 1, 'non-TTY is one write');
  assert.equal(lineCount(piped.out), piped.expected);
  assert.doesNotMatch(piped.out[0], /\x1b\[/, 'no ANSI in a pipe');
});

/* ── 3. the call site asks for it on --version / --help ──────────────── */

test('index.js requests the instant card for --version and --help only', () => {
  const src = fs.readFileSync(INDEX, 'utf8');

  assert.match(
    src,
    /showIntro\(pkg\.version,\s*\{\s*instant:\s*_helpOrVersion\s*\}\)/,
    'the launch must pass instant for the flags that exit at once',
  );
  assert.match(
    src,
    /_helpOrVersion\s*=[^\n]*--help[^\n]*-h[^\n]*--version[^\n]*-V/,
    '_helpOrVersion must cover --help, -h, --version and -V',
  );
  // A normal launch still animates: the reveal is only bypassed above, and the
  // pipe/NO_COLOR branch in logo.js still strips colour.
  const logo = fs.readFileSync(path.join(CLI_DIR, 'logo.js'), 'utf8');
  assert.match(logo, /if \(!isTTY\) \{/, 'the plain branch is untouched');
  assert.match(logo, /replace\(ANSI_RE, ''\)/, 'a pipe still gets no ANSI');
});

/* ── 4. end to end through a real PTY ────────────────────────────────── */

function hasScript() {
  try { execSync('command -v script', { stdio: 'ignore' }); return true; } catch { return false; }
}

test('through a real PTY, --version renders the whole card then the version', { skip: !hasScript() && 'no `script` binary for a PTY' }, () => {
  const logo = require(path.join(CLI_DIR, 'logo.js'));
  const cardLines = logo.renderStartup({ version: '9.9.9' }).length;
  const pkg = require(path.join(CLI_DIR, 'package.json'));

  const out = execFileSync(
    'script',
    ['-qec', `env -u NO_COLOR -u HAKSTER_NO_ANIM ${process.execPath} ${INDEX} --version`, '/dev/null'],
    { encoding: 'utf8', cwd: CLI_DIR, timeout: 30000 },
  );

  const lines = out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length);
  assert.equal(lines.length, cardLines + 1, `expected ${cardLines} card lines + the version, got ${lines.length}`);
  assert.ok(lines.some((l) => l.includes('CHECKLIST')), 'the checklist band is on screen');
  assert.equal(lines[lines.length - 1].trim(), pkg.version, 'the version is the last line, after the card');
});
