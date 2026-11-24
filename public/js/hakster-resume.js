/* hakster-resume.js — smooth updates and auto-resume for every user.
 *
 * Two jobs:
 *  1. Nothing in the site ever reloads a tab into a server that is restarting.
 *     Before an "Update" reload, the page asks the server whether it is awake and
 *     waits for it; if it is down, the current page stays put with a small banner
 *     and the reload happens by itself the moment the server answers again.
 *  2. If the server goes away while a tab is open (restart, deploy, crash), the
 *     tab says "reconnecting" instead of looking dead, and picks itself back up
 *     when the server returns — back on the same page, same scroll position.
 *
 * Everything is health-check based against the site's own /api/version endpoint.
 * No storage of private data; the tab's path is remembered in sessionStorage only
 * so a recovery can put the user back where they were.
 */
(function () {
  'use strict';
  if (window.__haksterResume) return;
  window.__haksterResume = true;

  var PROBE_MS = 20000;      // background health poll
  var RETRY_MS = 2000;       // while waiting for a restarting server
  var BANNER_ID = 'hakster-reconnect-banner';

  var pendingUpdate = false; // set by the Update button
  var downSince = 0;
  var retryTimer = 0;
  var probeTimer = 0;
  // Why the tab believes the server is away. The page sets 'apply' when the
  // server reports it is applying a build (that drop is deliberate: the
  // process exits and PM2 respawns it). Without it a planned apply and a real
  // crash look identical in the banner — which is how a normal update came to
  // be reported as a crash. Never guessed: only a cause the page was told.
  var restartCause = '';
  var restartCauseAt = 0;

  function causeNow() {
    return restartCause && (Date.now() - restartCauseAt) < 180000 ? restartCause : '';
  }

  function probeUrl() { return '/api/version?t=' + Date.now(); }

  function healthy() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    return fetch(probeUrl(), {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctl ? ctl.signal : undefined,
      headers: { 'x-hakster-health': '1' },
    }).then(function (res) {
      clearTimeout(timer);
      return res.ok;
    }).catch(function () {
      clearTimeout(timer);
      return false;
    });
  }

  function banner(text, tone) {
    var el = document.getElementById(BANNER_ID);
    if (text === null && !el) return;
    if (!el) {
      el = document.createElement('div');
      el.id = BANNER_ID;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
        'z-index:2147483000', 'max-width:min(520px,calc(100vw - 24px))',
        'padding:10px 14px', 'border-radius:12px', 'font:13px/1.4 system-ui,sans-serif',
        'display:flex', 'align-items:center', 'gap:10px', 'box-shadow:0 10px 30px rgba(0,0,0,.45)',
        'transition:opacity .2s ease',
      ].join(';');
      document.body.appendChild(el);
    }
    if (text === null) {
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode && el.style.opacity === '0') el.parentNode.removeChild(el); }, 220);
      return el;
    }
    el.style.opacity = '1';
    el.style.background = tone === 'ok' ? '#0f2a1d' : '#1b1b26';
    el.style.color = tone === 'ok' ? '#86efac' : '#e2e8f0';
    el.style.border = '1px solid ' + (tone === 'ok' ? 'rgba(34,197,94,.45)' : 'rgba(124,58,237,.45)');
    el.innerHTML = '';
    var dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:999px;flex:none;background:' + (tone === 'ok' ? '#22c55e' : '#a855f7');
    var span = document.createElement('span');
    span.textContent = text;
    el.append(dot, span);
    return el;
  }

  function scheduleProbe(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(probe, ms || PROBE_MS);
  }

  function probe() {
    if (document.visibilityState !== 'visible') {
      // Keep checking while the tab is hidden only if an update is waiting, so
      // it is already applied when the user comes back.
      if (pendingUpdate) scheduleProbe(PROBE_MS);
      return;
    }
    healthy().then(function (ok) {
      if (ok) {
        // A pending Update reloads as soon as the server answers — whether it
        // was actually down or the first health check merely timed out.
        if (pendingUpdate) {
          pendingUpdate = false;
          banner('Back online — loading the new version…', 'ok');
          setTimeout(function () { location.reload(); }, 300);
          return;
        }
        if (downSince) {
          var wasDown = Math.round((Date.now() - downSince) / 1000);
          downSince = 0;
          banner(causeNow() === 'apply'
            ? 'Update applied — back on the new build after ' + wasDown + 's.'
            : 'Back online after ' + wasDown + 's.', 'ok');
          restartCause = '';
          setTimeout(function () { banner(null); }, 4000);
          // Anything the page fetched while the server was away may be stale.
          try { document.dispatchEvent(new CustomEvent('hakster:server-back')); } catch (e) {}
        } else {
          banner(null);
        }
        scheduleProbe(PROBE_MS);
        return;
      }
      if (!downSince) downSince = Date.now();
      banner(pendingUpdate ? 'Updating — waiting for the server…'
        : causeNow() === 'apply' ? 'Server is restarting to apply an update — reconnecting…'
        : 'Server is restarting — reconnecting…');
      scheduleProbe(RETRY_MS);
    });
  }

  // ── public API used by the update toast ─────────────────────────────────
  window.haksterServerHealthy = healthy;
  window.haksterUpdateWhenReady = function () {
    pendingUpdate = true;
    banner('Updating — waiting for the server…');
    clearTimeout(retryTimer);
    probe();
  };
  // Set by the page when it learns the server is applying a build, so the
  // banner can name the cause instead of implying a crash.
  window.haksterNoteRestart = function (cause) {
    restartCause = String(cause || '');
    restartCauseAt = Date.now();
  };

  document.addEventListener('visibilitychange', probe);
  window.addEventListener('online', probe);
  window.addEventListener('pageshow', probe);
  clearTimeout(probeTimer);
  probeTimer = setTimeout(probe, 5000);
})();
