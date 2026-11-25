/* The CrushTerminal scrambler, ported word for word into the CLI.
 *
 * Owner, 2026-11-25: "look at my crush scrambler config decoder etc and add to
 * cli just like my crush term does word for word no diff want it scrambling in
 * 10 lines at a time etc or however many lines my cli panels can handle".
 *
 * The source is `HaksterAI CrushTerminal Scrambler v3` in
 * `/home/ghost/dsterm/index.html` — the same charsets, the same colour cycle,
 * the same `scScramble` hash, the same `scReasonBox` frame, and the same wave:
 * two scramble frames, then an eased reveal that walks the text in batches of
 * visual lines, with the later lines flickering until their batch starts.
 *
 * Two deliberate differences, both forced by the harness rather than the look:
 *
 *   1. The batch is 10 visual lines (the owner's own number) instead of 24, so
 *      a band is about what a CLI panel shows at once. `SC_BATCH_LINES`.
 *   2. Flicker is a seeded hash of (frame, index), not `Math.random()`. The TUI
 *      re-renders the same frame more than once (a keypress, a meter tick), and
 *      random glyphs per render would shimmer double-time. Same picture, stable
 *      output.
 *
 * Everything here is pure: give it text and a frame number, get the row back.
 * The components own the clock.
 */
const SC_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:<>?/~';
/* Kept from v3 for parity; v3 itself never prints it, and it is not used here
 * either — the scramble stays letters so the shape of a word is preserved. */
const SC_GLITCH = '!@#$%^&*()_+-=[]{}|;:<>?/~⟨⟩⟪⟫⌖⌁⌇⌬⎔⏚⏁⏃';

export const SC_COLORS = ['#875fff', '#af87ff', '#d7afff', '#ff87ff', '#d787ff', '#afafff', '#c084fc', '#9d7fff', '#a78bfa', '#7c3aed'];
const SC_EN_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SC_EN_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const SC_LETTER = /[A-Za-z]/;

/** v3: a text longer than this decodes instantly instead of animating. */
export const SC_MAX_CHARS = 900;
/** Lines revealed per batch — the owner's "10 lines at a time". */
export const SC_BATCH_LINES = 10;
/** What the components tick their decode at (v3 ran on rAF; a TUI repaints a
 *  whole frame, so this is the cost knob). */
export const SC_TICK_MS = 90;

let _scNonce = 0;

/**
 * v3's `scScramble`, unchanged: every letter is replaced by another letter of
 * the same case from a hash of its position, so case, length, spaces and
 * punctuation all survive.
 */
export function scScramble(text, offset = 0, nonce = 1) {
  const src = String(text == null ? '' : text);
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const pos = i + offset;
    if (SC_LETTER.test(ch)) {
      const alphabet = ch === ch.toUpperCase() ? SC_EN_UPPER : SC_EN_LOWER;
      const s = (Math.imul(pos + nonce + 1, 2654435761) + ch.charCodeAt(0) * 101) >>> 0;
      let next = alphabet[s % alphabet.length];
      if (next === ch) next = alphabet[(s + 13) % alphabet.length];
      out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

/** A nonce that changes per block, the way v3's `_scNonce++` did. */
export function nextScrambleNonce() {
  _scNonce = (_scNonce + 1) % 1e9;
  return _scNonce + ((Math.random() * 1e9) | 0);
}

/**
 * v3's `scReasonBox`, unchanged: the "Reasoning" ASCII frame with a 72-column
 * cap, each line optionally scrambled.
 */
export function scReasonBox(text, { columns = 72, scrambled = false, nonce = 1, colorIndex = 0 } = {}) {
  const color = SC_COLORS[Math.abs(Number(colorIndex) || 0) % SC_COLORS.length];
  const lines = String(text == null ? '' : text).split('\n');
  const cols = Math.floor(Number(columns) || 72);
  const bar = '-'.repeat(Math.min(72, Math.max(8, cols - 4)));
  let out = `\n+${bar}+\n`;
  out += '| Reasoning |\n';
  out += `+${bar}+\n`;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    out += `| ${scrambled ? scScramble(trimmed, 0, nonce) : trimmed}\n`;
  }
  out += `+${bar}+\n`;
  return { text: out, color };
}

/* Deterministic stand-in for Math.random() inside the flicker. */
function hash(a, b) {
  let h = Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * v3's `scAnimate` pre-pass: work out which character positions are scrambled,
 * grouped by the visual line they sit on, so the reveal can walk whole bands.
 * Returns null when v3 would have skipped the animation (no letters, or text
 * over SC_MAX_CHARS) — callers then just draw the final text.
 */
export function wavePlan(text, { columns = 80, batchLines = SC_BATCH_LINES, nonce = 1 } = {}) {
  const final = String(text == null ? '' : text);
  if (!final || final.length > SC_MAX_CHARS) return null;
  const initial = scScramble(final, 0, nonce || 1);
  const visualColumns = Math.max(28, Math.floor(Number(columns) || 80));
  const lines = [];
  let line = [];
  let column = 0;
  for (let i = 0; i < final.length; i += 1) {
    if (SC_LETTER.test(final[i]) && initial[i] !== final[i]) line.push(i);
    if (final.charCodeAt(i) === 10 || ++column >= visualColumns) {
      if (line.length) lines.push(line);
      line = [];
      column = 0;
    }
  }
  if (line.length) lines.push(line);
  const total = lines.reduce((n, chars) => n + chars.length, 0);
  if (!total) return null;
  const batchSize = Math.max(1, Math.floor(Number(batchLines) || SC_BATCH_LINES));
  const batchCount = Math.ceil(lines.length / batchSize);
  const averageLineLength = total / lines.length;
  const framesPerBatch = Math.min(6, Math.max(3, Math.ceil(averageLineLength / 16)));
  return {
    final,
    initial,
    lines,
    batchSize,
    batchCount,
    steps: framesPerBatch * batchCount,
    scrambleFrames: Math.min(2, Math.max(1, Math.ceil(total / 1000))),
  };
}

/** How many frames a plan takes end to end — used to stop a caller's clock. */
export function waveFrames(plan) {
  return plan ? plan.scrambleFrames + plan.steps : 0;
}

/**
 * One frame of the wave: v3's tick, with the frame number supplied instead of a
 * requestAnimationFrame loop. Returns `{ text, done, progress }`.
 */
export function waveText(plan, frame) {
  if (!plan) return { text: '', done: true, progress: 1 };
  const f = Math.max(0, Math.floor(Number(frame) || 0));
  const { final, initial, lines, batchSize, batchCount, steps, scrambleFrames } = plan;
  const current = initial.split('');

  if (f < scrambleFrames) {
    // Scramble frames: the whole block flickers letters before the reveal.
    for (const chars of lines) {
      for (const idx of chars) {
        const alphabet = final[idx] === final[idx].toUpperCase() ? SC_EN_UPPER : SC_EN_LOWER;
        current[idx] = alphabet[Math.floor(hash(f, idx) * alphabet.length)];
      }
    }
    return { text: current.join(''), done: false, progress: 0 };
  }

  const step = f - scrambleFrames + 1;
  const p = Math.min(1, step / Math.max(1, steps));
  const batchProgress = p * batchCount;
  const activeBatch = Math.min(batchCount - 1, Math.floor(batchProgress));
  const lineProgress = Math.min(1, batchProgress - activeBatch);
  const eased = 1 - Math.pow(1 - lineProgress, 3);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const chars = lines[lineNo];
    const batchNo = Math.floor(lineNo / batchSize);
    const lineTarget = batchNo < activeBatch
      ? chars.length
      : batchNo > activeBatch
        ? 0
        : Math.min(chars.length, Math.max(1, Math.floor(eased * chars.length)));
    for (let i = 0; i < chars.length; i += 1) {
      const idx = chars[i];
      const shouldFlicker = batchNo > activeBatch
        || (batchNo === activeBatch && (i >= lineTarget || (lineProgress < 0.25 && hash(f, idx) < 0.35)));
      if (shouldFlicker) {
        const alphabet = final[idx] === final[idx].toUpperCase() ? SC_EN_UPPER : SC_EN_LOWER;
        current[idx] = alphabet[Math.floor(hash(f + 7, idx) * alphabet.length)];
      } else {
        current[idx] = final[idx];
      }
    }
  }
  const done = step >= steps;
  return { text: done ? final : current.join(''), done, progress: p };
}

/** v3's decode colour: it cycles through SC_COLORS during the wave. */
export function waveColor(colorIndex, frame, progress = 0) {
  const base = Math.abs(Number(colorIndex) || 0);
  const idx = (base + Math.floor((Number(progress) || 0) * 4)) % SC_COLORS.length;
  return SC_COLORS[idx];
}

export { SC_CHARS, SC_GLITCH, SC_EN_UPPER, SC_EN_LOWER };
