/* The composer wraps, pastes and copies — and the bar stays at the bottom.
 *
 * Owner, 2026-11-25:
 *   "fix the input bar to always on startup be at bottom not in the middle so
 *    output panels can have space"
 *   "when i type needs to know when to go to new line not go off the screen in
 *    input bar"
 *   "fix the copy & paste don't work" / "in his cli"
 *
 * Three things are pinned here:
 *   1. the row maths the composer and the layout budget both use (pure, tested
 *      directly);
 *   2. pasted bytes survive to the draft with their newlines and without the
 *      terminal's ANSI colour;
 *   3. the wiring that makes the three fixes real — a wrapping textarea with
 *      Enter=send / Shift+Enter=newline, a paste handler that runs before the
 *      textarea's newline-stripping one, Ctrl+C copying a selection instead of
 *      quitting, and a transcript that grows into the leftover rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visualRows, composerRows } from '../src/utils/wrap.js';
import { pasteText } from '../src/utils/paste.js';

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(uiRoot, rel), 'utf8');
const composer = read('src/components/Composer.jsx');
const app = read('src/App.jsx');
const transcript = read('src/components/Transcript.jsx');

test('an empty draft needs one input row; a wrapped one needs more', () => {
  assert.equal(visualRows('', 40), 1);
  assert.equal(visualRows('short', 40), 1);
  assert.equal(visualRows('x'.repeat(80), 40), 2);
  assert.equal(visualRows('x'.repeat(40), 40), 1, 'exactly full is still one row');
  assert.equal(visualRows('x'.repeat(41), 40), 2);
});

test('every newline is a row, even an empty one', () => {
  assert.equal(visualRows('a\nb\nc', 40), 3);
  assert.equal(visualRows('a\n\nb', 40), 3);
  assert.equal(visualRows('a\n' + 'x'.repeat(80), 40), 3);
});

test('the cap wins — a pasted novel cannot swallow the transcript', () => {
  assert.equal(visualRows(Array.from({ length: 50 }, () => 'line').join('\n'), 40), 6);
  assert.equal(visualRows('x'.repeat(1000), 40, 6), 6);
  assert.equal(visualRows('x'.repeat(1000), 40, 3), 3);
});

test('the composer height is its chrome plus its wrapped input rows', () => {
  // border top + bottom (2) + ad row (1) + hint row (1)
  assert.equal(composerRows('', 40), 5);
  assert.equal(composerRows('hello', 40), 5);
  assert.equal(composerRows('a\nb', 40), 6);
  assert.equal(composerRows('x'.repeat(200), 40, 6), 9);
});

test('a paste keeps its newlines and loses the terminal colour', () => {
  assert.equal(pasteText({ text: 'one\ntwo' }), 'one\ntwo');
  assert.equal(pasteText('a\r\nb'), 'a\nb');
  assert.equal(pasteText('a\rb'), 'a\nb');
  assert.equal(pasteText('\x1b[32mgreen\x1b[0m\ntext'), 'green\ntext');
  assert.equal(pasteText({ bytes: Buffer.from('x\ny', 'utf8') }), 'x\ny');
  assert.equal(pasteText(null), '');
});

test('the editing surface is a wrapping textarea, Enter sends, Shift+Enter breaks', () => {
  assert.ok(composer.includes('<textarea'), 'the draft is a textarea, not a one-line input');
  assert.ok(composer.includes('wrapMode="word"'), 'word wrap, so a long draft never runs off the edge');
  assert.ok(composer.includes("{ name: 'return', action: 'submit' }"), 'Enter sends');
  assert.ok(composer.includes("{ name: 'return', shift: true, action: 'newline' }"), 'Shift+Enter is the newline');
  assert.ok(composer.includes("{ name: 'return', meta: true, action: 'newline' }"), 'Alt+Enter too — terminals that do not report Shift+Enter still send this');
  assert.ok(composer.includes("{ name: 'linefeed', action: 'newline' }"), 'and Ctrl+J (linefeed) always arrives distinctly');
  assert.ok(composer.includes('visualRows(value, inputWidth'), 'its height follows the wrapped rows');
});

test('the paste handler runs before the textarea handler and cancels it', () => {
  assert.ok(composer.includes('usePaste('), 'the composer listens for paste');
  assert.ok(composer.includes('event.preventDefault()'), 'and cancels the newline-stripping default');
  assert.ok(composer.includes('insertText(text)'), 'inserting what was pasted');
  assert.ok(composer.includes("onChange(el.plainText)"), 'and reporting it to the draft');
});

test('Ctrl+C copies a selection, and only quits with nothing selected', () => {
  assert.ok(app.includes('renderer.hasSelection'), 'checks for a selection first');
  assert.ok(app.includes('copyToClipboardOSC52'), 'hands the text to the terminal clipboard');
  assert.ok(app.includes('clearSelection()'), 'clears it after copying');
  // The quit path is still there, after the copy attempt.
  const start = app.indexOf("key.ctrl && key.name === 'c'");
  const ctrlC = app.slice(start, start + 1200);
  assert.ok(ctrlC.includes('agent.abort()'), 'no selection still quits');
  assert.ok(ctrlC.indexOf('copyToClipboardOSC52') < ctrlC.indexOf('agent.abort()'), 'copy is tried first');
});

test('the composer budget and the drawn box use one measurement', () => {
  assert.ok(app.includes("import { composerRows as composerHeight } from './utils/wrap.js'"));
  assert.ok(app.includes('composerHeight(draft, composerInputW'), 'the budget follows the real draft');
  assert.ok(composer.includes("import { visualRows } from '../utils/wrap.js'"), 'the box uses the same function');
});

test('the transcript claims leftover rows so the input bar sits on the bottom', () => {
  assert.ok(app.includes('flexGrow: 1, flexShrink: 0, overflow'), 'the transcript wrapper grows');
  assert.ok(app.includes('\n                grow\n'), 'and the Transcript is told to grow');
  assert.ok(transcript.includes("grow = false"), 'Transcript takes the flag');
  assert.ok(transcript.includes('flexGrow: 1, flexShrink: 0, minHeight: budget'), 'never shorter than its budget');
  assert.ok(transcript.includes('const frame = grow'), 'both the empty and populated states use it');
});
