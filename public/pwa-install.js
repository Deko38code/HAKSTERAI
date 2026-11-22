/* HaksterAI — shared install surface for pages that do not render Layout.astro.
 *
 * The home page and every Layout-rendered page get the manifest link, the service
 * worker and the install pill from src/layouts/Layout.astro. The standalone pages
 * that ship their own <head> — /marketplace/ and /auth/freebuff/ — did not, so the
 * browser never saw a manifest there, `beforeinstallprompt` never fired, and there
 * was nothing to tap. This file gives those pages the same surface.
 *
 * It is idempotent: if the page already contains #hakster-install-pill (a Layout
 * page), it does nothing, so including it twice can never double up.
 *
 * Behaviour is copied from Layout.astro so every page is identical:
 *   • a real install is remembered permanently (haksterai-pwa-installed) and the
 *     pill stays gone — Chrome never prompts twice, so re-offering it produced a
 *     button that "does nothing";
 *   • the tap opens the card on click, pointerup or touchend;
 *   • the 7-day dismissal applies only to "Not now" on the real card.
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  if (document.getElementById('hakster-install-pill')) return;   // a Layout page owns it
  if (window.__haksterInstallLoaded) return;
  window.__haksterInstallLoaded = true;

  var KEY = 'haksterai-pwa-dismissed';
  var INSTALLED_KEY = 'haksterai-pwa-installed';
  var DISMISS_DAYS = 7;
  var state = window.__haksterInstall || (window.__haksterInstall = { evt: null, installed: false });

  // Capture the deferred prompt as early as possible (this script is in <head>).
  window.addEventListener('beforeinstallprompt', function (event) {
    state.evt = event;
    window.dispatchEvent(new Event('hakster-install-ready'));
  });
  window.addEventListener('appinstalled', function () {
    state.installed = true;
    state.evt = null;
    try { localStorage.setItem(INSTALLED_KEY, '1'); localStorage.removeItem(KEY); } catch (e) {}
    window.dispatchEvent(new Event('hakster-install-done'));
  });

  var CSS = ''
    + '#hakster-install-pill{position:fixed;left:20px;bottom:calc(0.75rem + min(var(--phantom-applet-h,0px),45vh));z-index:900;display:inline-flex;align-items:center;gap:7px;width:auto;max-width:calc(100vw - 2.5rem);box-sizing:border-box;min-height:38px;padding:8px 12px;border:1px solid rgba(0,255,65,.35);border-radius:999px;background:rgba(17,17,24,.96);color:#7dffb3;font:700 11px/1 ui-monospace,monospace;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5);backdrop-filter:blur(8px);touch-action:manipulation}'
    + '#hakster-install-pill[hidden]{display:none}'
    + '#hakster-install-pill img{width:18px;height:18px;flex:none;border-radius:5px;background:#010103}'
    + '#hakster-install{position:fixed;left:20px;bottom:calc(0.75rem + min(var(--phantom-applet-h,0px),45vh));z-index:901;display:flex;align-items:flex-start;gap:10px;max-width:calc(100vw - 2.5rem);max-height:calc(100vh - 1.5rem);overflow:auto;padding:10px 12px;border:1px solid rgba(0,255,65,.35);border-radius:14px;background:rgba(17,17,24,.96);color:#e7ffe9;box-shadow:0 10px 30px rgba(0,0,0,.55);backdrop-filter:blur(8px);font-family:"JetBrains Mono",ui-monospace,monospace}'
    + '#hakster-install[hidden]{display:none}'
    + '#hakster-install img{width:38px;height:38px;flex:none;border-radius:9px;background:#010103}'
    + '#hakster-install .hi-title{margin:0;font-size:12px;font-weight:700;line-height:17px;color:#7dffb3}'
    + '#hakster-install .hi-copy{margin:2px 0 0;font-size:11px;line-height:15px;color:rgba(231,255,233,.65)}'
    + '#hakster-install .hi-actions{display:flex;gap:8px;margin-top:8px}'
    + '#hakster-install button{font:inherit;font-size:11px;min-height:36px;padding:8px 12px;border-radius:9px;cursor:pointer}'
    + '#hakster-install .hi-go{border:0;background:#00ff41;color:#04140a;font-weight:700}'
    + '#hakster-install .hi-no{border:1px solid rgba(255,255,255,.2);background:transparent;color:rgba(231,255,233,.8)}'
    + '@media (max-width:480px){#hakster-install-pill{left:20px}#hakster-install{left:20px;right:20px;max-width:none}}';

  var ICON = '/icons/icon-192.png';

  function inMiniApp() {
    try {
      var t = window.Telegram && window.Telegram.WebApp;
      return !!(t && t.initData);
    } catch (e) { return false; }
  }

  function build() {
    if (document.getElementById('hakster-install-pill')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var pill = document.createElement('button');
    pill.type = 'button';
    pill.id = 'hakster-install-pill';
    pill.setAttribute('aria-label', 'Install HaksterAI');
    pill.hidden = true;
    var icon = document.createElement('img');
    icon.src = ICON; icon.alt = ''; icon.setAttribute('aria-hidden', 'true');
    pill.appendChild(icon);
    pill.appendChild(document.createTextNode(' Install app'));

    var box = document.createElement('div');
    box.id = 'hakster-install';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Install HaksterAI');
    box.innerHTML = '<img src="' + ICON + '" alt="" aria-hidden="true"><div>'
      + '<p class="hi-title" id="hakster-install-title">Install HaksterAI</p>'
      + '<p class="hi-copy" id="hakster-install-copy">One tap on your home screen, same site, no browser bar.</p>'
      + '<div class="hi-actions">'
      + '<button type="button" class="hi-go" id="hakster-install-go">Install</button>'
      + '<button type="button" class="hi-no" id="hakster-install-no">Not now</button>'
      + '</div></div>';

    (document.body || document.documentElement).appendChild(pill);
    (document.body || document.documentElement).appendChild(box);
    wire(pill, box);
  }

  function wire(pill, box) {
    var go = document.getElementById('hakster-install-go');
    var no = document.getElementById('hakster-install-no');
    var title = document.getElementById('hakster-install-title');
    var copy = document.getElementById('hakster-install-copy');

    var dismissed = false;
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    // The old build wrote the literal '1' here on a successful install; migrate it.
    try { if (raw === '1') localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
    if (raw && raw !== '1') {
      var at = /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
      dismissed = at > 0 && (Date.now() - at) < DISMISS_DAYS * 86400000;
    }
    var installedBefore = false;
    try { installedBefore = localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) {}
    var standalone = false;
    try {
      standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    } catch (e) {}

    function hide() { pill.hidden = true; box.hidden = true; }
    if (standalone || dismissed || state.installed || installedBefore) { hide(); return; }

    // Installed through Chrome itself? Our done handler never ran then — ask the
    // platform directly and never offer an installed app again.
    try {
      if (typeof navigator.getInstalledRelatedApps === 'function') {
        navigator.getInstalledRelatedApps().then(function (apps) {
          if (apps && apps.length) {
            state.installed = true; state.evt = null;
            try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
            hide();
          }
        }).catch(function () {});
      }
    } catch (e) {}

    var ua = navigator.userAgent || '';
    var ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var android = /android/i.test(ua);
    var fallbackCopy = ios
      ? 'Open Share, then choose "Add to Home Screen".'
      : android
        ? 'Open the browser menu (⋮) and choose "Install app" or "Add to Home screen".'
        : 'Click the install icon at the right of the address bar, or open the browser menu (⋮) → "Cast, save, and share" → "Install page as app".';

    function showPill() { if (!dismissed && !state.installed && !installedBefore && !inMiniApp()) pill.hidden = false; }
    showPill();
    window.addEventListener('hakster-install-ready', showPill);
    window.addEventListener('hakster-install-done', function () {
      state.installed = true; state.evt = null;
      try { localStorage.setItem(INSTALLED_KEY, '1'); localStorage.removeItem(KEY); } catch (e) {}
      hide();
    });

    var manualMode = false;
    function openCard() {
      if (!state.evt) { manualFallback(); return; }
      manualMode = false;
      pill.hidden = true; box.hidden = false;
      title.textContent = 'Install HaksterAI';
      copy.textContent = 'One tap on your home screen, same site, no browser bar.';
      go.hidden = false; no.textContent = 'Not now';
    }
    function manualFallback() {
      state.evt = null;
      manualMode = true;
      pill.hidden = true; box.hidden = false;
      title.textContent = 'Install HaksterAI';
      copy.textContent = fallbackCopy;
      go.hidden = true; no.textContent = 'Got it';
    }

    // Open on click, pointerup or touchend — a tap that never becomes a click must
    // still open the card (owner: "shows ... but does nothing").
    var openedAt = 0;
    function onPillOpen(ev) {
      if (openedAt && Date.now() - openedAt < 700) return;
      openedAt = Date.now();
      if (ev && ev.cancelable) { try { ev.preventDefault(); } catch (e) {} }
      openCard();
    }
    pill.addEventListener('click', onPillOpen);
    pill.addEventListener('pointerup', onPillOpen);
    pill.addEventListener('touchend', onPillOpen, { passive: false });

    no.addEventListener('click', function () {
      if (!manualMode) { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }
      hide();
    });
    go.addEventListener('click', function () {
      var evt = state.evt;
      if (!evt || typeof evt.prompt !== 'function') { manualFallback(); return; }
      state.evt = null;
      var answered = false;
      var done = function (choice) {
        if (answered) return;
        answered = true;
        if (choice && choice.outcome === 'accepted') {
          state.installed = true;
          try { localStorage.setItem(INSTALLED_KEY, '1'); localStorage.removeItem(KEY); } catch (e) {}
        }
        hide();
      };
      try {
        var p = evt.prompt();
        if (p && p.then) p.then(function () {}, function () { if (!answered) { answered = true; manualFallback(); } });
      } catch (err) { answered = true; manualFallback(); return; }
      if (evt.userChoice && evt.userChoice.then) evt.userChoice.then(done, function () { if (!answered) { answered = true; manualFallback(); } });
      setTimeout(function () { if (!answered) { answered = true; manualFallback(); } }, 2500);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
