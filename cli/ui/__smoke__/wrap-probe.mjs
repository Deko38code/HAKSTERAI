/* Composer wrap probe (owner, 2026-11-26: "fix input bar when i type keeps
 * glitching bad").
 *
 * Measures the REAL bar while a draft is typed into it, one chunk at a time
 * with opentui's own typeText (pressKey('space') types the literal word, which
 * is what made the first version of this probe useless):
 *
 *   - the composer block's top row and height on every chunk, so a height that
 *     flips back and forth is visible as numbers, not as a "feels glitchy",
 *   - which rows above it moved (a bar that changes size shoves the transcript),
 *   - how many characters of the draft are actually on screen (clipping).
 *
 * Run under Bun: bun ui/__smoke__/wrap-probe.mjs [width] [height]
 */
import React from 'react';
process.env.HOME = '/tmp/probe-home';
process.env.HAKSTER_NO_INTRO = '1';
process.env.HAKSTER_NO_HISTORY = '1';
const { createTestRenderer } = await import('@opentui/core/testing');
const { createRoot, flushSync } = await import('@opentui/react');
const { default: App } = await import('/home/ghost/haksterAi/cli/ui/src/App.jsx');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.fetch = async (u) =>
  new Response(JSON.stringify({ phase: 'idle', connected: true, model: 'probe', trust: 3, tokens: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const W = Number(process.argv[2] || 100);
const H = Number(process.argv[3] || 30);

const setup = await createTestRenderer({ width: W, height: H });
const root = createRoot(setup.renderer);
flushSync(() => root.render(React.createElement(App, { version: 'probe' })));
await setup.flush();
await settle(700);
await setup.flush();

const rows = () => setup.captureCharFrame().split('\n');

/** The composer block: from the rounded border above the '›' row to its bottom.
 *
 * The MCP panel sits to its right and shares those border rows, so the box is
 * found by the FIRST non-space character of each line — the composer is the
 * leftmost box in the column, and a panel's own ╰ must never close it.
 */
function block(frame) {
  const f = frame.split('\n');
  const gi = f.findIndex((l) => l.includes('›'));
  if (gi < 0) return null;
  let top = gi;
  while (top > 0 && !/^\s*[╭┌]/.test(f[top])) top -= 1;
  let bot = gi;
  while (bot < f.length - 1 && !/^\s*[╰└]/.test(f[bot])) bot += 1;
  return { top, bot, height: bot - top + 1, lines: f.slice(top, bot + 1) };
}

const draft =
  'please check the movie server logs and tell me why the stream keeps buffering on the firestick when i start a new episode at night';
const CHUNK = 5;

let typed = '';
const history = [];
const snap = (tag) => {
  const f = setup.captureCharFrame();
  const b = block(f);
  if (!b) {
    console.log(`\n${tag}: NO COMPOSER FOUND`);
    return null;
  }
  // Chars of the draft actually visible inside the block (whitespace-insensitive).
  const flat = b.lines.join('').replace(/[│╭╮╰╯─\s]/g, '');
  const want = typed.replace(/\s/g, '');
  let seen = 0;
  let i = 0;
  for (const ch of want) {
    const j = flat.indexOf(ch, i);
    if (j >= 0) {
      seen += 1;
      i = j + 1;
    }
  }
  const rec = { tag, typed: typed.length, top: b.top, height: b.height, seen, want: want.length };
  history.push(rec);
  return rec;
};

const start = snap('start');
console.log(
  `[start] composer top=${start.top} height=${start.height} (terminal ${W}x${H})`,
);

const frames = [];
for (let i = 0; i < draft.length; i += CHUNK) {
  const chunk = draft.slice(i, i + CHUNK);
  await setup.mockInput.typeText(chunk);
  await setup.flush();
  typed += chunk;
  const rec = snap(`+${typed.length}`);
  frames.push(rec);
  const note = rec.seen < rec.want ? `  ⚠ ${rec.want - rec.seen} chars off screen` : '';
  console.log(
    `  typed ${String(rec.typed).padStart(3)}  top ${String(rec.top).padStart(2)}  height ${rec.height}  visible ${rec.seen}/${rec.want}${note}`,
  );
  if (rec.seen < rec.want * 0.5) {
    console.log(`      ↳ block at this keystroke:`);
    block(setup.captureCharFrame()).lines.forEach((l) =>
      console.log(`        ${JSON.stringify(l.replace(/\s+$/, '').slice(0, W + 4))}`),
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────
const heights = frames.map((f) => f.height);
let flips = 0;
for (let i = 1; i < heights.length; i += 1) if (heights[i] !== heights[i - 1]) flips += 1;
const tops = new Set(frames.map((f) => f.top));
const clipped = frames.filter((f) => f.seen < f.want);

console.log(`\n[summary]`);
console.log(`  height changes while typing: ${flips} (${heights.join(' → ')})`);
console.log(`  distinct composer top rows: ${[...tops].sort((a, b) => a - b).join(',') || 'n/a'}`);
console.log(`  chunks with text off screen: ${clipped.length}/${frames.length}`);
if (clipped.length) {
  const worst = clipped.reduce((a, b) => (b.want - b.seen > a.want - a.seen ? b : a));
  console.log(`  worst clip: ${worst.want - worst.seen} chars at "${worst.tag}" (height ${worst.height})`);
}

console.log(`\n[frame] final bottom 10 rows:`);
const fin = rows();
fin.slice(-10).forEach((l, i) =>
  console.log(`   ${String(fin.length - 10 + i).padStart(2)} ${JSON.stringify(l.replace(/\s+$/, ''))}`),
);

root.unmount();
setup.renderer.destroy();
