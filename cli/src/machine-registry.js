/* machine-registry.js — put this box in the admin, under the account it signs in as.
 *
 * Owner, 2026-11-26: "make sure you add my box in admin to my enterprise plan owner".
 * The admin already keeps a device list per account (`user_devices`, shown as
 * "Latest device" on /admin/users and via GET /api/users/:id), but only the web
 * client ever wrote to it — the browser posts /api/client-context. A CLI box
 * therefore never appeared in the admin at all, on any plan.
 *
 * So every CLI start registers the machine it is running on:
 *   POST <server>/api/client-context  { x-api-key: <the signed-in key> }
 * and the server files the row against that key's account. Nothing new is
 * invented server-side: the same route, the same table, the same fingerprint
 * rule, and the account's own plan/role is whatever it already is — his owner
 * account is enterprise + admin, so his box shows up there.
 *
 * What is sent is measured from this machine (`os`), never guessed: hostname,
 * platform, kernel release, cores, RAM, timezone, arch. Screen size and browser
 * are browser-only facts, so they are left null rather than filled in.
 *
 * Rules this respects:
 *  - §23/§31: the API key travels in a request header, is never printed, logged,
 *    put in argv or written anywhere.
 *  - §10/§13/§50.1: a failure is silent to the operator (the CLI must still
 *    start) but is reported honestly by the register function's return value.
 *  - §22/§19.3/§26: nothing here touches a model, route, provider, rate or plan.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAMP_TTL_MS = 6 * 60 * 60 * 1000; // re-announce at most every 6 h

function configDir() {
  // HAKSTER_MACHINE_REG_DIR exists so a test can keep its stamp out of the
  // operator's real ~/.hakster; production always uses the config dir.
  return process.env.HAKSTER_MACHINE_REG_DIR || path.join(os.homedir(), '.hakster');
}

function stampPath() {
  return path.join(configDir(), 'machine-reg.json');
}

function osNameFromPlatform(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'freebsd') return 'FreeBSD';
  return platform || 'unknown';
}

/** A stable, filesystem-safe session id per machine (the server keys contexts by it). */
function machineSessionId(hostname) {
  const slug = String(hostname || 'box')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'box';
  return `cli-${slug}`;
}

/** The measured profile of this machine. No browser-only field is invented. */
function machineProfile({ version = '', hostname } = {}) {
  const host = hostname || os.hostname();
  const platform = process.platform;
  let timezone = null;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* older node */ }
  return {
    session_id: machineSessionId(host),
    platform,
    os_name: osNameFromPlatform(platform),
    os_version: os.release() || null,
    device_type: 'desktop',
    device_model: host,
    cores: Array.isArray(os.cpus()) ? os.cpus().length : null,
    memory_gb: Math.round(os.totalmem() / 1073741824) || null,
    timezone,
    engine: 'hakster-cli',
    engine_version: version || null,
    user_agent: `hakster-cli/${version || '0'} (${platform}; ${os.release()}; ${os.arch()})`,
  };
}

/** A short digest of the profile + account, so an unchanged box is not re-POSTed. */
function profileDigest(profile, userKeyTail) {
  return crypto
    .createHash('sha256')
    .update([profile.device_model, profile.os_name, profile.os_version, profile.cores, profile.memory_gb, userKeyTail].join('|'))
    .digest('hex')
    .slice(0, 16);
}

function readStamp() {
  try { return JSON.parse(fs.readFileSync(stampPath(), 'utf8')); } catch { return {}; }
}

function writeStamp(obj) {
  try {
    if (!fs.existsSync(configDir())) fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stampPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
    try { fs.chmodSync(stampPath(), 0o600); } catch { /* best effort */ }
  } catch { /* a stamp we cannot write only costs one extra POST */ }
}

/**
 * Register this machine against the account its key belongs to.
 *
 * @param {object} opts
 * @param {string} opts.server   base URL of the haksterAi server
 * @param {string} opts.apiKey   the signed-in key (header only, never printed)
 * @param {string} [opts.version] CLI version
 * @param {number} [opts.timeoutMs] bound on the whole request (default 3000)
 * @param {boolean} [opts.force]  skip the 6 h stamp (used by the probe)
 * @returns {Promise<{ok:boolean, status:string, reason?:string}>}
 */
async function registerMachine({ server, apiKey, version = '', timeoutMs = 3000, force = false } = {}) {
  if (process.env.HAKSTER_NO_MACHINE_REG === '1') return { ok: false, status: 'skipped', reason: 'disabled' };
  if (!server || !apiKey) return { ok: false, status: 'skipped', reason: 'not signed in' };

  let base;
  try { base = new URL(server); } catch { return { ok: false, status: 'skipped', reason: 'bad server url' }; }
  if (!/^https?:$/.test(base.protocol)) return { ok: false, status: 'skipped', reason: 'bad server url' };

  const profile = machineProfile({ version });
  const digest = profileDigest(profile, String(apiKey).slice(-6));
  const stamp = readStamp();
  if (!force && stamp && stamp.digest === digest && (Date.now() - Number(stamp.at || 0)) < STAMP_TTL_MS) {
    return { ok: true, status: 'current' };
  }

  const url = new URL('/api/client-context', base).toString();
  const body = JSON.stringify(profile);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(500, timeoutMs)) : null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'x-hakster-client': 'cli',
        'User-Agent': profile.user_agent,
      },
      body,
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) return { ok: false, status: 'rejected', reason: `HTTP ${res.status}` };
    writeStamp({ at: Date.now(), digest, host: profile.device_model });
    return { ok: true, status: 'registered' };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'unreachable';
    return { ok: false, status: 'unreachable', reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { registerMachine, machineProfile, machineSessionId, osNameFromPlatform };
