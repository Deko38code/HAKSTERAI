import { useEffect, useRef, useState } from 'react';
import os from 'node:os';
import fs from 'node:fs';

/* useHostStats — the machine the CLI is running on, read in-process.
 *
 * The owner asked why the CLI is "not checking cpu etc". The old CLI printed a
 * host line under its tables (cpu / ram / swap / disk); this hook is the data
 * behind the new one. Nothing here shells out — every value is a direct read of
 * the kernel's own counters, so sampling costs no subprocess and no `du` scan:
 *
 *   cpu%    /proc/stat deltas between samples (null until a second sample)
 *   ram     MemTotal vs MemAvailable from /proc/meminfo
 *   swap    SwapTotal vs SwapFree — headroom is reported, never changed
 *   disk    statfs('/'): free / total
 *   load    1-minute load average, against the core count
 *
 * If a read fails the field is null and the caller shows '—'; nothing is
 * guessed, and a missing sample never throws into the render path.
 *
 * Owner (2026-11-25): "make sure the cpu ram meters run smoothly in cli with
 * nice refresh rate but not make lagg". Three things make that work:
 *
 *   1. A tick is a handful of tiny reads — /proc/stat every tick, /proc/meminfo
 *      a fifth as often, statfs('/') a tenth — so 1 Hz costs microseconds, not
 *      a render's worth of work.
 *   2. cpu% is an exponential moving average of the raw delta, so the number
 *      glides instead of stepping: ~half of each new sample lands per tick.
 *   3. State is published only when a value a meter actually shows changes.
 *      An idle box repaints nothing, which is what keeps a faster refresh from
 *      turning into lag (the transcript is memoised, so a host tick only
 *      re-renders the header when it truly has something new).
 */
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};

function cpuTimes() {
  const line = (readText('/proc/stat').split('\n')[0] || '').trim();
  if (!line.startsWith('cpu')) return null;
  const n = line.split(/\s+/).slice(1).map(Number);
  if (!n.length || n.some((x) => !Number.isFinite(x))) return null;
  // idle + iowait count as idle time; everything else is work.
  const idle = (n[3] || 0) + (n[4] || 0);
  const total = n.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function meminfo() {
  const out = {};
  for (const line of readText('/proc/meminfo').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

function disk() {
  try {
    const s = fs.statfsSync('/');
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, free, pct: Math.round((1 - free / total) * 100) };
  } catch {
    return null;
  }
}

// What a meter can actually show. If none of these moved, the sample is not
// worth a re-render.
const shown = (s) => [
  s.cpuPct,
  s.memPct,
  s.swapPct,
  s.diskPct,
  s.load1,
  s.memUsedGb,
  s.swapUsedMb,
  s.diskFreeGb,
  Math.floor((s.uptimeS || 0) / 60),
].join('|');

export default function useHostStats(intervalMs = 1000) {
  const [stats, setStats] = useState(null);
  const prevRef = useRef(null);     // previous /proc/stat counters
  const smoothRef = useRef(null);   // cpu% after smoothing
  const memRef = useRef(null);      // last meminfo read
  const diskRef = useRef(null);     // last statfs read
  const pubRef = useRef('');        // what is on screen right now
  const tickRef = useRef(0);

  useEffect(() => {
    const cores = Math.max(1, (os.cpus() || []).length);

    const sample = () => {
      const tick = (tickRef.current += 1);

      const now = cpuTimes();
      let cpuRaw = null;
      const prev = prevRef.current;
      if (now && prev && now.total > prev.total) {
        const dt = now.total - prev.total;
        const idleDelta = now.idle - prev.idle;
        cpuRaw = Math.max(0, Math.min(100, (1 - idleDelta / dt) * 100));
      }
      if (now) prevRef.current = now;
      // Glide: half the new sample per tick. Only the published integer is
      // rounded, so a one-core blip does not flash a red 100%.
      if (cpuRaw != null) {
        smoothRef.current = smoothRef.current == null
          ? cpuRaw
          : smoothRef.current * 0.55 + cpuRaw * 0.45;
      }
      const cpuPct = smoothRef.current == null ? null : Math.round(smoothRef.current);

      // The bigger reads happen less often; between them the last value holds.
      if (tick === 1 || tick % 5 === 0) memRef.current = meminfo();
      if (tick === 1 || tick % 10 === 0) diskRef.current = disk();

      const mi = memRef.current || {};
      const memTotal = mi.MemTotal || os.totalmem();
      const memAvail = mi.MemAvailable != null ? mi.MemAvailable : os.freemem();
      const swapTotal = mi.SwapTotal || 0;
      const swapFree = mi.SwapFree || 0;
      const d = diskRef.current;

      const next = {
        cores,
        cpuPct,
        load1: Math.round(((os.loadavg() || [0])[0] || 0) * 100) / 100,
        memPct: memTotal ? Math.max(0, Math.min(100, Math.round((1 - memAvail / memTotal) * 100))) : null,
        memUsedGb: memTotal ? Math.round(((memTotal - memAvail) / 1e9) * 10) / 10 : null,
        memTotalGb: memTotal ? memTotal / 1e9 : null,
        swapPct: swapTotal ? Math.max(0, Math.min(100, Math.round((1 - swapFree / swapTotal) * 100))) : null,
        swapUsedMb: swapTotal ? Math.round((swapTotal - swapFree) / 1e6) : null,
        swapTotalMb: swapTotal ? Math.round(swapTotal / 1e6) : null,
        diskPct: d ? d.pct : null,
        diskFreeGb: d ? Math.round((d.free / 1e9) * 10) / 10 : null,
        diskTotalGb: d ? d.total / 1e9 : null,
        uptimeS: Math.round(os.uptime()),
      };

      const key = shown(next);
      if (key === pubRef.current) return; // nothing on screen moved
      pubRef.current = key;
      setStats(next);
    };

    sample();                                // priming read
    // Second read inside the first tick: without a previous counter there is
    // no cpu delta, so the meter would sit on '—' until the next full second.
    const warm = setTimeout(sample, Math.min(600, Math.max(200, Math.round(intervalMs / 4))));
    const t = setInterval(sample, intervalMs);
    // Timer housekeeping must never hold the process open by itself.
    try {
      if (typeof warm.unref === 'function') warm.unref();
      if (typeof t.unref === 'function') t.unref();
    } catch {
      /* ignore */
    }
    return () => {
      clearTimeout(warm);
      clearInterval(t);
    };
  }, [intervalMs]);

  return stats;
}
