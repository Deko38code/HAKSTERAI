// haksterAi startup splash — big block ASCII art + truecolor gradient
// Zero external deps (no figlet/gradient-string/boxen needed).
// Exports: showIntro(version), C (ANSI color map), renderBanner(), Splash (Ink component)

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

// ── startup intro ───────────────────────────────────────────────────────────
function showIntro(version) {
  const v = version || (() => {
    try { return require('../package.json').version; } catch { return ''; }
  })();
  const host = (() => { try { return require('os').hostname(); } catch { return ''; } })();
  const user = process.env.USER || process.env.USERNAME || 'ghost';
  const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

  const lines = [];
  lines.push('');
  for (const l of renderBanner()) lines.push('  ' + l);
  lines.push('');
  lines.push('  ' + gradientText('autonomous ai coding & ops agent', 0.1, 0.9));
  lines.push(
    '  ' + C.gray + 'v' + v + C.reset +
    C.gray + '  ·  ' + C.reset + C.green + host + C.reset +
    C.gray + '  ·  ' + C.reset + C.cyan + user + C.reset +
    C.gray + '  ·  ' + C.reset + C.magenta + 'ink' + C.reset + C.gray + ' tui' + C.reset
  );
  lines.push('');
  lines.push(
    '  ' + C.gray + '┃ ' + C.reset + C.white + 'hint' + C.reset +
    C.gray + '  /help commands  ·  /tools list  ·  esc interrupt' + C.reset
  );
  lines.push('');

  if (!isTTY) {
    // plain mode: strip ANSI so pipes/logs stay clean
    return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  }

  // quick staggered reveal (skipped when HAKSTER_NO_ANIM=1)
  const noAnim = process.env.HAKSTER_NO_ANIM === '1';
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

module.exports = { showIntro, renderBanner, gradientText, Splash, C };
