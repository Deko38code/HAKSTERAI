/* cli-splash.js — play the hacker-theme start screen before the TUI opens.
 *
 * Owner, 2026-11-26: "we need it nice tho matching our hacker theme". The Ink
 * fallback TUI's own splash is three lines of box drawing (and a frozen
 * `v0.1.0`), and it is a checked-in bundle with no source — so the start screen
 * is played here, in the CLI, and the bundle's own splash is switched off by
 * setting HAKSTER_NO_SPLASH before it is imported.
 *
 * Rules this file keeps:
 *  - it never blocks a start: no TTY, a pipe, a small window, NO_COLOR,
 *    HAKSTER_NO_SPLASH=1 or a thrown error each resolve immediately, so the CLI
 *    opens either way (§11, §50.1);
 *  - it never touches the user's scrollback: the frames are drawn on the
 *    alternate screen, which is restored on the way out (§2);
 *  - it is bounded: ~1.5 s and a hard cap, never a frame count that can stall;
 *  - it writes text only — no file, no process, no network, no /proc, so it
 *    behaves the same on Linux, macOS and Windows.
 *
 * Exports: splashEnabled, playSplash.
 */
'use strict';

const art = require('./splash-art');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HOME = '\x1b[H';
const CLEAR_DOWN = '\x1b[0J';

/** Should a start screen be drawn at all in this environment? */
function splashEnabled(env = process.env, out = process.stdout) {
  try {
    if (String(env.HAKSTER_NO_SPLASH || '') === '1' || String(env.NO_SPLASH || '') === '1') return false;
    if (String(env.HAKSTER_SPLASH || '').toLowerCase() === 'off') return false;
    if (!out || out.isTTY !== true) return false;
    // A piped/redirected stdin is not an interactive start; drawing here would
    // only fill somebody's log with escape codes.
    if (process.stdin && process.stdin.isTTY === false) return false;
    // Without colour the picture is one flat grey rectangle — worse than no
    // start screen at all, so a monochrome terminal opens straight into the TUI.
    if (art.colorDepth(env, out) === 'none') return false;
    const cols = Number(out.columns) || 0;
    const rows = Number(out.rows) || 0;
    // Below this the picture is a few coloured blocks with no brand in it — the
    // dashboard is a better use of a small window than a cropped photo.
    if (cols < 50 || rows < 14) return false;
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Play the start screen, then hand the terminal back exactly as it was.
 *
 * @param {object} o
 * @param {boolean} o.altScreen  enter the alternate screen ourselves (default
 *   true). Pass false when the caller is already on it — `hakster ui` enters
 *   it before booting Ink, and nesting two 1049 switches would fight.
 * @param {number} o.frames  frames to draw (default from splash-art)
 * @param {number} o.stepMs  delay between frames
 * @param {number} o.cols / o.rows  override the terminal size (tests)
 * @param {function} o.write  sink for the escape stream (tests)
 * @returns {Promise<{shown: boolean, reason?: string}>} never rejects
 */
async function playSplash(o = {}) {
  const out = o.out || process.stdout;
  const write = typeof o.write === 'function' ? o.write : (s) => out.write(s);
  if (o.force !== true && !splashEnabled(process.env, out)) return { shown: false, reason: 'disabled' };

  const cols = Math.max(20, Math.floor(o.cols || out.columns || 80));
  const rows = Math.max(6, Math.floor(o.rows || out.rows || 24));
  const frames = Math.max(1, Math.floor(o.frames || art.frameCount()));
  const stepMs = Math.max(16, Math.floor(o.stepMs || art.stepMs()));
  const altScreen = o.altScreen !== false;
  // On the alternate screen the terminal restores itself when we leave. On the
  // screen the caller owns (`hakster ui` entered it already) the finished frame
  // is cleared so Ink starts on a clean page instead of below a full-height
  // picture it cannot fit under.
  const clearOnDone = o.clearOnDone == null ? !altScreen : Boolean(o.clearOnDone);
  const startedAt = Date.now();
  const budgetMs = o.budgetMs == null ? 4000 : Number(o.budgetMs) || 0; // a hard stop: a slow terminal never stalls a start

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      if (altScreen) write(SHOW_CURSOR + ALT_OFF);
      else if (clearOnDone) write(HOME + CLEAR_DOWN + SHOW_CURSOR);
      else write(SHOW_CURSOR);
    } catch { /* the terminal is gone */ }
  };

  // Enter the screen and hide the cursor inside a guard: if the terminal is
  // already gone (a closed pipe, a detached console) restore() still runs, so a
  // failed start never leaves the cursor hidden or the alt screen active.
  try {
    if (altScreen) write(ALT_ON);
    write(HIDE_CURSOR);
  } catch {
    restore();
    return { shown: false, reason: 'write-failed' };
  }

  // Any keypress skips the rest of the reveal. Only safe where the caller has
  // already put stdin in raw mode (`hakster ui`); elsewhere leaving stdin alone
  // is what keeps the first keystroke for the TUI that follows.
  let skipped = false;
  let onKey = null;
  try {
    const stdin = process.stdin;
    if (o.skipOnKey !== false && stdin && stdin.isTTY && stdin.isRaw) {
      onKey = (buf) => { if (buf && buf.length) skipped = true; };
      stdin.on('data', onKey);
    }
  } catch { /* no stdin: the reveal just plays out */ }

  const onSignal = () => { restore(); process.exit(0); };
  let onSigint = null;
  try {
    onSigint = onSignal;
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigint);
  } catch { /* no signal support: the finally below still restores */ }

  try {
    let last = null;
    for (let f = 0; f < frames; f += 1) {
      if (Date.now() - startedAt > budgetMs) break;
      if (skipped) break;
      let frame;
      try {
        frame = art.splashRows({ cols, rows, frame: f });
      } catch {
        break; // an unreadable asset: open the CLI without a start screen
      }
      // The rain is the only thing that moves; a frame that came out identical
      // costs nothing to skip.
      const body = frame.join('\r\n');
      if (body !== last) {
        write(HOME + body + CLEAR_DOWN);
        last = body;
      }
      await sleep(stepMs);
    }
  } finally {
    try {
      if (onSigint) {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigint);
      }
      if (onKey) process.stdin.removeListener('data', onKey);
    } catch { /* ignore */ }
    restore();
  }
  return { shown: true };
}

module.exports = { splashEnabled, playSplash };
