/* Where a live steer lands in the transcript.
 *
 * A steer is a message the operator types WHILE a run is streaming. The server
 * reads it inside the run and the TUI draws it where it landed — as one marker
 * round inside the assistant turn — so the answer that follows is written
 * underneath it.
 *
 * This used to be a separate `role: 'user'` turn appended after the assistant
 * turn. Because the assistant turn keeps streaming after the steer, the rest of
 * the answer was patched ABOVE that new turn: the newest row of the output panel
 * stayed the operator's line for the rest of the run, and every steer added one
 * more permanent block at the tail (owner, 2026-11-25: "when i send messeages
 * steer they dont clear and block my outputpanel").
 *
 * Kept out of the hook so the ordering rule can be asserted directly — it is
 * pure, and getting it wrong is only visible while a run is live.
 */

/** Apply one steer event to an assistant message, returning a new message.
 *
 *  - `text` is drawn as a marker round (`steer`) in the operator's colour.
 *  - a fresh empty round always ends the list, so the next token lands UNDER the
 *    marker instead of being written back inside it.
 *  - `supersede` retracts only the prose of the round that was being generated;
 *    completed rounds keep their text and tool rows (owner, 2026-11-24 — one
 *    answer, not an answer plus a correction).
 */
export function applySteer(message, text, supersede = false) {
  const m = message || {};
  const rounds = Array.isArray(m.rounds)
    ? m.rounds.map((r) => ({ ...r, tools: Array.isArray(r && r.tools) ? r.tools.slice() : [] }))
    : [];
  const cur = rounds[rounds.length - 1];
  if (supersede && cur) cur.text = '';
  const marker = String(text == null ? '' : text).trim();
  if (marker) rounds.push({ steer: marker, text: '', thinking: '', tools: [] });
  rounds.push({ text: '', thinking: '', tools: [] });
  return { ...m, rounds, text: rounds.map((r) => String((r && r.text) || '')).join('') };
}

export default applySteer;
