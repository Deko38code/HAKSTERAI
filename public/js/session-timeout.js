(() => {
  const TIMEOUT_MS = 60 * 60 * 1000;
  const LAST_ACTIVITY_KEY = 'hakster_last_activity';
  const TOKEN_KEY = 'hakster_google_token';
  const USER_KEYS = ['hakster_google_user', 'hakster_user_data'];
  const ACTIVITY_EVENTS = ['click', 'keydown', 'pointerdown', 'touchstart', 'scroll'];
  let lastTouchWrite = 0;

  function hasSession() {
    return Boolean(localStorage.getItem(TOKEN_KEY));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    USER_KEYS.forEach((key) => localStorage.removeItem(key));
  }

  function logoutForTimeout() {
    if (!hasSession()) return;
    clearSession();
    if (window.google?.accounts?.id) {
      try { window.google.accounts.id.disableAutoSelect(); } catch {}
    }
    const target = '/?session=expired';
    if (window.location.pathname === '/') {
      window.location.replace(target);
    } else {
      window.location.href = target;
    }
  }

  function getLastActivity() {
    const raw = Number(localStorage.getItem(LAST_ACTIVITY_KEY) || '0');
    return Number.isFinite(raw) ? raw : 0;
  }

  function touchActivity(force = false) {
    if (!hasSession()) return;
    const now = Date.now();
    if (!force && now - lastTouchWrite < 15000) return;
    lastTouchWrite = now;
    localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
  }

  function checkTimeout() {
    if (!hasSession()) return;
    const last = getLastActivity();
    if (!last) {
      touchActivity(true);
      return;
    }
    if (Date.now() - last > TIMEOUT_MS) {
      logoutForTimeout();
    }
  }

  window.haksterSessionTouch = () => touchActivity(true);
  window.haksterSessionLogout = () => {
    clearSession();
    window.location.href = '/';
  };

  checkTimeout();
  touchActivity(true);
  ACTIVITY_EVENTS.forEach((eventName) => {
    window.addEventListener(eventName, () => touchActivity(false), { passive: true });
  });
  window.addEventListener('focus', checkTimeout);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkTimeout();
  });
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY && !event.newValue && window.location.pathname !== '/') {
      window.location.href = '/';
    }
  });
  setInterval(checkTimeout, 60000);
})();

(() => {
  const INSTALL_BUTTON_ID = 'hakster-pwa-install';
  const INSTALL_READY_CLASS = 'hakster-pwa-install-ready';
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function injectPwaHeadTags() {
    const tags = [
      ['link', { rel: 'manifest', href: '/manifest.webmanifest' }],
      ['link', { rel: 'apple-touch-icon', href: '/logo-192.png' }],
      ['meta', { name: 'theme-color', content: '#0a0a0f' }],
      ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
      ['meta', { name: 'apple-mobile-web-app-title', content: 'haksterAI' }],
      ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }]
    ];

    tags.forEach(([tagName, attrs]) => {
      const selector = tagName === 'link' ? `link[rel="${attrs.rel}"]` : `meta[name="${attrs.name}"]`;
      if (document.head.querySelector(selector)) return;
      const tag = document.createElement(tagName);
      Object.entries(attrs).forEach(([key, value]) => tag.setAttribute(key, value));
      document.head.appendChild(tag);
    });
  }

  function injectInstallStyles() {
    if (document.getElementById('hakster-pwa-install-styles')) return;
    const style = document.createElement('style');
    style.id = 'hakster-pwa-install-styles';
    style.textContent = `
      #${INSTALL_BUTTON_ID} {
        position: fixed;
        right: 1rem;
        bottom: 1rem;
        z-index: 70;
        display: none;
        align-items: center;
        gap: 0.5rem;
        border: 1px solid rgba(124, 58, 237, 0.55);
        border-radius: 999px;
        background: rgba(17, 17, 24, 0.94);
        color: #e2e8f0;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
        padding: 0.65rem 0.9rem;
        font: 700 0.78rem/1 "JetBrains Mono", ui-monospace, monospace;
        backdrop-filter: blur(12px);
        cursor: pointer;
      }
      body.${INSTALL_READY_CLASS} #${INSTALL_BUTTON_ID} { display: inline-flex; }
      #${INSTALL_BUTTON_ID}:hover { border-color: rgba(168, 85, 247, 0.85); color: #fff; }
      #${INSTALL_BUTTON_ID} svg { width: 1rem; height: 1rem; }
      @media (max-width: 640px) {
        #${INSTALL_BUTTON_ID} { left: 1rem; right: 1rem; justify-content: center; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureInstallButton() {
    if (document.getElementById(INSTALL_BUTTON_ID)) return;
    const button = document.createElement('button');
    button.id = INSTALL_BUTTON_ID;
    button.type = 'button';
    button.setAttribute('aria-label', 'Install haksterAI app');
    button.innerHTML = `
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>
      </svg>
      <span>Install App</span>
    `;
    button.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      button.disabled = true;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch {}
      deferredPrompt = null;
      document.body.classList.remove(INSTALL_READY_CLASS);
      button.disabled = false;
    });
    document.body.appendChild(button);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }

  injectPwaHeadTags();
  injectInstallStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureInstallButton, { once: true });
  } else {
    ensureInstallButton();
  }
  registerServiceWorker();

  window.addEventListener('beforeinstallprompt', (event) => {
    if (isStandalone()) return;
    event.preventDefault();
    deferredPrompt = event;
    ensureInstallButton();
    document.body.classList.add(INSTALL_READY_CLASS);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    document.body.classList.remove(INSTALL_READY_CLASS);
    localStorage.setItem('hakster_pwa_installed_at', String(Date.now()));
  });
})();
