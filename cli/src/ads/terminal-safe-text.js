'use strict';
/* ════════════════════════════════════════════════════════════════════════
 * Terminal-safe text — normalize anything a remote party wrote before a
 * terminal UI draws it: ad creative, server notices, error strings.
 *
 * A terminal interprets BYTES, not strings. Text that reaches it with an ESC
 * or C1 control intact can:
 *   - write the user's clipboard   (OSC 52)
 *   - draw a link whose visible text is not its target (OSC 8)
 *   - move the cursor and repaint other parts of the screen (CSI)
 *   - retitle the window, or flip text direction so a reviewer and the user
 *     read different words (bidi controls)
 * Ink does not filter these, so every such string is cleaned before it is drawn.
 *
 * PORTED FROM: CodebuffAI/freebuff `common/src/util/terminal-safe-text.ts`
 * (Apache-2.0). See ATTRIBUTION.md in this directory. Changes: TypeScript ->
 * CommonJS, and `sanitizeTerminalStrings` (the deep-object walk) is kept but
 * narrowed to plain objects/arrays.
 * ════════════════════════════════════════════════════════════════════════ */

const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const STRING_COMMAND = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x07|\x9c|$)/g;
const SHORT_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
/* C0 except \n, DEL, and C1. \t and \r are normalized before this runs. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/* Unicode Default_Ignorable_Code_Point: invisible, so it can split a
 * prohibited word or change how text reads without changing what a reviewer
 * sees. Listed explicitly rather than via a runtime Unicode table so the
 * result is deterministic across Node versions. */
const DEFAULT_IGNORABLE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;

/**
 * Strip every escape sequence (OSC, DCS/SOS/PM/APC, CSI, short ESC, 7- and
 * 8-bit forms), every other C0/C1 control, and the invisible Unicode
 * formatting characters.
 *
 * Newlines survive (CR and CRLF become \n); a tab becomes two spaces.
 * Printable text is otherwise unchanged and NOT trimmed, so indentation in a
 * code sample keeps its shape.
 */
function sanitizeTerminalText(input) {
  if (typeof input !== 'string' || input === '') return typeof input === 'string' ? input : '';
  return input
    .replace(OSC, '')
    .replace(STRING_COMMAND, '')
    .replace(CSI, '')
    .replace(SHORT_ESCAPE, '')
    .replace(DEFAULT_IGNORABLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROL, '');
}

/**
 * {@link sanitizeTerminalText} for captured process output (a tool's stdout, a
 * file the agent read) before a TUI draws it. That output is as untrusted as
 * any server string: a repo's test script or a fetched page can print OSC 52.
 *
 * One difference: a bare \r is a progress bar redrawing its line, not a line
 * break, so only the text after the last \r on each line survives — what a
 * real terminal would actually show — instead of one line per redraw.
 */
function sanitizeTerminalOutput(input) {
  if (typeof input !== 'string' || input === '') return input;
  const collapsed = input.includes('\r')
    ? input
        .replace(/\r+\n/g, '\n')
        .split('\n')
        .map((line) => line.slice(line.lastIndexOf('\r') + 1))
        .join('\n')
    : input;
  return sanitizeTerminalText(collapsed);
}

/**
 * Sanitize every string field of a payload (an ad, a server notice) so a
 * caller can hand a whole object to the renderer. Also guards the two escape
 * hatches an attacker controls: object keys are sanitized, and `__proto__` is
 * dropped rather than assigned, so a crafted payload cannot pollute prototypes.
 */
function sanitizeTerminalStrings(value, seen = new WeakSet()) {
  if (typeof value === 'string') return sanitizeTerminalText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => sanitizeTerminalStrings(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const clean = sanitizeTerminalStrings(v, seen);
    if (clean !== undefined) out[sanitizeTerminalText(k)] = clean;
  }
  return out;
}

module.exports = {
  sanitizeTerminalText,
  sanitizeTerminalOutput,
  sanitizeTerminalStrings,
  // exported for tests
  _patterns: { CSI, OSC, STRING_COMMAND, SHORT_ESCAPE, CONTROL, DEFAULT_IGNORABLE },
};
