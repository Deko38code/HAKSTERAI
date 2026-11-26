// haksterAi startup splash — big block ASCII art + truecolor gradient
// Zero external deps (no figlet/gradient-string/boxen needed).
// Exports: showIntro(version, opts), renderBanner(), renderStartup(opts),
//          renderCard(info), frameBox(), gradientText, introShown(), C, Splash
//
// Owner, 2026-11-26: "ADD WRAPPER AROUND THE NAMES AND SIGNED IN ENTERPRISE
// ETC" — the name, the tagline and the signed-in plan now sit inside one
// bordered brand card. The block art itself is unchanged.

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[38;5;46m',
  greenDim: '\x1b[38;5;28m',
  cyan: '\x1b[38;5;51m',
  white: '\x1b[97m',
  gray: '\x1b[38;5;240m',
  red: '\x1b[38;5;196m',
  yellow: '\x1b[38;5;226m',
  magenta: '\x1b[38;5;201m',
};

// ── truecolor helpers ────────────────────────────────────────────────────────
const TRUECOLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  const ct = process.env.COLORTERM || '';
  return /truecolor|24bit/i.test(ct) || /-256color$/.test(process.env.TERM || '');
})();

const rgb = (r, g, b) => (TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : C.cyan);

function lerp(a, b, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// brand gradient: acid green -> electric cyan -> hot magenta
const STOPS = [
  [0.0, [34, 255, 136]],
  [0.5, [0, 229, 255]],
  [1.0, [255, 61, 240]],
];

function sample(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (t >= t0 && t <= t1) return lerp(c0, c1, (t - t0) / (t1 - t0 || 1));
  }
  return STOPS[STOPS.length - 1][1];
}

// ── 5-row block font ────────────────────────────────────────────────────────
const GLYPHS = {
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

function blockText(str) {
  const rows = ['', '', '', '', ''];
  for (const ch of str.toUpperCase()) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 5; r++) rows[r] += (rows[r] ? ' ' : '') + g[r];
  }
  return rows;
}

// paint a block of text rows with a diagonal brand gradient
function paint(rows) {
  const out = [];
  const width = Math.max(...rows.map((r) => r.length), 1);
  rows.forEach((row, ri) => {
    let line = '';
    const base = ri / Math.max(rows.length - 1, 1);
    for (let ci = 0; ci < row.length; ci++) {
      const ch = row[ci];
      if (ch === ' ') { line += ' '; continue; }
      const t = base * 0.82 + (ci / width) * 0.28;
      const [r, g, b] = sample(t);
      line += rgb(r, g, b) + ch;
    }
    out.push(line + C.reset);
  });
  return out;
}

// horizontal gradient for a single line of text
function gradientText(text, from = 0.15, to = 0.95) {
  let line = '';
  const n = Math.max(text.length - 1, 1);
  for (let i = 0; i < text.length; i++) {
    const t = from + (to - from) * (i / n);
    const [r, g, b] = sample(t);
    line += rgb(r, g, b) + text[i];
  }
  return line + C.reset;
}

function renderBanner() {
  const art = paint(blockText('HAKSTER AI'));
  return art;
}

// ── bordered brand card ─────────────────────────────────────────────────────
// One frame around the whole start block. Every width calculation strips ANSI
// first, so the right border lands in the same column on every row.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visLen = (s) => String(s).replace(ANSI_RE, '').length;
const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', ml: '├', mr: '┤', h: '─', v: '│' };

/** Frame one or more groups of already-coloured lines. A group after the
 *  first is separated by a ├───┤ rule, so the brand, the account and the
 *  session each read as their own band inside a single card. */
function frameBox(groups, opts = {}) {
  const pad = opts.pad == null ? 2 : opts.pad;
  const border = opts.border || C.greenDim;
  const rows = groups.filter((g) => Array.isArray(g) && g.length);
  if (!rows.length) return [];
  const width = Math.max(opts.minWidth || 0, Math.max(...rows.flat().map(visLen), 1) + pad * 2);
  const rule = (l, r) => border + l + BOX.h.repeat(width) + r + C.reset;
  const out = [rule(BOX.tl, BOX.tr)];
  rows.forEach((group, gi) => {
    if (gi > 0) out.push(rule(BOX.ml, BOX.mr));
    for (const line of group) {
      const fill = Math.max(0, width - pad * 2 - visLen(line));
      out.push(border + BOX.v + C.reset + ' '.repeat(pad) + line + ' '.repeat(fill + pad) + border + BOX.v + C.reset);
    }
  });
  out.push(rule(BOX.bl, BOX.br));
  return out;
}

// ── account line ────────────────────────────────────────────────────────────
// The plan and the account name come from the same `hakster init` sign-in the
// magic-link approval page confirms, so the CLI states exactly who is signed in
// and on what plan (owner, 2026-11-26: "says name when magic links approve — I
// love that for logging users, paid plans").
function readPlanSync() {
  try {
    const f = require('path').join(require('os').homedir(), '.hakster', 'license.json');
    const c = JSON.parse(require('fs').readFileSync(f, 'utf8'));
    if (c && c.paid && c.plan) return { plan: c.plan, email: c.email || '' };
    if (c && c.plan && c.plan !== 'free') return { plan: null, email: c.email || '' };
    return { plan: null, email: (c && c.email) || '' };
  } catch {
    return { plan: null, email: '' };
  }
}

function signedInLines(plan, email) {
  if (!plan) {
    const why = email
      ? C.yellow + '○' + C.reset + '  ' + C.bold + C.white + 'NOT SIGNED IN' + C.reset + C.gray + '  ·  ' + C.reset + C.gray + email + C.reset
      : C.yellow + '○' + C.reset + '  ' + C.bold + C.white + 'NOT SIGNED IN' + C.reset + C.gray + '  ·  ' + C.reset + C.gray + 'run hakster init' + C.reset;
    return ['', why];
  }
  const label = String(plan).toUpperCase();
  const line = C.green + '●' + C.reset + '  ' + C.bold + C.white + 'SIGNED IN' + C.reset +
    C.gray + '  ·  ' + C.reset + C.green + label + C.reset + C.gray + ' plan' + C.reset;
  const who = email ? ['  ' + C.gray + email + C.reset] : [];
  return ['', line, ...who];
}

function sessionLines(info = {}) {
  const online = info.online !== false;
  const dot = online ? C.green + '●' + C.reset : C.red + '○' + C.reset;
  const state = online ? 'ONLINE' : 'OFFLINE';
  const head = [dot + '  ' + C.bold + C.white + state + C.reset];
  if (info.detail) head.push(C.gray + info.detail + C.reset);
  const when = [info.time, info.date].filter(Boolean).join('  ·  ');
  if (when) head.push(C.gray + when + C.reset);
  const out = [head.join(C.gray + '  ·  ' + C.reset)];

  const facts = [];
  if (info.memory != null) facts.push('memory ' + info.memory + ' notes');
  if (info.usbs != null) facts.push('usb ' + info.usbs);
  if (info.cwd) facts.push('cwd ' + info.cwd);
  if (facts.length) out.push(C.gray + facts.join('   ') + C.reset);
  if (info.cmds) out.push(C.gray + info.cmds + C.reset);
  return out;
}

/** Print just the account band (signed-in plan · name) for a caller that has
 *  a fresh verdict but no card to draw — e.g. the license gate confirming an
 *  account the start card had not seen yet. */
function printAccountBand(plan, email) {
  const lines = signedInLines(plan, email).filter(Boolean);
  if (lines.length) process.stdout.write(lines.join('\n') + '\n\n');
}

function metaLine(version, host, user, flavor) {
  const bits = ['v' + (version || '')];
  if (host) bits.push(host);
  if (user) bits.push(user);
  if (flavor) bits.push(flavor);
  return C.gray + bits.join('  ·  ') + C.reset;
}

function pkgVersion() {
  // cli/package.json is the CLI's own version (the one `/cli/latest.json`
  // publishes); the monorepo root is only a fallback for an older tree.
  try { return require('./package.json').version; } catch { /* fall through */ }
  try { return require('../package.json').version; } catch { return ''; }
}

const hostName = () => { try { return require('os').hostname(); } catch { return ''; } };

// ── guardrail band ──────────────────────────────────────────────────────────
// Owner, 2026-11-26: "make it do fast flow check for guard rails" — the start
// card proves the CLI's own safety rails are loaded before the first turn,
// one line per rail (owner, 2026-11-26: "ADD CHECKLIT ON STARTUP").
// Read-only (cli/src/guardrail-check.js never writes or spawns), a few ms, and
// a failure is reported here, never corrected (CLAUDE.md §11, §22.5, §50).
function railsChecklist(rails) {
  if (!rails) return [];
  const items = (Array.isArray(rails.items) ? rails.items : []).filter((i) => i && i.label);
  if (!items.length) return [];
  const scored = items.filter((i) => !i.optional);
  const failed = scored.filter((i) => !i.ok);
  const optionalOff = items.filter((i) => i.optional && !i.ok);
  const ok = failed.length === 0;

  const dot = ok ? C.green + '\u25cf' + C.reset : C.yellow + '\u25cb' + C.reset;
  // Optional rails are listed but not scored, so the count says "required"
  // whenever the ticks outnumber the score (§10: never claim more than is true).
  const optCount = items.filter((i) => i.optional).length;
  const countText = rails.pass + '/' + rails.total + (optCount ? ' required' : ' rails active');
  const count = (ok ? C.green : C.yellow) + countText + C.reset;
  // Owner, 2026-11-26: "make the text green with all in checklist on startup" —
  // the whole band reads green. A failure stays red and an unmeasured rail stays
  // its own colour: painting a broken rail green would claim it works (§10, §50).
  const out = ['', dot + '  ' + C.bold + C.green + 'CHECKLIST' + C.reset +
    C.greenDim + '  \u00b7  ' + C.reset + count +
    C.greenDim + '  \u00b7  ' + C.reset + C.greenDim + rails.ms + 'ms' + C.reset];

  // One tick per rail, in the order the check ran. Two columns when the
  // terminal has room, one when it does not, so the card never wraps.
  // A rail may carry a short measured value beside it ("386 notes",
  // "21 servers"); the column width counts it, so two columns still fit.
  const itemW = (i) => 4 + String(i.label).length + (i.note ? 2 + String(i.note).length : 0);
  const cellW = Math.max.apply(null, items.map(itemW));
  const cell = (i) => {
    const tick = i.ok
      ? C.green + '\u2713' + C.reset
      : i.optional ? C.greenDim + '\u25cb' + C.reset : C.red + '\u2717' + C.reset;
    const label = i.ok ? C.green + i.label + C.reset : C.white + i.label + C.reset;
    const note = i.note ? C.greenDim + '  ' + i.note + C.reset : '';
    return { ansi: '  ' + tick + ' ' + label + note, len: itemW(i) };
  };
  const cols = (process.stdout.columns || 80) >= cellW * 2 + 6 ? 2 : 1;
  for (let k = 0; k < items.length; k += cols) {
    const row = items.slice(k, k + cols).map(cell);
    let line = '';
    row.forEach((c, idx) => {
      line += c.ansi;
      if (idx < row.length - 1) line += ' '.repeat(Math.max(2, cellW - c.len + 2));
    });
    out.push(line);
  }
  // A scored failure names itself and its reason; an optional one (e.g. the
  // codex lane on a box without codex) is a note, never an alarm.
  for (const i of failed) {
    out.push('  ' + C.red + '\u2717' + C.reset + ' ' + C.white + i.label + C.reset +
      C.gray + (i.detail ? '  \u00b7  ' + i.detail : '') + C.reset);
  }
  if (optionalOff.length) {
    out.push('  ' + C.greenDim + 'optional off: ' + optionalOff.map((i) => i.label).join(', ') + C.reset);
  }
  return out;
}

/** Run the guardrail check once, swallowing every failure: the card is
 *  cosmetic and must never block a start (§11). */
function safeRails() {
  try {
    return require('./src/guardrail-check').runGuardrailCheck();
  } catch {
    return null;
  }
}

/** The whole start card as colour lines: brand, account, rails, optional session. */
function renderStartup(opts = {}) {
  const version = opts.version || pkgVersion();
  const host = opts.host || hostName();
  const user = opts.user || process.env.USER || process.env.USERNAME || 'ghost';
  const acct = opts.plan !== undefined ? { plan: opts.plan, email: opts.email || '' } : readPlanSync();

  const brand = [''];
  for (const l of renderBanner()) brand.push(l);
  brand.push('');
  brand.push(gradientText('autonomous ai coding & ops agent', 0.1, 0.9));
  brand.push('');
  brand.push(metaLine(version, host, user, opts.flavor || ''));

  const groups = [brand];
  const acctLines = signedInLines(acct.plan, acct.email);
  if (acctLines.length) groups.push(acctLines);
  // rails === false skips the check (a caller that already ran it, or tests);
  // a pre-computed result is used as-is so the card never runs it twice.
  const rails = opts.rails === false ? null : (opts.rails || safeRails());
  const railBand = railsChecklist(rails);
  if (railBand.length) groups.push(railBand);
  if (opts.session) groups.push(sessionLines(opts.session));
  return frameBox(groups, { border: C.greenDim });
}

/** A compact card for a start whose brand block is already on screen. Its
 *  width matches the brand card so the two stack as one column. */
function renderCard(info = {}) {
  return frameBox([sessionLines(info)], { border: C.greenDim, minWidth: 61 });
}

// ── startup intro ───────────────────────────────────────────────────────────
let _introShown = false;
let _introPlan = null;
function introShown() { return _introShown; }
function introPlan() { return _introPlan; }

function showIntro(version, opts = {}) {
  const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
  // The plan this card actually names, so a later fresh check can tell whether
  // it is saying anything the card did not already say.
  _introPlan = opts.plan !== undefined ? (opts.plan || null) : readPlanSync().plan;
  const lines = renderStartup({ ...opts, version });
  _introShown = true;

  if (!isTTY) {
    // plain mode: strip ANSI so pipes/logs stay clean
    process.stdout.write(lines.join('\n').replace(ANSI_RE, '') + '\n');
    return;
  }

  // quick staggered reveal (skipped when HAKSTER_NO_ANIM=1)
  const noAnim = process.env.HAKSTER_NO_ANIM === '1' || !process.stdout.isTTY;
  if (noAnim) { process.stdout.write(lines.join('\n') + '\n'); return; }

  let i = 0;
  const tick = () => {
    if (i >= lines.length) return;
    process.stdout.write(lines[i++] + '\n');
    if (i < lines.length) setTimeout(tick, 22);
  };
  tick();
}

// ── Ink component (optional, used by the React TUI) ─────────────────────────
function Splash({ version, hostname, user }) {
  let React, Box, Text;
  try {
    React = require('react');
    const ink = require('ink');
    Box = ink.Box; Text = ink.Text;
  } catch {
    return null; // Ink not available — caller falls back to showIntro()
  }
  const h = React.createElement;
  const art = renderBanner();
  return h(
    Box, { flexDirection: 'column', paddingX: 2, paddingY: 1 },
    ...art.map((l, i) => h(Text, { key: 'a' + i }, l)),
    h(Text, { key: 'tag' }, '  ' + gradientText('autonomous ai coding & ops agent')),
    h(Text, { key: 'meta' },
      '  v' + (version || '') + '  ·  ' + (hostname || '') + '  ·  ' + (user || '') + '  ·  ink tui')
  );
}

module.exports = {
  showIntro,
  renderBanner,
  renderStartup,
  renderCard,
  frameBox,
  gradientText,
  introShown,
  introPlan,
  railsChecklist,
  railsLines: railsChecklist,
  signedInLines,
  printAccountBand,
  readPlanSync,
  Splash,
  C,
};
