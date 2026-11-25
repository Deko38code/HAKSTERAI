/* The CrushTerminal scrambler, ported word for word.
 *
 * Owner, 2026-11-25: "look at my crush scrambler config decoder etc and add to
 * cli just like my crush term does word for word no diff want it scrambling in
 * 10 lines at a time etc or however many lines my cli panels can handle".
 *
 * Pinned here:
 *   1. `scScramble` is v3's own hash, checked against v3's formula;
 *   2. `scReasonBox` frames its lines exactly as v3 does;
 *   3. the wave decodes in batches of 10 visual lines, settles on the real text,
 *      and is deterministic for a given frame (a TUI repaints a frame twice);
 *   4. the components actually use it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SC_BATCH_LINES,
  SC_COLORS,
  SC_MAX_CHARS,
  scReasonBox,
  scScramble,
  waveColor,
  waveFrames,
  wavePlan,
  waveText,
} from '../src/utils/crush-scrambler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/** v3's scScramble, copied from /home/ghost/dsterm/index.html for comparison. */
function v3(text, offset = 0, n = 0) {
  const U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const L = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const pos = i + offset;
    if (/[A-Za-z]/.test(ch)) {
      const a = ch === ch.toUpperCase() ? U : L;
      const s = (Math.imul(pos + n + 1, 2654435761) + ch.charCodeAt(0) * 101) >>> 0;
      let nx = a[s % a.length];
      if (nx === ch) nx = a[(s + 13) % a.length];
      out += nx;
    } else {
      out += ch;
    }
  }
  return out;
}

test('scScramble is v3\'s hash, letter for letter', () => {
  const samples = ['Hello, world!', 'Reasoning: fixing the build (npm run build).', 'a b c 1 2 3'];
  for (const s of samples) {
    for (const nonce of [0, 1, 42, 99999]) {
      assert.equal(scScramble(s, 0, nonce), v3(s, 0, nonce), `nonce ${nonce}`);
    }
  }
  // Case, length, spaces and punctuation survive; the letters change.
  const out = scScramble('Fix The Build!', 0, 7);
  assert.equal(out.length, 'Fix The Build!'.length);
  assert.equal(out[3], ' ');
  assert.equal(out[out.length - 1], '!');
  assert.equal(out[0] === out[0].toUpperCase(), true, 'first letter stays upper case');
  assert.notEqual(out, 'Fix The Build!');
  // Same input and nonce, same output (a repaint must not reshuffle).
  assert.equal(scScramble('stable', 0, 5), scScramble('stable', 0, 5));
});

test('scReasonBox draws v3\'s Reasoning frame', () => {
  const box = scReasonBox('line one\nline two ', { columns: 40 });
  const lines = box.text.split('\n');
  assert.equal(lines[0], '', 'v3 opens with a newline');
  assert.equal(lines[1], `+${'-'.repeat(36)}+`);
  assert.equal(lines[2], '| Reasoning |');
  assert.equal(lines[3], `+${'-'.repeat(36)}+`);
  assert.equal(lines[4], '| line one');
  assert.equal(lines[5], '| line two', 'trailing whitespace trimmed');
  assert.equal(lines[6], `+${'-'.repeat(36)}+`);
  assert.ok(SC_COLORS.includes(box.color), 'the box carries one of v3\'s colours');
  // The bar caps at 72 columns however wide the panel is.
  const wide = scReasonBox('x', { columns: 400 }).text.split('\n')[1];
  assert.equal(wide.length, 74);
  // Scrambled mode keeps the frame and scrambles only the words.
  const scr = scReasonBox('keep me', { columns: 40, scrambled: true, nonce: 3 }).text;
  assert.ok(scr.includes('| Reasoning |'));
  assert.ok(scr.includes('| ') && !scr.includes('| keep me'));
});

test('the wave decodes in bands of 10 lines and settles on the real text', () => {
  assert.equal(SC_BATCH_LINES, 10, 'the owner\'s 10 lines at a time');
  const text = Array.from({ length: 25 }, (_, i) => `line ${i + 1} ok`).join('\n');
  const plan = wavePlan(text, { columns: 80 });
  assert.ok(plan, 'a normal block animates');
  assert.ok(plan.batchCount >= 3, 'twenty-five short lines make three bands of ten');
  assert.equal(plan.batchSize, 10, 'ten visual lines per band');
  const end = waveText(plan, waveFrames(plan));
  assert.equal(end.done, true);
  assert.equal(end.text, text, 'the wave always lands on the real text');
  // Mid-wave something is still scrambled, and a frame is stable across draws.
  const mid = waveText(plan, plan.scrambleFrames + Math.floor(plan.steps / 2));
  assert.equal(mid.done, false);
  assert.notEqual(mid.text, text);
  assert.equal(waveText(plan, 5).text, waveText(plan, 5).text);
  // v3 skips the animation above 900 characters.
  assert.equal(wavePlan('x'.repeat(SC_MAX_CHARS + 1)), null);
  // No letters, nothing to decode.
  assert.equal(wavePlan('-----'), null);
  // Colour cycles through v3's palette.
  assert.ok(SC_COLORS.includes(waveColor(0, 3, 0.5)));
});

test('the CLI draws its reasoning and its splash through the ported scrambler', () => {
  const block = read('cli/ui/src/components/MessageBlock.jsx');
  assert.ok(block.includes("from '../utils/crush-scrambler.js'"), 'MessageBlock uses it');
  assert.match(block, /scReasonBox\(text, \{ columns \}\)/, 'the reopened block is v3\'s Reasoning box');
  assert.match(block, /wavePlan\(plain\.text, \{ columns, nonce \}\)/, 'and wave-decodes');
  assert.match(block, /waveText\(newestPlan, newestFrame\)/, 'the live block decodes its newest line');

  const splash = read('cli/ui/src/components/DecodeSplash.jsx');
  assert.match(splash, /scScramble\(t\.slice\(head\.length\), head\.length, frame \+ 1\)/, 'the splash scrambles with the same function');

  // The source really is this one (the hash constant) and it is not a lookalike.
  const src = read('cli/ui/src/utils/crush-scrambler.js');
  assert.ok(src.includes('2654435761'), 'v3\'s hash multiplier');
  assert.ok(src.includes('CrushTerminal Scrambler v3'), 'provenance recorded');
});
