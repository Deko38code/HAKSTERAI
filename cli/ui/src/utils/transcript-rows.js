/* Transcript row estimation.
 *
 * Kept out of the component because it is the one piece of the transcript with
 * arithmetic in it, and because getting it wrong is invisible: an over-estimate
 * only wastes a row, but an under-estimate lets Ink draw past the row budget and
 * push the status bar off the bottom of the terminal. A plain function can be
 * asserted against exactly that, which a rendered tree cannot.
 *
 * The estimate counts wrapped lines at a block's inner width. It deliberately
 * over-counts slightly (a wrapped word is charged a full row) rather than
 * under-counts, for the reason above.
 */

/** Rows that `text` occupies when wrapped into `inner` columns. */
export function wrappedRows(text, inner) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const cols = Math.max(1, inner);
  return s
    .split('\n')
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / cols)), 0);
}

/** Inner width of a bordered block: total width minus borders and padding. */
export function innerWidth(width, floor = 8) {
  return Math.max(floor, (width || 80) - 4);
}

/** Estimated rendered height of one MessageBlock, including its border rows. */
export function estimateRows(message, width) {
  if (!message) return 0;
  const inner = innerWidth(width);
  // A harness notice is a single bordered line, not a labelled box.
  if (message.role === 'system') return 1 + wrappedRows(message.text, inner - 2);

  let rows = 3; // top border, label row, bottom border
  rows += wrappedRows(message.thinking, inner);
  rows += wrappedRows(message.text, inner);
  const tools = Array.isArray(message.tools) ? message.tools : [];
  for (const tool of tools) {
    rows += 1;
    if (tool.result) rows += wrappedRows(String(tool.result).slice(0, 160), inner);
  }
  if (!message.text && !message.thinking && tools.length === 0) rows += 1; // the "thinking…" row
  return rows;
}

/**
 * The newest turns that fit in `budget` rows, plus how many were dropped.
 *
 * Returns `{ visible, hidden }`. At least one message is always returned even if
 * it alone overflows, because showing a truncated newest turn beats showing
 * nothing at all.
 */
export function fitTranscript(messages, width, budget) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Number(budget) || 20);
  const visible = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const rows = estimateRows(list[i], width) + 1; // +1 for the gap between blocks
    if (used + rows > limit && visible.length > 0) break;
    used += rows;
    visible.unshift(list[i]);
  }
  return { visible, hidden: list.length - visible.length, used };
}
