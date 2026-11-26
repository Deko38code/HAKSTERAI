/* How many rows the composer's input needs for the draft it holds.
 *
 * Owner, 2026-11-25: "when i type needs to know when to go to new line not go
 * off the screen in input bar". The composer is a multi-line textarea now; this
 * is the pure measurement App uses to budget the rows it takes, so the transcript
 * gives back exactly what the input borrows and the bar still ends at the bottom
 * of the screen instead of floating in the middle.
 *
 * Owner, 2026-11-26: "fix input bar when i type keeps glitching bad". The count
 * used to be `ceil(length / columns)` — a CHARACTER estimate — while the
 * textarea wraps on WORDS (`wrapMode="word"` in Composer.jsx). Word wrap needs
 * at least as many rows as character wrap whenever a break lands before the
 * column edge, so near every wrap boundary the box was allocated one row too
 * few, the textarea scrolled its own content to keep the caret visible, and the
 * top of the draft vanished out of the bar for a keystroke before snapping back
 * when the estimate caught up. Measured on the real renderer
 * (ui/__smoke__/wrap-probe.mjs) at 40/60/100 columns: the draft went off screen
 * on 3 of 26 typed chunks at 40 columns, worst 97 characters hidden.
 *
 * The count is now the wrapped rows the textarea actually draws, and it is
 * allowed to be generous: one spare row is invisible, one missing row is the
 * glitch. So a line needs at least the rows word wrap gives it AND at least the
 * rows character wrap gives it — never fewer than either.
 *
 * The cap keeps a pasted novel from swallowing the transcript; past the cap the
 * textarea keeps its own internal scroll as the backstop.
 */

/** Rows one logical line takes when wrapped on words at `cols` wide.
 *
 * Greedy, the way a terminal and the textarea both do it: fill a row until the
 * next word would overflow, break at the space, and character-break a single
 * word longer than the row.
 */
function wordRowsForLine(line, cols) {
  const words = String(line).split(' ');
  let rows = 1;
  let used = 0; // columns already taken on the current row
  for (const word of words) {
    const len = word.length;
    if (used === 0) {
      // First word on the row: it owns the row, char-breaking if it is longer.
      let rest = len;
      while (rest > cols) {
        rows += 1;
        rest -= cols;
      }
      used = rest;
    } else if (used + 1 + len <= cols) {
      used += 1 + len; // the space plus the word fits
    } else {
      // The word starts a new row, char-breaking if it is longer than one.
      rows += 1;
      let rest = len;
      while (rest > cols) {
        rows += 1;
        rest -= cols;
      }
      used = rest;
    }
  }
  return rows;
}

/** Wrapped rows for `text` at `columns` wide, at most `maxRows`.
 *
 * `columns` is the width the box gives the textarea; the textarea itself wraps
 * one column narrower, because the caret needs a cell at the end of the line it
 * is on. Measured on the real renderer at 40 columns: the box budgets 32 and the
 * text breaks at 31 — "keeps buffering on the firestick" (exactly 32) wraps,
 * while "logs and tell me why the stream" (30) does not. Same at 100 columns:
 * the box budgets 59, which is what an over-wide estimate would break at, and
 * the renderer's rows match 58.
 *
 * So the count is taken at `columns - 1`. That can only ever over-estimate by
 * one row, which is an invisible blank line; under-estimating is what scrolled
 * the draft out of the bar.
 */
export function visualRows(text, columns, maxRows = 6) {
  const cols = Math.max(1, Math.floor(Number(columns) || 1) - 1);
  const cap = Math.max(1, Math.floor(Number(maxRows) || 1));
  const lines = String(text == null ? '' : text).split('\n');
  let rows = 0;
  for (const line of lines) {
    const byWord = wordRowsForLine(line, cols);
    // Word wrap can consume the spaces it breaks on, so it is not guaranteed to
    // be the larger of the two; take the bigger so the box is never short.
    const byChar = Math.max(1, Math.ceil(line.length / cols));
    rows += Math.max(byWord, byChar);
    if (rows >= cap) return cap;
  }
  return Math.max(1, rows);
}

/** The composer's total height: border 2 + input rows + ad row + hint row. */
export function composerRows(text, columns, maxRows = 6) {
  return 4 + visualRows(text, columns, maxRows);
}
