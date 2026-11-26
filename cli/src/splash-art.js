/* splash-art.js — the CLI's start picture, drawn in plain ANSI.
 *
 * Owner, 2026-11-26: "we need it nice tho matching our hacker theme" — the Ink
 * fallback TUI opened with a three-line box-drawing logo and no artwork at all
 * (found on the Surface Pro: "didnt show png logo matrix etc"), while the
 * OpenTUI dashboard painted the full hacker-desk picture. This module is the
 * one renderer used outside the dashboard, so a start screen carries the real
 * artwork wherever the CLI runs.
 *
 * Why plain ANSI and not the kitty protocol: the PNG path needs kitty /
 * Ghostty / WezTerm, and Windows Terminal speaks none of them. Half-block
 * cells (`▀` with a foreground and a background colour) turn each terminal
 * cell into two picture pixels, so the same artwork appears in any terminal
 * that understands colours — Windows Terminal, Guake, xterm, kitty alike.
 *
 * The picture is the shipped 120×90 coverage grid (assets/*.art.json, produced
 * by scripts/make-hero-art.mjs), the Matrix rain runs behind its dark pixels,
 * and the brand caption is drawn with the same acid-green gradient the startup
 * card uses. Nothing here writes a file, spawns a process or reads /proc: it is
 * pure text generation, so it behaves identically on every platform.
 *
 * Exports: colorDepth, rgbTo256, loadArt, artSize, rainColumns,
 *          splashRows, wordmarkRows, frameCount, stepMs, splashImageFile,
 *          cliVersion, C
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Every shipped art grid is this size; a different grid simply scales.
const ART_W = 120;
const ART_H = 90;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[38;5;46m',
  greenDim: '\x1b[38;5;28m',
  gray: '\x1b[38;5;240m',
};

// ── colour capability ───────────────────────────────────────────────────────
/** What this terminal can be painted with: 'truecolor' | 'ansi256' | 'none'.
 *
 *  Windows is the reason this exists. `logo.js` decides truecolor from
 *  COLORTERM/TERM, and Windows sets neither, so the card on a Surface Pro fell
 *  back to a single flat colour while the terminal could show the full picture.
 *  Windows Terminal marks itself with WT_SESSION and a TERM_PROGRAM, and Node
 *  enables VT processing on Windows 10+, so a win32 console is truecolor by
 *  default here.
 */
function colorDepth(env = process.env, out = process.stdout) {
  const flag = String(env.HAKSTER_COLOR || '').toLowerCase();
  if (flag === 'off' || flag === 'none' || flag === '0') return 'none';
  if (flag === 'truecolor' || flag === '24bit') return 'truecolor';
  if (flag === '256' || flag === 'ansi256') return 'ansi256';
  if (env.NO_COLOR) return 'none';
  if (out && out.isTTY === false) return 'none';
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return 'truecolor';
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0') return 'truecolor';

  const ct = String(env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';

  const prog = String(env.TERM_PROGRAM || '').toLowerCase();
  if (/windows_terminal|vscode|wezterm|ghostty|iterm|hyper|tabby|apple_terminal|mintty/.test(prog)) return 'truecolor';
  if (env.WT_SESSION) return 'truecolor'; // Windows Terminal
  if (String(env.ConEmuANSI || '').toUpperCase() === 'ON') return 'truecolor';
  if (env.ANSICON) return 'ansi256';

  const term = String(env.TERM || '');
  if (term === 'dumb') return 'none';
  if (/-256color$/.test(term)) return 'ansi256';
  if (/^(xterm|screen|tmux|vt100|linux|ansi|rxvt)/.test(term)) return 'ansi256';

  // No hint at all: a Windows console is the one place where "nothing is set"
  // still means colour, because Node turned VT on for it.
  if (process.platform === 'win32') return 'truecolor';
  return out && out.isTTY ? 'ansi256' : 'none';
}

/** Nearest xterm-256 index for an RGB triplet (6×6×6 cube + grey ramp). */
function rgbTo256(r, g, b) {
  const c = [r, g, b].map((v) => {
    const n = Math.max(0, Math.min(255, v));
    return Math.round((n / 255) * 5);
  });
  return 16 + 36 * c[0] + 6 * c[1] + c[2];
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// ── the artwork ─────────────────────────────────────────────────────────────
const _artCache = new Map();

/** Read a shipped `.art.json` grid into {width, height, px}. Cached per file. */
function loadArt(file) {
  if (!file) return null;
  const hit = _artCache.get(file);
  if (hit !== undefined) return hit;
  let art = null;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const px = Buffer.from(String(json.rgbBase64 || ''), 'base64');
    const width = Number(json.width) || 0;
    const height = Number(json.height) || 0;
    art = width > 0 && height > 0 && px.length === width * height * 3 ? { width, height, px } : null;
  } catch {
    art = null;
  }
  _artCache.set(file, art);
  return art;
}

function cliRoot() {
  return process.env.HAKSTER_CLI_DIR || path.join(__dirname, '..');
}

/** True when this CLI is a git checkout (the owner's own dev tree, §8). */
function isCheckout(root) {
  try {
    return fs.existsSync(path.join(root, '..', '.git'));
  } catch {
    return false;
  }
}

/**
 * Which picture a start screen paints — the same rule the dashboard uses
 * (kitty-graphics.splashPath): an installed copy shows the hacker-theme
 * backdrop, a source checkout keeps the hero. Whichever `.art.json` exists
 * wins, so a missing asset can never blank the start screen.
 */
function splashImageFile({ root = cliRoot(), checkout = null } = {}) {
  const assets = path.join(root, 'assets');
  const backdrop = path.join(assets, 'haksterai-backdrop.art.json');
  const hero = path.join(assets, 'haksterai-hero.art.json');
  const has = (f) => {
    try { return fs.existsSync(f); } catch { return false; }
  };
  const isDev = checkout == null ? isCheckout(root) : Boolean(checkout);
  if (!isDev && has(backdrop)) return backdrop;
  if (has(hero)) return hero;
  return has(backdrop) ? backdrop : '';
}

/** The version the CLI actually is — `cli/package.json`, the one source (§39). */
function cliVersion() {
  try { return String(require('../package.json').version || ''); } catch { /* bundled */ }
  try { return String(require('../package.json').version || ''); } catch { return ''; }
}

/**
 * How many cells the picture gets inside a box: as large as fits, keeping the
 * artwork's own shape. One cell is one pixel wide and two pixels tall, because
 * a half block carries two pixels.
 */
function artSize(width, height, art = { width: ART_W, height: ART_H }) {
  const cols = Math.max(0, Math.floor(Number(width) || 0));
  const rows = Math.max(0, Math.floor(Number(height) || 0));
  if (cols < 24 || rows < 8) return { cols: 0, rows: 0 };
  const shape = art.width / art.height;
  let r = rows;
  let c = Math.round(r * 2 * shape);
  if (c > cols) {
    c = cols;
    r = Math.max(4, Math.round(c / shape / 2));
  }
  return { cols: c, rows: r };
}

// ── the Matrix rain ─────────────────────────────────────────────────────────
const RAIN_GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
const RAIN = {
  head: [216, 255, 230],
  near: [0, 255, 65],
  tail: [10, 92, 34],
};

/** Deterministic per-cell hash — no randomness, so a frame is reproducible. */
function rainHash(a, b, c) {
  let h = Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263) + Math.imul(c + 1, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** One falling stream per column: where its head is this frame and how long. */
function rainColumns(width, height, frame) {
  const cols = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  const period = h + 12;
  const streams = [];
  for (let c = 0; c < cols; c += 1) {
    const speed = 0.45 + (rainHash(c, 7, 1) % 100) / 90;
    const phase = rainHash(c, 11, 2) % period;
    const trail = 3 + (rainHash(c, 13, 3) % 7);
    const head = Math.floor((frame * speed + phase) % period) - 8;
    streams.push({ c, head, trail });
  }
  return { streams, cols, height: h };
}

// ── composition ─────────────────────────────────────────────────────────────
const DARK = 34; // below this luma a cell is "background" and may carry rain

/** Round a channel to a step so flat areas merge into one span. Fewer escapes
 *  is the difference between one frame of ~40 kB and ~150 kB of terminal I/O. */
const quantize = (v, step) => (step > 1 ? Math.min(255, Math.round(v / step) * step) : clamp255(v));

function paintCell(fg, bg, depth, step) {
  const f = [quantize(fg[0], step), quantize(fg[1], step), quantize(fg[2], step)];
  const b = [quantize(bg[0], step), quantize(bg[1], step), quantize(bg[2], step)];
  if (depth === 'truecolor') {
    return `\x1b[38;2;${f[0]};${f[1]};${f[2]}m\x1b[48;2;${b[0]};${b[1]};${b[2]}m`;
  }
  return `\x1b[38;5;${rgbTo256(f[0], f[1], f[2])}m\x1b[48;5;${rgbTo256(b[0], b[1], b[2])}m`;
}

/** The brand caption under the picture: a rule, the name, the version. */
function captionRows(cols, version, depth) {
  const name = 'HAKSTER-AI';
  const tag = 'autonomous ai coding & ops agent';
  const ver = version ? `v${version}` : '';
  if (depth === 'none') {
    const left = `◆ ${name}`;
    const line = `${left}${tag ? '   ' + tag : ''}${ver ? '   ' + ver : ''}`;
    return ['─'.repeat(Math.min(cols, 60)), line.slice(0, cols)];
  }
  const rule = C.greenDim + '─'.repeat(Math.min(cols, 60)) + C.reset;
  const head = C.bold + C.green + '◆ ' + name + C.reset +
    (tag ? C.gray + '   ' + tag + C.reset : '') +
    (ver ? C.greenDim + '   ' + ver + C.reset : '');
  return [rule, head];
}

/**
 * One finished start screen: `rows` lines, each exactly `cols` cells wide.
 *
 * @param {object} o
 * @param {number} o.cols   terminal columns
 * @param {number} o.rows   terminal rows
 * @param {number} o.frame  animation step (0 = first)
 * @param {string} o.imageFile  art grid to paint (default: see splashImageFile)
 * @param {boolean} o.rain  draw the Matrix rain behind the dark pixels
 * @param {boolean} o.caption  draw the brand caption under the picture
 * @param {number} o.quant  colour step used to merge spans (default 16)
 */
function splashRows(o = {}) {
  const cols = Math.max(20, Math.floor(Number(o.cols) || 80));
  const height = Math.max(6, Math.floor(Number(o.rows) || 24));
  const frame = Math.max(0, Math.floor(Number(o.frame) || 0));
  const depth = o.depth || colorDepth();
  const quant = o.quant == null ? 16 : Number(o.quant) || 0;
  const step = depth === 'truecolor' ? quant : 0;
  const version = o.version == null ? cliVersion() : String(o.version || '');
  const art = loadArt(o.imageFile || splashImageFile());

  // Picture first: the largest that fits, with room for the caption.
  const wantCaption = o.caption !== false && height >= 12;
  const footRows = wantCaption ? 3 : 0;
  const size = art ? artSize(cols, height - footRows, art) : { cols: 0, rows: 0 };

  if (!size.cols) {
    // No artwork (or no room for it): the block wordmark still says who this is
    // — on one `◆ HAKSTER-AI` line when the block letters would not fit, so a
    // narrow window never gets a wrapped, ragged logo.
    const block = wordmarkRows(depth);
    const w = Math.max(0, ...block.map(visibleLen));
    const lines = w <= cols ? block : [nameLine(depth)];
    if (wantCaption) lines.push(...captionRows(cols, version, depth));
    return lines.slice(0, height).map((l) => fitRow(l, cols));
  }

  const left = Math.floor((cols - size.cols) / 2);
  const top = Math.floor((height - footRows - size.rows) / 2);
  const { streams } = o.rain === false ? { streams: [] } : rainColumns(size.cols, size.rows, frame);

  const pxRows = size.rows * 2;
  const stepX = art.width / size.cols;
  const stepY = art.height / pxRows;

  // A cell is a half block: ▀ paints its top pixel in the foreground and its
  // bottom pixel in the background, so two picture rows fit in one text row.
  const lines = [];
  const bodyRows = height - footRows;
  for (let r = 0; r < bodyRows; r += 1) {
    const inside = r >= top && r < top + size.rows;
    const row = inside ? r - top : -1;
    const cells = [];
    for (let c = 0; c < cols; c += 1) {
      if (!inside || c < left || c >= left + size.cols) {
        // Outside the picture: the rain falls on black.
        cells.push({ ch: ' ', fg: [0, 0, 0], bg: [0, 0, 0], blank: true });
        continue;
      }
      const cx = c - left;
      const yTop = Math.min(art.height - 1, Math.floor(row * 2 * stepY + stepY / 2));
      const yBot = Math.min(art.height - 1, Math.floor((row * 2 + 1) * stepY + stepY / 2));
      const x = Math.min(art.width - 1, Math.floor(cx * stepX + stepX / 2));
      const oTop = (yTop * art.width + x) * 3;
      const oBot = (yBot * art.width + x) * 3;
      const fg = [art.px[oTop], art.px[oTop + 1], art.px[oTop + 2]];
      const bg = [art.px[oBot], art.px[oBot + 1], art.px[oBot + 2]];
      cells.push({ ch: '▀', fg, bg, blank: false });
    }
    // Rain: only over pixels dark enough to read as background, so glyphs fall
    // around the picture instead of burning holes through it.
    if (streams.length) {
      for (const s of streams) {
        const col = left + s.c;
        if (col < 0 || col >= cols) continue;
        const cell = cells[col];
        if (!cell) continue;
        const dist = s.head - row;
        if (dist < 0 || dist >= s.trail) continue;
        const own = cell.blank ? 0 : luma(cell.fg[0], cell.fg[1], cell.fg[2]) * 0.5 + luma(cell.bg[0], cell.bg[1], cell.bg[2]) * 0.5;
        if (!cell.blank && own >= DARK) continue; // the picture's own lit pixels win
        const glyph = RAIN_GLYPHS[rainHash(s.c, row, Math.floor(frame / 2)) % RAIN_GLYPHS.length];
        cell.ch = glyph;
        cell.fg = dist === 0 ? RAIN.head : dist <= 2 ? RAIN.near : RAIN.tail;
        cell.blank = false;
      }
    }
    lines.push(emitRow(cells, depth, step));
  }

  if (footRows) {
    const cap = captionRows(cols, version, depth);
    lines.push('');
    lines.push(cap[0]);
    lines.push(cap[1]);
  }
  return lines.map((l) => fitRow(l, cols));
}

/** Merge a row of cells into as few coloured spans as possible. */
function emitRow(cells, depth, step) {
  if (depth === 'none') {
    return cells.map((c) => (c.blank ? ' ' : c.ch)).join('');
  }
  let out = '';
  let run = null;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out += paintCell(run.fg, run.bg, depth, step) + buf;
    buf = '';
  };
  for (const cell of cells) {
    const key = cell.blank ? '\u0000' : `${quantize(cell.fg[0], step)},${quantize(cell.fg[1], step)},${quantize(cell.fg[2], step)}|${quantize(cell.bg[0], step)},${quantize(cell.bg[1], step)},${quantize(cell.bg[2], step)}`;
    if (cell.blank) {
      // A blank cell keeps the picture's black background and costs one space.
      if (run && run.key !== 'blank') flush();
      run = { key: 'blank', fg: [0, 0, 0], bg: [0, 0, 0] };
      buf += ' ';
      continue;
    }
    if (!run || run.key !== key) {
      flush();
      run = { key, fg: cell.fg, bg: cell.bg };
    }
    buf += cell.ch;
  }
  flush();
  return out + C.reset;
}

// ── fallbacks ───────────────────────────────────────────────────────────────
const GLYPHS = {
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  K: ['█   █', '█  █ ', '███  ', '█  █ ', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  I: [' ███ ', '  █  ', '  █  ', '  █  ', ' ███ '],
  '-': ['     ', '     ', '█████', '     ', '     '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

/** The HAKSTER-AI block wordmark — the one glyph table the CLI falls back to
 *  when even the ANSI picture cannot fit (one row of `◆ HAKSTER-AI` below). */
function wordmarkRows(depth = 'truecolor') {
  const word = 'HAKSTER-AI';
  const lines = ['', '', '', '', ''];
  for (const ch of word) {
    const g = GLYPHS[ch] || GLYPHS[' '];
    for (let r = 0; r < 5; r += 1) lines[r] += (lines[r] ? ' ' : '') + g[r];
  }
  if (depth === 'none') return lines;
  // Acid-green → electric-cyan shade per row, so it still reads as our mark.
  const shades = ['\x1b[38;5;46m', '\x1b[38;5;48m', '\x1b[38;5;51m', '\x1b[38;5;49m', '\x1b[38;5;46m'];
  return lines.map((l, i) => shades[i % shades.length] + l + C.reset);
}

/** The one-row brand for a window too narrow for the block letters. */
function nameLine(depth = 'truecolor') {
  const text = '◆ HAKSTER-AI';
  return depth === 'none' ? text : C.bold + C.green + text + C.reset;
}

/** Visible width of a coloured line (ANSI stripped). */
function visibleLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad a line to exactly `cols` cells with unstyled spaces.
 *
 *  Every row is the same width for a real reason, not tidiness: the frames are
 *  drawn without a per-line erase, so a short row following a longer one (a
 *  caption after a full-width picture row) would otherwise leave the previous
 *  frame's characters visible to its right. Padding every row makes that
 *  impossible, and costs one space per empty cell.
 */
function fitRow(line, cols) {
  const s = String(line == null ? '' : line);
  const pad = cols - visibleLen(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** Animation: how many frames a start screen draws, and how fast. */
const frameCount = () => 16;
const stepMs = () => 90;

module.exports = {
  ART_W,
  ART_H,
  C,
  RAIN_GLYPHS,
  colorDepth,
  rgbTo256,
  loadArt,
  artSize,
  rainColumns,
  splashRows,
  wordmarkRows,
  nameLine,
  visibleLen,
  fitRow,
  captionRows,
  frameCount,
  stepMs,
  splashImageFile,
  cliVersion,
  isCheckout,
};
