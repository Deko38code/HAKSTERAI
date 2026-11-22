#!/usr/bin/env node
'use strict';
/**
 * HaksterAI build + update, recorded through the server widget.
 *
 * Owner (2026-11-22): "make sure all our builds and updates go threw server widget always to
 * junkalot and haksterai". Junkalot already ships through `npm run build:update`, which writes a
 * build note and waits for the served build. HaksterAI had no equivalent: a hand-run
 * `astro build` changed the live dist, but the applet's job feed stayed IDLE, so the widget never
 * showed the build. This is that equivalent.
 *
 * Order is deliberate (and matches CLAUDE.md 7 + the live-dist rule):
 *   1. record the job in dev/build-history/data/current-job.json (the applet's only source of truth)
 *   2. build into dist-next — never into the served dist
 *   3. rsync dist-next -> dist only after the build succeeded
 *   4. verify the served page's build meta, then wait for /api/version to report the same id
 *   5. health check the live port; finish the job as completed only when all of that passed
 *
 * Usage: npm run build:update -- --label "PWA install" --note "what changed"
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_NEXT = path.join(ROOT, 'dist-next');
const PORT = Number(process.env.HAKSTER_PORT || 3579);
const livejob = require(path.join(ROOT, 'dev/build-history/lib/livejob.cjs'));

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const LABEL = arg('label', 'HaksterAI update');
const NOTE = arg('note', '');

const buildId = 'hak-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + Math.random().toString(16).slice(2, 8);
const logPath = path.join(ROOT, 'logs', 'build-update-' + buildId + '.log');
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const STAGES = [
  { id: 'capture-git', label: 'Capture Git state' },
  { id: 'build', label: 'Astro build (isolated outDir)' },
  { id: 'publish', label: 'Publish to served dist' },
  { id: 'verify', label: 'Verify served build id' },
  { id: 'health', label: 'Server health check' },
];

function log(text) {
  fs.appendFileSync(logPath, text + '\n');
}

function readBuildMeta(file) {
  try {
    const html = fs.readFileSync(file, 'utf8');
    const m = html.match(/<meta\s+name=["']haksterai-build["']\s+content=["']([^"']+)/i);
    return m ? m[1] : '';
  } catch { return ''; }
}

function httpStatus(urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

function fail(stageId, message, tail) {
  try { livejob.stage(stageId, 'failed', message); } catch {}
  try { livejob.finish('failed', message, tail); } catch {}
  log('FAILED: ' + message);
  console.error('[build:update] FAILED — ' + message);
  console.error('[build:update] log: ' + logPath);
  process.exit(1);
}

(async () => {
  livejob.begin({ buildId, project: 'haksterai', box: 'dell', stages: STAGES });
  log(`build ${buildId} · ${LABEL}${NOTE ? ' — ' + NOTE : ''}`);

  // 1. Git state (read-only; never stage, commit, reset or clean).
  try {
    livejob.stage('capture-git', 'running');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
    const head = execFileSync('git', ['log', '-1', '--pretty=%h %s'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 }).trim();
    log('head ' + head + '\ndirty files: ' + status.split('\n').filter(Boolean).length);
    livejob.stage('capture-git', 'done', head + ' · ' + status.split('\n').filter(Boolean).length + ' dirty');
  } catch (e) {
    livejob.stage('capture-git', 'done', 'git unavailable (not a blocker)');
  }

  // 2. Build into dist-next only.
  livejob.stage('build', 'running', LABEL);
  const hb = setInterval(() => { try { livejob.heartbeat(); } catch {} }, 5000);
  const built = spawnSync('npx', ['astro', 'build', '--outDir', 'dist-next'], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  clearInterval(hb);
  const tail = ((built.stdout || '') + (built.stderr || '')).split('\n').slice(-40);
  log(tail.join('\n'));
  if (built.status !== 0) fail('build', 'astro build exited ' + built.status, tail);
  livejob.stage('build', 'done');

  // 3. Publish additively; stale files are never deleted.
  livejob.stage('publish', 'running');
  const rs = spawnSync('rsync', ['-a', DIST_NEXT + '/', DIST + '/'], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (rs.status !== 0) fail('publish', 'rsync exited ' + rs.status, ((rs.stderr || '') + '').split('\n').slice(-20));
  livejob.stage('publish', 'done');

  // 4. The served dist must carry a build id, and /api/version must agree.
  livejob.stage('verify', 'running');
  const servedBuild = readBuildMeta(path.join(DIST, 'index.html'));
  if (!servedBuild) fail('verify', 'served dist has no build meta');
  let version = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = await httpStatus('/api/version');
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        if (j && j.build) {
          version = j;
          if (j.build === servedBuild) break;
        }
      } catch {}
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!version) fail('verify', 'api/version did not answer');
  if (version.build !== servedBuild) fail('verify', 'api/version reports ' + version.build + ', served page has ' + servedBuild);
  livejob.stage('verify', 'done', 'build ' + servedBuild);

  // 5. Health on the live port.
  livejob.stage('health', 'running');
  const home = await httpStatus('/');
  const api = await httpStatus('/api/version');
  if (home.status !== 200 || api.status !== 200) fail('health', 'home ' + home.status + ' / api ' + api.status);
  livejob.stage('health', 'done', 'home 200 · api 200');

  // Record the build for later reference (append-only).
  try {
    fs.appendFileSync(path.join(ROOT, 'server', 'data', 'build-log.jsonl'), JSON.stringify({
      at: new Date().toISOString(), buildId, site: 'haksterai', label: LABEL, note: NOTE, servedBuild, verified: true,
    }) + '\n');
  } catch {}

  livejob.finish('completed', 'Build ' + servedBuild + ' published and verified — ' + LABEL);
  console.log('[build:update] done — ' + servedBuild + ' is serving on :' + PORT);
  console.log('[build:update] log: ' + logPath);
})().catch((e) => fail('build', e.message, [e.stack || '']));
