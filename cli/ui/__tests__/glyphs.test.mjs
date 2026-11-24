/* Every glyph the TUI prints must come from the terminal's own monospace font.
 *
 * The bug these pin (2026-11-24, owner: "make our tui fonts one"): the panels
 * mixed a dozen emoji drawn by Noto Color Emoji / VL Gothic / Noto Sans Symbols2
 * into a fixed-width layout. Those fonts are proportional-colour and double
 * width, so every 🧠/📦/📎 nudged the columns and looked nothing like the ASCII
 * around them. They are now single-width geometric glyphs from DejaVu Sans Mono,
 * the family the terminal actually resolves `monospace` to.
 *
 * A source scan alone is not enough: esbuild re-encodes astral characters as
 * surrogate pairs (`"🧠"`) or `\u{1F9E0}`, so a grep for the literal
 * emoji finds nothing while the shipped bundle still prints it. This decodes all
 * three encodings in the sources AND the built bundles, so a regression fails
 * here instead of on the owner's screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* Codepoints we must never emit. Astral-plane pictographs can never come from a
 * monospace font, and these three BMP ones are absent from DejaVu Sans Mono too
 * (each resolved to VL Gothic / Noto Sans Symbols2 before the swap). */
const BLOCKED = new Set([
  0x23f3 /* ⏳ */, 0x23f8 /* ⏸ */, 0x26e8 /* ⛨ */, 0x2705 /* ✅ */, 0x2b21 /* ⬡ */,
]);
/* ❌ is deliberately kept: smartness.mjs and the tool cards match it in a regex
 * against server output. It is never rendered as text.
 *
 * 🧠 (U+1F9E0) is deliberately kept too. The owner asked for the brain back on
 * the meters row (2026-11-24: "you removed my autolearn brain emoji") after the
 * all-mono pass, so it is the one colour glyph the TUI still prints. It only
 * ever sits at the head of the meter line, where the header's fit test already
 * reserves the extra cell a double-width glyph takes (the `+2 slack` in
 * App.jsx), so it cannot push a column out of place. */
const ALLOWED = new Set([0x274c, 0x1f9e0]);

const isBlocked = (cp) => {
  if (ALLOWED.has(cp)) return false;
  if (BLOCKED.has(cp)) return true;
  return cp >= 0x1f000 && cp <= 0x1faff;
};

/** Every codepoint a JS string literal in `src` would produce. */
function decodeEscapes(src) {
  const out = [];
  const push = (cp) => out.push(cp);
  for (const m of src.matchAll(/\\u\{([0-9A-Fa-f]{1,6})\}/g)) push(parseInt(m[1], 16));
  for (const m of src.matchAll(/\\u([dD][89abAB][0-9A-Fa-f]{2})\\u([dD][c-fC-F][0-9A-Fa-f]{2})/g)) {
    push(0x10000 + ((parseInt(m[1], 16) - 0xd800) << 10) + (parseInt(m[2], 16) - 0xdc00));
  }
  // The surrogate halves above also match this pattern individually; they are
  // skipped so a valid pair is not reported twice.
  for (const m of src.matchAll(/\\u([0-9A-Fa-f]{4})/g)) {
    const cp = parseInt(m[1], 16);
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    push(cp);
  }
  return out;
}

function offendersIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const codepoints = [
    ...decodeEscapes(src),                      // \uXXXX, \u{...}, surrogate pairs
    ...[...src].map((ch) => ch.codePointAt(0)), // literal characters
  ];
  const hits = codepoints.filter(isBlocked);
  return { hits, count: hits.length };
}

function collectSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.includes('.bak')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(p));
    else if (/\.(jsx|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('UI sources emit no colour-emoji glyphs', () => {
  const files = collectSources(path.join(cliRoot, 'ui', 'src'));
  assert.ok(files.length > 10, 'expected to scan the UI sources');
  const bad = files
    .map((f) => ({ f, ...offendersIn(f) }))
    .filter((r) => r.count > 0)
    .map((r) => `${path.relative(cliRoot, r.f)}: ${r.hits.map((c) => 'U+' + c.toString(16).toUpperCase()).join(', ')}`);
  assert.deepEqual(bad, [], `colour emoji found in sources:\n  ${bad.join('\n  ')}`);
});

for (const bundle of ['ui-fb.mjs', 'ui.mjs']) {
  test(`${bundle} ships no colour-emoji glyphs`, () => {
    const file = path.join(cliRoot, bundle);
    assert.ok(fs.existsSync(file), `${bundle} is missing — run \`npm run build:ui\``);
    const { hits } = offendersIn(file);
    assert.deepEqual(
      hits.map((c) => 'U+' + c.toString(16).toUpperCase()),
      [],
      `${bundle} still encodes colour emoji — rebuild with \`npm run build:ui\``,
    );
  });
}
