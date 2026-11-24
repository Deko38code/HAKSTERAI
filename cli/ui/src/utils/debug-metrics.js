/* debug-metrics — the measurements behind the debugger page (owner,
 * 2026-11-24: "add debugger to").
 *
 * Two numbers, both taken on the thread the dashboard itself runs on, so
 * neither can flatter the app by measuring a different process:
 *
 *   render — wall time from the start of App's render to the end of its commit
 *            (a layout effect). That span is where a re-render's cost actually
 *            is: the memo work, the transcript lay-out, the native tree update.
 *            Every render is sampled, because one slow frame is exactly what is
 *            being looked for; a sample is two numbers in a fixed ring buffer.
 *
 *   lag    — how late a 50 ms timer fires. Work that blocks the loop shows up
 *            here even when it is not App's own. Sampled ONLY while the
 *            debugger page is open: the hook starts the timer on open and
 *            stops it on close, so an idle TUI pays nothing for a closed page.
 *
 * Nothing is estimated. A percentile is computed from the samples it says it
 * has, and a figure with no samples is null, so the page prints "—" rather
 * than a zero the session never earned (§10).
 */
const RING = 240;
const RATE_WINDOW_MS = 2000;

const renders = []; // { t, ms } — newest last
let renderTotal = 0;
const lags = []; // { t, ms } — newest last
let lagTotal = 0;

/** Marks the start of a render. Returns the timestamp to hand back at commit. */
export const noteRenderStart = () => {
  renderTotal += 1;
  return performance.now();
};

/** Records one render's render→commit time. */
export const noteRenderEnd = (t0) => {
  if (!Number.isFinite(t0)) return;
  const ms = Math.max(0, performance.now() - t0);
  renders.push({ t: Date.now(), ms });
  if (renders.length > RING) renders.shift();
};

/** Records one event-loop lag sample in milliseconds. */
export const noteLag = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return;
  lagTotal += 1;
  lags.push({ t: Date.now(), ms: n });
  if (lags.length > RING) lags.shift();
};

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at];
};

const summarize = (samples) => {
  const values = samples.map((s) => s.ms).sort((a, b) => a - b);
  if (!values.length) {
    return { samples: 0, last: null, p50: null, p95: null, max: null };
  }
  return {
    samples: values.length,
    // "last" is the most recent in time, not the largest — a percentile sort
    // loses ordering, so read it off the ring before sorting.
    last: samples[samples.length - 1].ms,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values[values.length - 1],
  };
};

/** Render cost: the distribution plus how often App is re-rendering right now. */
export const renderStats = () => {
  const now = Date.now();
  const recent = renders.filter((r) => now - r.t <= RATE_WINDOW_MS).length;
  const span = renders.length ? Math.min(RATE_WINDOW_MS, Math.max(1, now - renders[0].t)) : 0;
  return {
    total: renderTotal,
    ...summarize(renders),
    // Renders per second over the same 2 s window the count came from; null
    // until there is a window to divide by.
    perSec: span > 0 ? (recent / (span / 1000)) : null,
    windowMs: renders.length ? now - renders[0].t : 0,
  };
};

/** Event-loop lag: how late the 50 ms timer actually fired. */
export const lagStats = () => ({ total: lagTotal, ...summarize(lags) });

/** Zeroes both buffers. The debugger page's `r`; nothing else calls this. */
export const resetMetrics = () => {
  renders.length = 0;
  lags.length = 0;
  renderTotal = 0;
  lagTotal = 0;
};
