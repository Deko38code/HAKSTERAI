'use strict';
/**
 * Junkalot update progress — read-only, for the haksterai.com admin.
 *
 * 2026-11-16 (owner): when junkalot.co is pushing an update, the admin here has
 * to show the same phase and the same percentage as the pill on the site. The
 * site already publishes that state itself (GET /api/version → `update`), which
 * is derived from the real build files, so this module reads it rather than
 * inventing a second opinion.
 *
 * The only thing this side decides is what to say when the site does not answer:
 * if a build was recently ready or mid-handoff, that is a restart and it reports
 * 'restarting' at 60 — the same number junkalot's own state uses. With no recent
 * push to explain it, it reports 'offline'. It never guesses an ETA.
 *
 * Nothing is written anywhere, no service is touched, and the response is cached
 * for a few seconds so a dashboard refresh cannot hammer the site.
 */

const https = require('https');

const PRIMARY = 'https://junkalot.co/api/version';
const FALLBACK = 'http://10.0.0.251:5006/api/version';
const TIMEOUT_MS = 6000;
const TTL_MS = 5000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;

// Keep these identical to /home/ghost694/junkalot/src/lib/update-state.ts.
const PHASE_PROGRESS = {
  maintenance: 0,
  offline: 0,
  ready: 10,
  handoff: 30,
  restarting: 60,
  answering: 85,
  done: 100,
  idle: 100,
};

const PHASE_LABEL = {
  idle: 'Up to date',
  ready: 'Build ready — waiting for the handoff',
  handoff: 'Pushing the update — handing the build to systemd',
  restarting: 'Service restarting on the new build',
  answering: 'Service answering — waiting for it to report the new build',
  done: 'Update live on the new build',
  maintenance: 'Under construction',
  offline: 'Not answering',
};

let cache = { at: 0, value: null };
let inflight = null;
let lastGood = null;

function fetchJson(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : require('http');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = lib.get(url, { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 200000) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(null);
        try {
          finish(JSON.parse(body));
        } catch {
          finish(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function compose(phase, message, extra = {}) {
  return {
    ok: phase !== 'offline',
    phase,
    progress: PHASE_PROGRESS[phase] != null ? PHASE_PROGRESS[phase] : 0,
    label: PHASE_LABEL[phase] || phase,
    message,
    target: extra.target || null,
    build: extra.build || null,
    attempts: Number(extra.attempts) || 0,
    reachable: !!extra.reachable,
    source: extra.source || null,
    checkedAt: new Date().toISOString(),
  };
}

function fromAnswer(data, source) {
  const update = data && data.update && data.update.phase ? data.update : null;
  if (update) {
    const phase = PHASE_PROGRESS[update.phase] != null ? update.phase : 'idle';
    return compose(phase, clean(update.message, 300), {
      target: clean(update.target, 64) || null,
      build: clean(data.build, 64) || null,
      attempts: update.attempts,
      reachable: true,
      source,
    });
  }
  // An older build that predates the shared state: say what is actually known
  // from the version payload instead of pretending it is current.
  if (data && data.maintenance && data.maintenance.active) {
    return compose('maintenance', clean(data.maintenance.message, 300) || 'Under construction.', {
      build: clean(data.build, 64) || null,
      reachable: true,
      source,
    });
  }
  if (data && data.pending && data.pending.build) {
    return compose('ready', 'Build ' + clean(data.pending.build, 64) + ' is ready on junkalot.co.', {
      target: clean(data.pending.build, 64),
      build: clean(data.build, 64) || null,
      reachable: true,
      source,
    });
  }
  return compose('idle', 'Serving build ' + clean(data && data.build, 64) + '; nothing newer on the server.', {
    build: clean(data && data.build, 64) || null,
    reachable: true,
    source,
  });
}

function fromSilence() {
  const last = lastGood;
  const recentPush = last &&
    (last.phase === 'ready' || last.phase === 'handoff' || last.phase === 'answering') &&
    Date.now() - Date.parse(last.checkedAt || 0) <= RESTART_WINDOW_MS;
  if (recentPush) {
    return compose(
      'restarting',
      'junkalot.co is not answering while build ' + (last.target || 'the ready build') +
        ' is being pushed. If it stays quiet, the tunnel or Cloudflare is the other possibility.',
      { target: last.target, build: last.build, reachable: false },
    );
  }
  return compose('offline', 'junkalot.co is not answering. No update is known to be in progress.', {
    reachable: false,
  });
}

async function readOnce() {
  let data = await fetchJson(PRIMARY);
  let source = PRIMARY;
  if (!data) {
    data = await fetchJson(FALLBACK);
    source = FALLBACK;
  }
  if (!data || !data.build) {
    // Neither the public site nor the LAN address answered.
    return fromSilence();
  }
  const value = fromAnswer(data, source);
  lastGood = value;
  return value;
}

async function getState() {
  const now = Date.now();
  if (cache.value && now - cache.at < TTL_MS) return { ...cache.value, cached: true };
  if (inflight) return inflight;
  inflight = (async () => {
    let value;
    try {
      value = await readOnce();
    } catch (err) {
      value = compose('offline', 'Could not read junkalot.co: ' + clean(err && err.message, 160));
    }
    cache = { at: Date.now(), value };
    inflight = null;
    return value;
  })();
  return inflight;
}

module.exports = {
  getState,
  PHASE_PROGRESS,
  PHASE_LABEL,
  _internals: { fromAnswer, fromSilence, fetchJson },
};
