'use strict';
/**
 * Parrot box sensors — the same real readings the Dell card shows, read over
 * the existing owner SSH alias (`parrot`) with a single read-only command.
 *
 * One SSH round trip per refresh, cached for 5 seconds, single-flight, and hard
 * bounded: if the box is asleep, on another network, or SSH is unavailable, the
 * card says so (`ok:false`) instead of showing stale numbers as if they were live.
 * Nothing on Parrot is changed — the command only reads /proc, free, loadavg and
 * `sensors -j` (never installs, restarts or writes anything).
 *
 * Parrot is a MacBook: CPU package temp comes from `coretemp`, the fan from the
 * `applesmc` Exhaust sensor, and battery temperature from `BAT0`.
 */

const { execFile } = require('child_process');

const SSH_ALIAS = process.env.PEER_SSH_ALIAS || 'parrot';
const TTL_MS = 5000;
const TIMEOUT_MS = 9000;

const REMOTE = [
  'L1=$(head -1 /proc/stat); sleep 0.4; L2=$(head -1 /proc/stat)',
  'echo "$L1"; echo "$L2"',
  'free -b | sed -n 2,3p',
  'cat /proc/loadavg',
  'sensors -j 2>/dev/null',
  'hostname',
].join('; ');

let cache = { at: 0, value: null, inflight: null };

function parseCpu(line1, line2) {
  const nums = (line) => String(line || '').trim().split(/\s+/).slice(1).map(Number);
  const a = nums(line1);
  const b = nums(line2);
  if (a.length < 4 || b.length < 4) return null;
  const totalA = a.reduce((x, y) => x + y, 0);
  const totalB = b.reduce((x, y) => x + y, 0);
  const dt = totalB - totalA;
  if (!(dt > 0)) return null;
  const idle = (b[3] + (b[4] || 0)) - (a[3] + (a[4] || 0)); // idle + iowait
  const iowait = (b[4] || 0) - (a[4] || 0);
  const busy = Math.max(0, Math.min(100, ((dt - idle) / dt) * 100));
  return { busyPct: Math.round(busy), iowaitPct: Math.round(Math.max(0, Math.min(100, (iowait / dt) * 100))) };
}

function parseMem(memLine, swapLine) {
  const col = (line) => String(line || '').trim().split(/\s+/).slice(1, 4).map(Number);
  const m = col(memLine);
  const s = col(swapLine);
  const out = {};
  if (m.length === 3 && m[0] > 0) {
    out.totalBytes = m[0];
    out.usedBytes = m[1];
    out.usedPct = Math.round((m[1] / m[0]) * 1000) / 10;
  }
  if (s.length === 3 && s[0] > 0) {
    out.swapTotalBytes = s[0];
    out.swapUsedBytes = s[1];
    out.swapUsedPct = Math.round((s[1] / s[0]) * 1000) / 10;
  }
  return out;
}

function parseSensors(json) {
  const out = { cpuC: null, fanRpm: null, batteryC: null, ambientC: null };
  let data;
  try { data = JSON.parse(json); } catch { return out; }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  const core = data['coretemp-isa-0000'];
  if (core) {
    const pkg = core['Package id 0'] || core['Package id 1'] || null;
    if (pkg) {
      out.cpuC = num(pkg.temp1_input);
      out.cpuMaxC = num(pkg.temp1_max);
    }
    if (out.cpuC == null) {
      const firstCore = Object.values(core).find((v) => v && v.temp1_input != null);
      if (firstCore) out.cpuC = num(firstCore.temp1_input);
    }
  }
  const smc = data['applesmc-isa-0300'] || data['applesmc-isa-0300'.replace('0300', '0300')];
  if (smc) {
    const fan = smc['Exhaust'] || Object.values(smc).find((v) => v && v.fan1_input != null);
    if (fan) {
      out.fanRpm = num(fan.fan1_input);
      out.fanMinRpm = num(fan.fan1_min);
      out.fanMaxRpm = num(fan.fan1_max);
    }
    if (smc.Ta0P) out.ambientC = num(smc.Ta0P.temp25_input);
  }
  const bat = data['BAT0-acpi-0'];
  if (bat && bat.temp) out.batteryC = num(bat.temp.temp1_input);
  return out;
}

function runSsh() {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_ALIAS, REMOTE], {
      timeout: TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    }, (err, stdout) => {
      const raw = String(stdout || '');
      const lines = raw.split('\n');
      const stats = lines.filter((l) => l.startsWith('cpu '));
      const memLine = lines.find((l) => l.startsWith('Mem:'));
      const swapLine = lines.find((l) => l.startsWith('Swap:'));
      const loadLine = lines.find((l) => /^\d+\.\d+ \d+\.\d+ \d+\.\d+/.test(l));
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');
      const sensorJson = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : '';
      const host = lines.filter((l) => /^[a-z0-9][a-z0-9-]*$/.test(l.trim())).pop() || SSH_ALIAS;

      if (err) {
        return resolve({
          ok: false,
          host: SSH_ALIAS,
          ms: Date.now() - started,
          at: new Date().toISOString(),
          error: String(err.message || 'ssh failed').split('\n')[0].slice(0, 200),
          cpu: null, mem: null, load: null, sensors: null,
        });
      }
      const cpu = parseCpu(stats[0], stats[1]);
      const mem = memLine ? parseMem(memLine, swapLine) : null;
      const load = loadLine ? loadLine.split(/\s+/).slice(0, 3).map(Number) : null;
      const sensors = sensorJson ? parseSensors(sensorJson) : null;
      resolve({
        ok: Boolean(cpu && mem),
        host: host.trim(),
        ms: Date.now() - started,
        at: new Date().toISOString(),
        cpu,
        mem,
        load: load ? { l1: load[0], l5: load[1], l15: load[2] } : null,
        sensors,
        error: cpu && mem ? '' : 'incomplete reading from Parrot',
      });
    });
  });
}

/** Cached (5s) single-flight snapshot of the Parrot box. */
async function snapshot(force = false) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < TTL_MS) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = runSsh().then((value) => {
    cache = { at: Date.now(), value, inflight: null };
    return value;
  }).catch((err) => {
    cache = { at: Date.now(), value: { ok: false, host: SSH_ALIAS, error: String(err.message || err).slice(0, 200) }, inflight: null };
    return cache.value;
  });
  return cache.inflight;
}

module.exports = { snapshot, SSH_ALIAS };
