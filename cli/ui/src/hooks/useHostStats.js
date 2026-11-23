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

export default function useHostStats(intervalMs = 5000) {
  const [stats, setStats] = useState(null);
  const prevRef = useRef(null);

  useEffect(() => {
    const cores = Math.max(1, (os.cpus() || []).length);
    const sample = () => {
      const now = cpuTimes();
      let cpuPct = null;
      const prev = prevRef.current;
      if (now && prev && now.total > prev.total) {
        const dt = now.total - prev.total;
        const idleDelta = now.idle - prev.idle;
        cpuPct = Math.max(0, Math.min(100, Math.round((1 - idleDelta / dt) * 100)));
      }
      if (now) prevRef.current = now;

      const mi = meminfo();
      const memTotal = mi.MemTotal || os.totalmem();
      const memAvail = mi.MemAvailable != null ? mi.MemAvailable : os.freemem();
      const swapTotal = mi.SwapTotal || 0;
      const swapFree = mi.SwapFree || 0;
      const d = disk();

      setStats({
        cores,
        cpuPct,
        load1: Math.round(((os.loadavg() || [0])[0] || 0) * 100) / 100,
        memPct: memTotal ? Math.max(0, Math.min(100, Math.round((1 - memAvail / memTotal) * 100))) : null,
        memUsedGb: memTotal ? (memTotal - memAvail) / 1e9 : null,
        memTotalGb: memTotal ? memTotal / 1e9 : null,
        swapPct: swapTotal ? Math.max(0, Math.min(100, Math.round((1 - swapFree / swapTotal) * 100))) : null,
        swapUsedMb: swapTotal ? Math.round((swapTotal - swapFree) / 1e6) : null,
        swapTotalMb: swapTotal ? Math.round(swapTotal / 1e6) : null,
        diskPct: d ? d.pct : null,
        diskFreeGb: d ? d.free / 1e9 : null,
        diskTotalGb: d ? d.total / 1e9 : null,
        uptimeS: Math.round(os.uptime()),
      });
    };

    sample();                        // priming read
    const warm = setTimeout(sample, 800); // second read: the first cpu delta
    const t = setInterval(sample, intervalMs);
    return () => {
      clearTimeout(warm);
      clearInterval(t);
    };
  }, [intervalMs]);

  return stats;
}
