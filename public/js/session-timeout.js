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
