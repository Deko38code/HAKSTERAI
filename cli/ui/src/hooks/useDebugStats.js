import { useCallback, useEffect, useRef, useState } from 'react';
import process from 'node:process';
import { renderStats, lagStats, noteLag, resetMetrics } from '../utils/debug-metrics.js';

/* useDebugStats — what the debugger page shows, sampled only while it is open.
 *
 * Cost discipline is the whole point of this hook: a debugger that taxes the
 * thing it measures is useless. So:
 *
 *   - the page's own values refresh once a second (render + lag distributions,
 *     process memory, handle count);
 *   - the event-loop lag timer (50 ms) runs ONLY while `enabled` — closed page,
 *     no timer, no samples, no work;
 *   - the server's build state is polled every 2 s and only while open, using
 *     the same /api/version the dashboard banner reads.
 *
 * Every field is either a measured sample or a direct read of this process
 * (pid, rss, uptime, handle count). Nothing is inferred, and an empty buffer
 * reports null so the page prints "—" rather than a zero.
 */
const LAG_TICK_MS = 50;
const VERSION_POLL_MS = 2000;

function processSnapshot(startedAtMs) {
  let mem = null;
  try { mem = process.memoryUsage(); } catch { mem = null; }
  let handles = null;
  try {
    handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null;
  } catch { handles = null; }
  return {
    pid: process.pid,
    uptimeSec: Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)),
    rss: mem ? mem.rss : null,
    heapUsed: mem ? mem.heapUsed : null,
    heapTotal: mem ? mem.heapTotal : null,
    handles,
    node: process.version,
    bun: typeof process.versions.bun === 'string' ? process.versions.bun : '',
  };
}

export default function useDebugStats({ enabled = false, api = 'http://localhost:3579', refreshMs = 1000 } = {}) {
  const [snap, setSnap] = useState(null);
  const [version, setVersion] = useState(null);
  const [versionErr, setVersionErr] = useState(null);
  const openedAt = useRef(Date.now());

  const sample = useCallback(() => {
    setSnap({
      at: Date.now(),
      render: renderStats(),
      lag: lagStats(),
      proc: processSnapshot(openedAt.current),
    });
  }, []);

  // The page's numbers, once a second while it is open.
  useEffect(() => {
    if (!enabled) return undefined;
    openedAt.current = Date.now();
    sample();
    const id = setInterval(sample, Math.max(250, Number(refreshMs) || 1000));
    return () => clearInterval(id);
  }, [enabled, refreshMs, sample]);

  // Event-loop lag. This timer exists only when the page is open — that is the
  // rule that keeps the debugger from costing anything while it is closed.
  useEffect(() => {
    if (!enabled) return undefined;
    let expected = performance.now() + LAG_TICK_MS;
    const id = setInterval(() => {
      const now = performance.now();
      noteLag(Math.max(0, now - expected));
      expected = now + LAG_TICK_MS;
    }, LAG_TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // The server's own build state, the same payload the dashboard banner reads.
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(`${api}/api/version`, {
          signal: AbortSignal.timeout(3000),
          headers: { ...(process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {}) },
        });
        if (!r.ok) throw new Error(`version ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        setVersion(j);
        setVersionErr(null);
      } catch (e) {
        if (alive) setVersionErr((e && e.message) || 'unreachable');
      }
    };
    pull();
    const id = setInterval(pull, VERSION_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [enabled, api]);

  const reset = useCallback(() => {
    resetMetrics();
    openedAt.current = Date.now();
    sample();
  }, [sample]);

  return { snap, version, versionErr, reset };
}
