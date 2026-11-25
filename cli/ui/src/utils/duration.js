/* One way to print a measured duration, shared by every card that shows one.
 *
 * Owner, 2026-11-26: "add on hakster output card to HAKSTER-AI AND HIS TIME HE
 * TOOK TO RESPOND ON CARD". The answer card in the transcript and the ▶
 * Result / ▶ Output cards above the composer all state that number, so they
 * must format it identically — a second copy of this rule is how "6.2s" and
 * "6200ms" end up on the same screen.
 *
 * Sub-second reads in ms, everything else in tenths of a second; never a
 * fabricated precision, and never a number when nothing was measured (§10).
 */
export function fmtDur(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** ` · 6.2s` when there is a real measurement, else '' — for panel titles. */
export default function durSuffix(ms) {
  const n = Math.round(Number(ms) || 0);
  return n > 0 ? ` · ${fmtDur(n)}` : '';
}
