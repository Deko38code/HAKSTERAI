/* How many rows the composer's input needs for the draft it holds.
 *
 * Owner, 2026-11-25: "when i type needs to know when to go to new line not go
 * off the screen in input bar". The composer is a multi-line textarea now; this
 * is the pure measurement App uses to budget the rows it takes, so the transcript
 * gives back exactly what the input borrows and the bar still ends at the bottom
 * of the screen instead of floating in the middle.
 *
 * The count is a character estimate, not a font measurement: word wrap can put a
 * line one character earlier, so the textarea keeps its own internal scroll as
 * the backstop. The cap keeps a pasted novel from swallowing the transcript.
 */

/** Wrapped rows for `text` at `columns` wide, at most `maxRows`. */
export function visualRows(text, columns, maxRows = 6) {
  const cols = Math.max(1, Math.floor(Number(columns) || 1));
  const cap = Math.max(1, Math.floor(Number(maxRows) || 1));
  const lines = String(text == null ? '' : text).split('\n');
  let rows = 0;
  for (const line of lines) {
    rows += Math.max(1, Math.ceil(line.length / cols));
    if (rows >= cap) return cap;
  }
  return Math.max(1, rows);
}

/** The composer's total height: border 2 + input rows + ad row + hint row. */
export function composerRows(text, columns, maxRows = 6) {
  return 4 + visualRows(text, columns, maxRows);
}
