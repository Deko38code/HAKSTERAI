/* Panel scrolling + auto-compaction maths.
 *
 * Every panel in this TUI is a fixed-height window: the terminal grid is the
 * contract, so a panel that grows by a row pushes the status bar off the
 * bottom of the screen instead of scrolling. That means each panel needs the
 * same three things the owner asked for (2026-11-23, "make sure all the panels
 * have autoscroll and bars with arrows and auto compact"):
 *
 *   1. a follow-tail window — `offset === null` means "show the newest rows";
 *   2. one scrollbar column with ▲ / ▼ ends and a █ thumb — `gutterChar`;
 *   3. a compact rendering when the window or the terminal is short.
 *
 * The maths lives here, out of the components, because a wrong start/end is
 * silent rather than loud: the panel still draws, it just draws the wrong
 * rows. A plain function can be pinned by a unit test; a rendered tree cannot.
 */

/** The furthest start that still fills the window. */
export const maxStartOf = (total, rows) => {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  return Math.max(0, n - r);
};

/** Clamp a scroll offset. `null` (or anything non-numeric) means follow. */
export const clampStart = (offset, total, rows) =>
  offset == null ? maxStartOf(total, rows) : Math.max(0, Math.min(Math.trunc(Number(offset) || 0), maxStartOf(total, rows)));

/**
 * Move an offset by `delta` rows and hand the window back to auto-follow once
 * it reaches the bottom, so a live feed is never left behind by an old
 * position. `null` is the follow state and starts from the tail.
 */
export const stepOffset = (offset, total, rows, delta) => {
  const max = maxStartOf(total, rows);
  const base = offset == null ? max : Math.max(0, Math.min(Math.trunc(Number(offset) || 0), max));
  const next = Math.max(0, Math.min(max, base + Math.trunc(Number(delta) || 0)));
  return next >= max ? null : next;
};

/** True when the content does not fit and a scrollbar is needed. */
export const overflows = (total, rows) => Number(rows) > 0 && Number(total) > Number(rows);

/**
 * One cell of the scrollbar column.
 *
 * The ends are always ▲ and ▼ while the content overflows, so the bar reads as
 * a scrollbar at a glance (and a click/wheel has a target); the rows between
 * them are a █ thumb on a │ rail. When the content fits, callers hide the
 * column instead of drawing a bar that cannot move.
 */
export const gutterChar = (i, rows, total, start) => {
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  if (!overflows(n, r)) return '│';
  if (r <= 2) return '█';
  const row = Math.max(0, Math.min(r - 1, Math.trunc(Number(i) || 0)));
  if (row === 0) return '▲';
  if (row === r - 1) return '▼';
  const track = Math.max(1, r - 2);
  const thumb = Math.max(1, Math.min(track, Math.round((track * r) / Math.max(1, n))));
  const maxStart = Math.max(1, n - r);
  const pos = Math.max(0, Math.min(maxStart, Math.trunc(Number(start) || 0)));
  const top = Math.round((pos / maxStart) * Math.max(0, track - thumb));
  const at = row - 1;
  return at >= top && at < top + thumb ? '█' : '│';
};

/**
 * The title hint a scrolled panel shows: `3-8/21`, with a ⇣ when the window has
 * been parked above the tail. Short enough to sit beside a title at 30 cols.
 */
export const scrollHint = (total, rows, start, following = true) => {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  if (!overflows(n, r)) return String(n);
  // Label the window that is actually drawn. A panel following a selection
  // reports `following` even when the cursor sits at the top, so deriving the
  // numbers from "following" alone made the list read `22-27/27` above rows
  // 1-6. `start` is already resolved by the caller; ⇣ means parked above the
  // tail, and a window sitting on the tail has nothing below to point at.
  const s = clampStart(start, n, r);
  const parked = !following && s < maxStartOf(n, r);
  return `${s + 1}-${Math.min(n, s + r)}/${n}${parked ? ' ⇣' : ''}`;
};

/**
 * A window that keeps a selected row visible, centred where it fits — the
 * models picker and the catalog popout both open on a selection and move it
 * with ↑/↓, so their window has to follow the cursor rather than the tail.
 */
export const nearestStart = (selected, total, rows) => {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const r = Math.max(0, Math.trunc(Number(rows) || 0));
  if (!n || !r) return 0;
  const sel = Math.max(0, Math.min(n - 1, Math.trunc(Number(selected) || 0)));
  return Math.max(0, Math.min(sel - Math.floor(r / 2), maxStartOf(n, r)));
};

/** Modifiers a binding can require. `alt` arrives as `meta` in OpenTUI. */
export const BINDING_MODS = {
  none: {},
  shift: { shift: true },
  alt: { meta: true },
  ctrl: { ctrl: true },
};

/** Does this key event match `name` with the binding's modifier set? */
export const keyMatches = (key, name, mod = 'none') => {
  if (!key || key.name !== name) return false;
  const want = BINDING_MODS[mod] || {};
  return !!key.shift === !!want.shift && !!key.meta === !!want.meta && !!key.ctrl === !!want.ctrl;
};
