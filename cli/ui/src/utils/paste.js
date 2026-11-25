/* Pasted bytes to text.
 *
 * Owner, 2026-11-25: "fix the copy & paste don't work ... in his cli". A paste
 * arrives as raw bytes from the terminal (bracketed paste wraps them, so
 * newlines are real newlines and not Enter presses). This turns those bytes into
 * the string the composer should insert:
 *
 *   - ANSI escape sequences are stripped — some terminals wrap the paste in
 *     colour, and a screenful of pasted `ls --color` output used to insert the
 *     escape bytes as if they were characters;
 *   - CRLF and lone CR become LF, so a paste from a Windows or HTTP source
 *     keeps its line breaks instead of collapsing;
 *   - everything else is kept exactly: a pasted code block stays a code block.
 *
 * The textarea's own paste handler drops every newline (that is what an
 * InputRenderable wants, and it is what used to make pasting a multi-line task
 * into the CLI produce one long line). The composer handles the paste itself
 * before the renderable sees it, using this function, and cancels the default.
 */

/** Strip the common CSI/OSC sequences a terminal may add around a paste. */
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Turn a PasteEvent (or a plain string / byte array) into insertable text. */
export function pasteText(event) {
  const raw = typeof event === 'string'
    ? event
    : typeof event?.text === 'string'
      ? event.text
      : Buffer.from(event?.bytes || []).toString('utf8');
  return String(raw || '')
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n');
}
