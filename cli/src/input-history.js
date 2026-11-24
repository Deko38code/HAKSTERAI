/* Input history — the ↑/↓ recall in the composer.
 *
 * One file, shared with the server's own agent loop: ~/.hakster/history, one
 * typed line per entry. That format predates this module and stays plain text:
 * nothing here changes the shape of the file, it only refuses to store junk.
 *
 * Two rules matter more than the recall itself.
 *
 * 1. Terminal responses are not history. Escape sequences, OSC colour replies
 *    (`…rgb:…`, `…VTE(…)`) and captured box-drawing UI were landing in the file
 *    — the TUI writing the screen into the same stream — and came back as
 *    garbage "previous commands". They are filtered on read *and* on write, so
 *    an already-polluted file reads clean without being rewritten first.
 *
 * 2. A secret is never stored (§9, §23, §31). A line that looks like a key,
 *    token, or `NAME=value` credential is dropped before it can reach the file,
 *    so recall can never echo a secret back to the screen or into a later turn.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_KEEP = 500;   // on disk, same cap the server's saveToHistory uses
const MAX_RECALL = 200; // lines loaded into the composer at start

function historyPath() {
  return path.join(process.env.HAKSTER_HOME || path.join(os.homedir(), '.hakster'), 'history');
}

/* Control characters, OSC/DCS colour replies, and the box-drawing runes a
 * captured panel leaves behind. Any one of these means the line is screen
 * output that leaked into stdin, not something the operator typed. */
const TERMINAL_JUNK = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\x1b|rgb:|VTE\(|[─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋]|;\d+\$y|\[\?/;
/* Box-drawing on its own (the `│ Servers: 18/20 … │` rows) even when the line
 * has no control bytes at all. */
const BOX_ONLY = /^[\s│┃|]+|[\s│┃|]+$/;

/* Text that reached the file from somewhere other than the composer: a
 * pasted issue report, or a library warning that got captured with the turn.
 * These came in when the file was seeded from saved transcripts, and a report
 * can be pasted again at any time, so they are refused on write as well. */
const NON_TYPED = [
  /^Captured:\s*\d{4}-\d{2}-\d{2}T/,          // issue-report header block
  /^Page:\s*https?:\/\//,                     //
  /^Browser:\s*Mozilla\//,                    //
  /^Total issues this session:/i,               //
  /^Recent messages:?$/i,                       //
  /^\d+\.\s*\[\d{1,2}:\d{2}:\d{2}\s*[AP]M\]/,  // "1. [2:20 PM] notice: …"
  /^⚠️?\s/,                                   // library notice captured mid-turn
];

/* Credential shapes. Deliberately broad on the prefix forms and narrow on the
 * `NAME=value` form so ordinary sentences ("fix the token handler") survive. */
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{12,}/,          // OpenAI-style
  /\bsk_(live|test)_[A-Za-z0-9]{10,}/, // Stripe secret
  /\bpk_(live|test)_[A-Za-z0-9]{10,}/, // Stripe publishable
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,      // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,              // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,    // Slack
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|secret|token|passwd|password|pass|client[_-]?secret)\s*[:=]\s*\S{8,}/i,
  /\b[A-Fa-f0-9]{40,}\b/,              // long hex blobs (digests / keys)
];

function looksSecret(line) {
  return SECRET_SHAPES.some((re) => re.test(line));
}

/* A kept line is trimmed, non-empty, free of terminal leakage, not a bare
 * box row, not a credential, and long enough to be worth recalling. */
function isKept(raw) {
  if (typeof raw !== 'string') return false;
  const line = raw.replace(/\r/g, '').trim();
  if (line.length < 3) return false;
  if (TERMINAL_JUNK.test(line)) return false;
  if (BOX_ONLY.test(line) && !/[A-Za-z]/.test(line.replace(/[│┃|]/g, ''))) return false;
  if (looksSecret(line)) return false;
  if (NON_TYPED.some((re) => re.test(line))) return false;
  // Agent-internal scaffolding that some transcripts seed a session with.
  if (/^Tool execution results:/i.test(line)) return false;
  if (/^Session resumed from disk\./i.test(line)) return false;
  if (/^Continue based on these results\.?$/i.test(line)) return false;
  // Truncation markers a saved transcript leaves where it cut a long message.
  if (/^\[(trimmed|truncated|\.\.\.|…)\]$/i.test(line)) return false;
  return true;
}

/* Clean a raw array of lines: keep the good ones, drop an entry that repeats
 * the one directly before it, and cap the tail. */
/* A transcript seed saves the same message once per truncation length, so the
 * file ends up with a short prefix of an entry that already exists further
 * back. Those are one entry: keep the longest copy, at the newest position.
 * The length floor and overlap ratio keep two genuinely different commands
 * that merely share an opening (`git status` / `git status -s`) apart. */
function isTruncationOf(a, b) {
  if (a.length < 40 || b.length < 40) return false;
  const long = a.length >= b.length ? a : b;
  const short = a.length >= b.length ? b : a;
  if (!long.startsWith(short)) return false;
  return short.length >= long.length * 0.35;
}

const NOTICE_HEAD = /^⚠️?\s/;

function sanitizeLines(lines) {
  const out = [];
  // A library notice captured mid-turn wraps over the next few lines, and the
  // continuation lines carry no marker of their own ("it as the 1M maximum…",
  // "200000, or unset it."). They are absorbed with the head, up to the first
  // line that ends a sentence, so they never come back as recallable entries.
  let noticeTail = 0;
  for (const raw of lines || []) {
    if (typeof raw !== 'string') continue;
    const line = raw.replace(/\r/g, '').trim();
    if (noticeTail > 0) {
      noticeTail -= 1;
      if (/[.!?]$/.test(line)) noticeTail = 0;
      continue;
    }
    if (NOTICE_HEAD.test(line)) { noticeTail = 4; continue; }
    if (!isKept(line)) continue;
    if (out.length && out[out.length - 1] === line) continue;
    const prior = out.findIndex((h) => isTruncationOf(h, line));
    if (prior !== -1) {
      if (out[prior].length < line.length) {
        out.splice(prior, 1);
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.slice(-MAX_KEEP);
}

function loadInputHistory(limit = MAX_RECALL) {
  try {
    const lines = fs.readFileSync(historyPath(), 'utf8').split('\n');
    return sanitizeLines(lines).slice(-Math.max(0, limit));
  } catch {
    return [];
  }
}

/* Append one typed line. Dedupe keeps the newest position for a repeat (so ↑
 * finds a command you use often right away) and the cap never grows the file.
 * A test harness sets HAKSTER_NO_HISTORY=1 so its scripted prompts never land
 * in the operator's real history. */
function appendInputHistory(line, limit = MAX_KEEP) {
  if (process.env.HAKSTER_NO_HISTORY === '1') return false;
  if (!isKept(line)) return false;
  const value = String(line).replace(/\r/g, '').trim();
  try {
    const file = historyPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = sanitizeLines(
      fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [],
    );
    const next = existing.filter((h) => h !== value);
    next.push(value);
    fs.writeFileSync(file, next.slice(-limit).join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  historyPath,
  isKept,
  looksSecret,
  sanitizeLines,
  loadInputHistory,
  appendInputHistory,
};
