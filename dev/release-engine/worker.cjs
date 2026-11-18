'use strict';
/**
 * Background build worker — one release, in its own directory, out of process.
 *
 * Isolation rules this worker enforces:
 *   - it is a CHILD process: the production HTTP process never builds anything;
 *   - the release tree lives under releases/<id>/ and owns its own dist/;
 *   - the serving tree is only ever READ (inputs are symlinked, never copied,
 *     so no secret is duplicated and no source file can be modified: a symlink
 *     is followed, and every write lands in the release directory);
 *   - it refuses to start unless disk, memory and load allow it;
 *   - it lowers its own priority (nice / ionice) so client traffic wins;
 *   - it deletes nothing, ever, including failed releases.
 *
 * Usage (from the supervisor, never by hand):
 *   node worker.cjs --project haksterai --release <id> --root <repo> [--install]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const journal = require('./lib/journal.cjs');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, '');
  const v = process.argv[i + 1];
  args[k] = v === undefined ? true : v;
}

const PROJECT = args.project || 'haksterai';
const RELEASE = args.release;
const ROOT = path.resolve(args.root || path.join(__dirname, '..', '..'));
const RELEASES = path.join(__dirname, '..', 'releases');
const DIR = path.join(RELEASES, RELEASE);
const DIST = path.join(DIR, 'dist');

const MIN_DISK_BYTES = 2 * 1024 * 1024 * 1024;   // 2 GiB before we start
const MIN_MEM_AVAIL = 400 * 1024 * 1024;        // 400 MiB available
const MAX_LOAD_PER_CORE = 1.5;                  // refuse to pile onto a busy box

let currentStage = null;
const completed = [];
const t0 = Date.now();

const emit = (type, extra = {}) => {
  journal.append({ project: PROJECT, release: RELEASE, type, stage: currentStage, pid: process.pid, ...extra });
  process.stdout.write(JSON.stringify({ type, stage: currentStage, at: new Date().toISOString(), ...extra }) + '\n');
};
const startStage = (id, label) => {
  currentStage = id;
  emit('stage.start', { label });
};
const endStage = (extra = {}) => {
  const p = journal.progress(PROJECT, completed, currentStage);
  completed.push(currentStage);
  emit('stage.end', { ...extra, ...journal.progress(PROJECT, completed, null), elapsedMs: Date.now() - t0 });
  currentStage = null;
  return p;
};
const fail = (reason) => {
  emit('release.failed', { reason, completedStages: completed.slice(), elapsedMs: Date.now() - t0 });
  process.exitCode = 1;
  process.exit(1);
};

// ── preflight ─────────────────────────────────────────────────────────────
startStage('preflight', 'Checking disk and resources');
let diskFree = null, memAvail = null, load = null;
try {
  const st = fs.statfsSync(ROOT);
  diskFree = st.bavail * st.bsize;
} catch (e) { emit('preflight.note', { disk: 'unreadable: ' + e.code }); }
try {
  const mi = fs.readFileSync('/proc/meminfo', 'utf8');
  memAvail = Number((mi.match(/^MemAvailable:\s+(\d+)\s+kB/m) || [])[1]) * 1024;
} catch (_) { memAvail = os.freemem(); }
load = os.loadavg()[0];
const cores = Math.max(1, os.cpus().length);
emit('preflight.sample', {
  diskFreeBytes: diskFree, memAvailableBytes: memAvail,
  load: Math.round(load * 100) / 100, cores, loadPerCore: Math.round((load / cores) * 100) / 100,
});
if (diskFree != null && diskFree < MIN_DISK_BYTES) fail('disk free below 2 GiB — queued, not started');
if (memAvail != null && memAvail < MIN_MEM_AVAIL) fail('memory available below 400 MiB — queued, not started');
if (load / cores > MAX_LOAD_PER_CORE) fail(`load ${(load / cores).toFixed(2)}/core above ${MAX_LOAD_PER_CORE} — queued, not started`);
endStage({ diskFreeBytes: diskFree, memAvailableBytes: memAvail });

// ── prepare the isolated tree ─────────────────────────────────────────────
startStage('prepare', 'Preparing isolated release tree');
const INPUTS = ['src', 'public', 'package.json', 'astro.config.mjs', 'tsconfig.json', 'astro.config.ts'];
const OPTIONAL = ['.env', '.env.production'];
const linked = [];
try {
  fs.mkdirSync(RELEASES, { recursive: true }); // the parent may not exist yet
  fs.mkdirSync(DIR, { recursive: false });     // this one fails if it exists: never overwrite a release
} catch (e) {
  fail('cannot create a fresh release directory (' + DIR + '): ' + e.code);
}
for (const name of [...INPUTS, ...OPTIONAL]) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) continue;
  try {
    fs.symlinkSync(src, path.join(DIR, name));
    linked.push(name);
  } catch (e) {
    fail('could not link ' + name + ': ' + e.code);
  }
}
// Dependency tree is shared read-only. `npm install` into a release is only
// attempted when explicitly asked for (--install), because it needs network
// and minutes, and because the shared tree is already the tested one.
const nm = path.join(ROOT, 'node_modules');
if (fs.existsSync(nm) && !args.install) {
  fs.symlinkSync(nm, path.join(DIR, 'node_modules'));
  linked.push('node_modules (shared)');
}
if (args.install) {
  const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: DIR, encoding: 'utf8', timeout: 15 * 60 * 1000, env: { ...process.env, NODE_ENV: 'production' },
  });
  if (r.status !== 0) fail('npm ci failed: ' + String(r.stderr || '').slice(-400));
}
emit('prepare.linked', { linked });
endStage({ linked: linked.length });

// ── build ─────────────────────────────────────────────────────────────────
startStage('build', 'Building the site');
const astroBin = path.join(DIR, 'node_modules', '.bin', 'astro');
if (!fs.existsSync(astroBin)) fail('astro binary not found in the linked dependency tree');
const nice = fs.existsSync('/usr/bin/nice') ? ['/usr/bin/nice', '-n', '15'] : [];
const ionice = fs.existsSync('/usr/bin/ionice') ? ['/usr/bin/ionice', '-c', '3'] : [];
const started = Date.now();
const build = spawnSync(nice[0] === '/usr/bin/nice' ? nice[0] : astroBin,
  [
    ...(nice[0] ? nice.slice(1) : []),
    ...ionice,
    astroBin, 'build', '--outDir', DIST,
  ], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=1024',
      // Keep the build off the machine's foreground: one worker, low priority.
      UV_THREADPOOL_SIZE: '2',
    },
  });
const buildMs = Date.now() - started;
if (build.status !== 0) {
  emit('build.output', { tail: String(build.stdout || '').slice(-1500) + String(build.stderr || '').slice(-1500) });
  fail('astro build exited ' + build.status);
}
const lines = String(build.stdout || '').trim().split('\n').filter(Boolean);
emit('build.output', { lines: lines.slice(-6), ms: buildMs });
endStage({ buildMs, lines: lines.length });

// ── verify the candidate artifact ─────────────────────────────────────────
startStage('verify', 'Verifying the candidate artifact');
const indexPath = path.join(DIST, 'index.html');
if (!fs.existsSync(indexPath)) fail('candidate has no dist/index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const buildId = (html.match(/<meta\s+name=["']haksterai-build["']\s+content=["']([^"']+)/i) || [])[1] || null;
const assets = [];
const walk = (d) => {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full);
    else assets.push(full);
  }
};
walk(DIST);
let bytes = 0;
for (const f of assets) { try { bytes += fs.statSync(f).size; } catch (_) {} }
const pages = assets.filter((f) => /(^|\/)index\.html$/.test(f)).length;
const css = assets.filter((f) => f.endsWith('.css')).length;
const js = assets.filter((f) => f.endsWith('.js')).length;
if (!buildId) fail('candidate index.html carries no build id');
if (pages < 10) fail('candidate has only ' + pages + ' pages — expected the full site');
emit('verify.artifact', { buildId, files: assets.length, pages, css, js, bytes });
endStage({ buildId, files: assets.length, pages });

// ── done ──────────────────────────────────────────────────────────────────
startStage('done', 'Release ready');
const summary = endStage({ dir: DIR, dist: DIST });
emit('release.ready', {
  buildId, dir: DIR, dist: DIST, totalMs: Date.now() - t0,
  note: 'Built in isolation. NOT deployed: no traffic was switched and dist/ was not touched.',
});
process.exitCode = 0;
