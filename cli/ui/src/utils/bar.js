/* bar.js — the rich progress bar every reading in the TUI is drawn with.
 *
 * Owner, 2026-11-25: "with cpu and ram can you add bars that go with the % next
 * to them up top with other 1 on right side" and then "see if you can find some
 * nice bars that look rich not generic".
 *
 * The obvious bar — `██░░` — is what every CLI draws, and at four cells it can
 * only be right in 25 % steps. This one is the same solid block for the part
 * that is used, ends on an eighth-block head so the fill is accurate to 1/8 of
 * a cell, and sets the unused part on a light dashed rule instead of a second
 * block, so the bar reads as a gauge with a track rather than a strip of two
 * colours. The percentage beside it is the exact number; the bar is the shape
 * of it, and the two can never disagree because both come from the same value.
 *
 *   ███▋╌    62 %   (three full cells, a 5/8 head, one empty cell)
 *   ╌╌╌╌╌     0 %   (unmeasured or zero — the track alone)
 *   █████   100 %
 *
 * `pct == null` (no measurement yet) returns null rather than an empty bar:
 * an empty bar reads as 0 %, which is a different, and false, statement.
 */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const FULL = '█'; // █
const TRACK = '╌'; // ╌ light dashed rule

/**
 * The parts of a bar, ready to drop into a <text> row.
 *
 * @param {number|null} pct   0–100, or null/undefined for "not measured"
 * @param {number} width      cells, minimum 2
 * @param {string} fg         colour of the filled part (the reading's own heat)
 * @param {string} trackFg    colour of the unused track
 * @returns {Array<{t: string, fg: string}>|null}
 */
export function richBar(pct, width = 5, fg = 'green', trackFg = 'gray') {
  const v = pct == null ? null : Number(pct);
  if (v == null || !Number.isFinite(v)) return null;
  const w = Math.max(2, Math.round(Number(width) || 5));
  const cells = (Math.max(0, Math.min(100, v)) / 100) * w;
  const full = Math.min(w, Math.floor(cells));
  const rem = cells - full;
  // The head is the partial cell, in eighths. A fill that rounds up to a whole
  // cell is drawn as that cell instead of a head one eighth past the end, so
  // the bar never ends on a head it has already passed.
  const eighth = rem > 0 ? Math.round(rem * 8) : 0;
  let filled = full;
  let headCell = '';
  if (eighth >= 8) filled = Math.min(w, full + 1);
  else if (eighth > 0) headCell = EIGHTHS[eighth];
  const empty = Math.max(0, w - filled - (headCell ? 1 : 0));
  const parts = [];
  if (filled) parts.push({ t: FULL.repeat(filled), fg });
  if (headCell) parts.push({ t: headCell, fg });
  if (empty) parts.push({ t: TRACK.repeat(empty), fg: trackFg });
  return parts;
}

export default richBar;
