'use strict';
/**
 * Real hardware readings for the owner dashboard.
 *
 * CPU utilisation comes from /proc/stat (a short sample, not a guess), memory
 * from /proc/meminfo, and temperatures/fan from lm-sensors (`sensors -j`).
 * Nothing here is synthesised: if a sensor is missing, the field is null and
 * the UI says "no sensor" rather than showing a made-up number.
 *
 * The sensors call is cached for a few seconds because the dashboard refreshes
 * on a one-second beat and `sensors` spawns a process each time.
 */

const fs = require('fs');
const { execFile } = require('child_process');

const SENSORS_TTL_MS = 4000;
let sensorsCache = { at: 0, value: null, inflight: null };
let lastCpuSample = null;

function readCpuTimes() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n').find(l => l.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
    const idleAll = (idle || 0) + (iowait || 0);
    const total = (user || 0) + (nice || 0) + (system || 0) + idleAll + (irq || 0) + (softirq || 0) + (steal || 0);
    return { total, idle: idleAll, iowait: iowait || 0 };
  } catch {
    return null;
  }
}

/**
 * CPU busy percentage over a real sample window (default 250 ms) using the
 * running process's own last sample, so back-to-back dashboard refreshes still
 * produce a meaningful delta. Returns null when /proc/stat is unreadable.
 */
async function cpuSnapshot(sampleMs = 250) {
  const first = readCpuTimes();
  if (!first) return null;
  const previous = lastCpuSample;
  const wait = Math.max(120, Math.min(1000, Number(sampleMs) || 250));
  await new Promise(resolve => setTimeout(resolve, wait));
  const second = readCpuTimes();
  if (!second) return null;
  lastCpuSample = second;
  const base = previous || first;
  const totalDelta = second.total - base.total;
  const idleDelta = second.idle - base.idle;
  if (totalDelta <= 0) return null;
  const busyPct = Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
  const iowaitPct = Math.round(((second.iowait - base.iowait) / totalDelta) * 100);
  return {
    busyPct: Math.max(0, Math.min(100, busyPct)),
    idlePct: Math.max(0, Math.min(100, 100 - busyPct)),
    iowaitPct: Math.max(0, Math.min(100, iowaitPct)),
    sampleMs: wait,
  };
}

/** Memory numbers straight from /proc/meminfo (KiB → bytes). */
function memorySnapshot() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => {
      const m = meminfo.match(new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm'));
      return m ? Number(m[1]) * 1024 : 0;
    };
    const total = kb('MemTotal');
    const available = kb('MemAvailable') || kb('MemFree');
    const used = Math.max(0, total - available);
    const swapTotal = kb('SwapTotal');
    const swapFree = kb('SwapFree');
    const swapUsed = Math.max(0, swapTotal - swapFree);
    return {
      totalBytes: total,
      availableBytes: available,
      usedBytes: used,
      usedPct: total ? Math.round((used / total) * 100) : null,
      swap: {
        totalBytes: swapTotal,
        usedBytes: swapUsed,
        usedPct: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : null,
      },
    };
  } catch {
    return null;
  }
}

function runSensors() {
  return new Promise((resolve) => {
    execFile('sensors', ['-j'], { timeout: 4000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Pull the named readings out of lm-sensors' JSON, without inventing any. */
function reduceSensors(json) {
  if (!json || typeof json !== 'object') return null;
  const out = {
    cpuC: null,
    ramC: null,
    ambientC: null,
    fanRpm: null,
    other: [],
    chip: null,
  };
  // Read the laptop's own SMM chip first: dell_smm is the only chip on this
  // class of machine that carries the fan, SODIMM and ambient sensors.
  // coretemp/k10temp carry CPU cores only. Every chip is scanned (no early
  // break) so the fan and RAM readings are not lost to a CPU-only chip
  // winning the old "first chip with a temperature" race.
  const RANK = [/dell_smm/i, /coretemp|k10temp|cpu_thermal|acpitz/i];
  const rank = (name) => {
    const i = RANK.findIndex((re) => re.test(name));
    return i === -1 ? RANK.length : i;
  };
  const order = Object.keys(json).map((name, i) => ({ name, i }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i)
    .map((e) => e.name);
  for (const chipName of order) {
    const chip = json[chipName];
    if (!chip || typeof chip !== 'object') continue;
    for (const [label, readings] of Object.entries(chip)) {
      if (!readings || typeof readings !== 'object') continue;
      const tempEntry = Object.entries(readings).find(([k]) => /^temp\d+_input$/.test(k));
      const fanEntry = Object.entries(readings).find(([k]) => /^fan\d+_input$/.test(k));
      const temp = tempEntry ? Number(tempEntry[1]) : null;
      const fan = fanEntry ? Number(fanEntry[1]) : null;
      if (fan != null && Number.isFinite(fan) && fan > 0 && out.fanRpm == null) out.fanRpm = Math.round(fan);
      if (temp == null || !Number.isFinite(temp) || temp <= 0) continue;
      const l = String(label).toLowerCase();
      if (/cpu|core|package|tdie|tctl/.test(l) && out.cpuC == null) out.cpuC = Math.round(temp);
      else if (/sodimm|dimm|ram|mem/.test(l) && out.ramC == null) out.ramC = Math.round(temp);
      else if (/ambient|board|mainboard/.test(l) && out.ambientC == null) out.ambientC = Math.round(temp);
      else out.other.push({ label: String(label), c: Math.round(temp), chip: String(chipName) });
      if (out.cpuC != null || out.ramC != null) {
        if (!out.chip) out.chip = String(chipName);
      }
    }
  }
  if (!out.cpuC && !out.ramC && !out.fanRpm && !out.other.length) return null;
  return out;
}

/** Cached hardware readings (temperatures + fan). */
async function sensorSnapshot() {
  const now = Date.now();
  if (sensorsCache.value && now - sensorsCache.at < SENSORS_TTL_MS) return sensorsCache.value;
  if (sensorsCache.inflight) return sensorsCache.inflight;
  sensorsCache.inflight = (async () => {
    const value = reduceSensors(await runSensors());
    sensorsCache = { at: Date.now(), value, inflight: null };
    return value;
  })();
  return sensorsCache.inflight;
}

module.exports = { cpuSnapshot, memorySnapshot, sensorSnapshot };
