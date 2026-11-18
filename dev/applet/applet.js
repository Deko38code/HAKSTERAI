/* HaksterAI live applet — client.
 *
 * Reads the authenticated stream the HaksterAI server publishes. Nothing here
 * invents a value: every row renders what the last frame said, and a row with
 * no measurement renders "UNKNOWN".
 *
 * Transport: fetch() + ReadableStream rather than EventSource, because the
 * credential travels in a header and must never sit in a URL. If streaming is
 * unavailable the client falls back to polling the same authenticated JSON
 * endpoint, and says so.
 *
 * States the user sees, and the only ones allowed:
 *   spinner active   a real build is running (job.state RUNNING)
 *   panel expanded   build events have arrived; progress is measured
 *   VERIFYING        build done, health checks running, stability window open
 *   ✓ STABLE         every required check passed for the whole window
 *   ✗ FAILED         a real failure; the failure log stays on screen
 *   DISCONNECTED     no frame for 30 s — never rendered as success
 *
 * Collapsing to the spinner never resets progress: the last frame is kept and
 * re-rendered on expand. Audit lines are sent for spinner activation, expand,
 * collapse, stage transitions, meaningful progress changes, completion and
 * stability verification — server-side timestamps, no client clock trusted.
 */
(() => {
  const dock = document.getElementById('phantom-progress-dock');
  const card = document.getElementById('phantom-progress');
  const fill = document.getElementById('phantom-fill');
  const label = document.getElementById('phantom-percent');
  const status = document.getElementById('phantom-status');
  const track = document.querySelector('.phantom-track');
  const live = document.getElementById('hp-live');
  const scopeEl = document.getElementById('hp-scope');
  const toggle = document.getElementById('hp-toggle');
  const collapseBtn = document.getElementById('hp-collapse');
  const pill = document.getElementById('hp-pill');
  const pillPct = document.getElementById('hp-pct');
  if (!dock || !fill || !label || !status || !track || !pill) return;

  const progressEl = document.getElementById('hp-progress');
  const stageEl = document.getElementById('hp-stage');
  const clockEl = document.getElementById('hp-clock');
  const elapsedEl = document.getElementById('hp-elapsed');
  const etaEl = document.getElementById('hp-eta');
  const updatesEl = document.getElementById('hp-updates');
  const errorEl = document.getElementById('hp-error');

  const API = (window.HP_API_BASE || '') + '/api/applet';
  const KEY_STORAGE = 'hakster_api_key';
  const HIDE_AFTER_STABLE_MS = 8000;
  const STALE_AFTER_MS = 30000;

  let hideTimer = null;
  let staleTimer = null;
  let lastState = null;
  let lastSnapshot = null;
  let lastFrameAt = 0;
  let panelOpen = false;      // details section
  let collapsed = true;       // resting pill vs full dock
  let manualCollapse = false; // user chose the pill; don't auto-expand over them
  let disconnected = false;
  let lastBuildId = null;
  let lastStageId = null;
  let lastPercentBucket = null;
  let pendingExpand = null;
  let lastStabilityKey = null;
  const audits = new Map();

  const apiKey = () => {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (_) { return ''; }
  };
  const authHeader = () => {
    const key = apiKey();
    return key ? { 'x-api-key': key } : {};
  };

  // ── audit (owning project's log; server stamps the UTC time) ────────────
  function audit(event, extra = {}) {
    const scope = lastSnapshot && lastSnapshot.scope;
    if (scope !== 'owner' && scope !== 'user') return;   // public applets never write audit lines
    const buildId = extra.buildId || (lastSnapshot && lastSnapshot.job && lastSnapshot.job.buildId) || null;
    const key = event + '|' + (buildId || '') + '|' + (extra.stage || '');
    const now = Date.now();
    if (audits.has(key) && now - audits.get(key) < 3000) return;
    audits.set(key, now);
    fetch(API + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        event,
        buildId: buildId || undefined,
        stage: extra.stage || undefined,
        percent: Number.isFinite(extra.percent) ? extra.percent : undefined,
        detail: extra.detail || undefined,
      }),
      keepalive: true,
    }).catch(() => { /* the audit log is server-side truth; a dropped line is not retried blindly */ });
  }

  // ── expand / collapse ───────────────────────────────────────────────────
  function expand(reason) {
    const wasCollapsed = collapsed;
    collapsed = false;
    manualCollapse = false;
    pill.style.display = 'none';
    dock.hidden = false;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (wasCollapsed) {
      card.classList.remove('hp-entering');
      void card.offsetWidth;              // restart the unfold animation
      card.classList.add('hp-entering');
      setTimeout(() => card.classList.remove('hp-entering'), 300);
      audit('applet.expand', { detail: reason || 'manual' });
    }
    // Re-render immediately from the held frame: expanding must restore the
    // current live state, never start again from zero.
    if (lastSnapshot) render(lastSnapshot);
  }

  function collapse(reason) {
    collapsed = true;
    if (!manualCollapse && reason === 'user') manualCollapse = true;
    dock.hidden = true;
    pill.style.display = 'flex';
    audit('applet.collapse', { detail: reason || 'user' });
  }

  pill.addEventListener('click', () => expand('user'));

  toggle.addEventListener('click', () => {
    panelOpen = !panelOpen;
    card.dataset.open = panelOpen ? '1' : '0';
    toggle.setAttribute('aria-expanded', String(panelOpen));
  });
  collapseBtn.addEventListener('click', () => collapse('user'));
  document.querySelectorAll('.hp-row > button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.parentElement;
      row.dataset.expanded = row.dataset.expanded === '1' ? '0' : '1';
    });
  });

  // ── small helpers ───────────────────────────────────────────────────────
  const setRow = (id, value, detail) => {
    const row = document.querySelector(`.hp-row[data-panel="${id}"]`);
    if (!row) return;
    const v = row.querySelector('[data-v]');
    v.textContent = value == null ? 'UNKNOWN' : value;
    v.classList.remove('hp-bad', 'hp-warn');
    if (/FAILED|DEGRADED|DISCONNECTED|RESTART PENDING/i.test(String(value))) v.classList.add('hp-bad');
    else if (/UNKNOWN|VERIFYING|QUEUED|BLOCKED|STALE/i.test(String(value))) v.classList.add('hp-warn');
    if (detail != null) row.querySelector('[data-d]').textContent = detail;
  };
  const bytes = (n) => (Number.isFinite(n) ? (n / 1048576).toFixed(1) + ' MB' : 'UNKNOWN');
  const ago = (sec) => {
    if (!Number.isFinite(sec)) return 'UNKNOWN';
    if (sec < 60) return `${Math.round(sec)}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  };
  const dur = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return 'UNKNOWN';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  };
  const utcTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toISOString().slice(11, 19) + 'Z';
  };

  const ACTIVE = new Set(['RUNNING', 'BUILD_BOOT', 'BUILT', 'TESTING', 'QUEUED', 'APPLYING']);

  // ── render one real frame ───────────────────────────────────────────────
  function render(snap) {
    if (!snap || !snap.server) return;
    lastSnapshot = snap;
    lastFrameAt = Date.now();

    if (disconnected) {
      disconnected = false;
      audit('telemetry.restored', { detail: 'stream frame received again' });
    }
    live.textContent = '● LIVE';
    live.style.color = '#00ff88';

    const job = snap.job || { state: 'UNKNOWN', label: 'State unknown', percent: null, indeterminate: true };
    const active = ACTIVE.has(job.state) || job.state === 'VERIFYING';
    const running = job.state === 'RUNNING' || job.state === 'QUEUED' || job.state === 'APPLYING' || job.state === 'BUILD_BOOT' || job.state === 'BUILT' || job.state === 'TESTING';
    const failed = job.state === 'FAILED';
    const idle = job.state === 'IDLE';

    scopeEl.textContent = 'scope: ' + (snap.scope || 'unknown');

    // Headline number: a real job percentage while one runs, otherwise the
    // measured share of the Node heap in use. Never a made-up progress value.
    if (running) {
      if (Number.isFinite(job.percent)) {
        label.textContent = Math.round(job.percent) + '%';
        fill.style.width = Math.max(0, Math.min(100, job.percent)) + '%';
        track.dataset.indeterminate = '0';
        track.setAttribute('aria-valuenow', String(Math.round(job.percent)));
        track.setAttribute('aria-label', 'Build progress');
      } else {
        label.textContent = '…';
        fill.style.width = '100%';
        track.dataset.indeterminate = '1';
        track.removeAttribute('aria-valuenow');
        track.setAttribute('aria-label', 'Build running, progress not measurable');
      }
    } else if (failed) {
      label.textContent = '✗';
      label.style.color = '#ff6b6b';
      fill.style.width = '100%';
      fill.style.background = '#ff6b6b';
      track.dataset.indeterminate = '0';
      track.setAttribute('aria-valuenow', '0');
    } else {
      label.style.color = '';
      fill.style.background = '';
      const pct = Number.isFinite(snap.server.heapPct) ? snap.server.heapPct : null;
      label.textContent = pct == null ? '—' : Math.round(pct) + '%';
      fill.style.width = (pct == null ? 0 : Math.max(2, Math.min(100, pct))) + '%';
      track.dataset.indeterminate = '0';
      track.setAttribute('aria-valuenow', String(pct == null ? 0 : Math.round(pct)));
      track.setAttribute('aria-label', 'Node heap in use');
    }
    label.style.color = failed ? '#ff6b6b' : '';

    // ── status line ────────────────────────────────────────────────────────
    status.style.color = '';
    if (idle) {
      status.textContent = job.label || 'Idle';
    } else if (failed) {
      status.textContent = '✗ FAILED · ' + (job.error || job.label || 'build failed');
      status.style.color = '#ff8a8a';
    } else if (running) {
      status.textContent = job.label || job.stage?.label || job.state;
    }

    // ── live progress block ────────────────────────────────────────────────
    const hasProgress = Boolean(job.buildId) && !idle;
    progressEl.hidden = !hasProgress;
    if (hasProgress) {
      stageEl.textContent = job.stage?.label || job.label || job.state || 'Build';
      const lines = [];
      if (Number.isFinite(job.elapsedSec)) lines.push(`elapsed ${dur(job.elapsedSec)}`);
      elapsedEl.textContent = lines.length ? lines.join(' · ') : 'elapsed UNKNOWN';

      if (running && Number.isFinite(job.etaSec)) {
        fillTrackEta(job);
      } else if (job.state === 'VERIFYING') {
        etaEl.textContent = 'build done · verifying health and stability';
      } else if (failed) {
        etaEl.textContent = 'no further work';
      } else {
        etaEl.textContent = job.etaNote ? 'ETA unknown — ' + job.etaNote : 'ETA unknown';
      }

      const ups = Array.isArray(job.updates) ? job.updates : [];
      updatesEl.innerHTML = ups.slice(-6).map((u) => {
        const t = utcTime(u.at);
        return `<li><span class="t">${t}</span><span>${escapeHtml(u.text)}</span></li>`;
      }).join('');

      if (failed && (job.error || (job.errorTail || []).length)) {
        errorEl.hidden = false;
        errorEl.textContent = [job.error || 'build failed'].concat(job.errorTail || []).join('\n');
      } else {
        errorEl.hidden = true;
        errorEl.textContent = '';
      }
    }

    // ── rows ───────────────────────────────────────────────────────────────
    setRow('node', snap.server.node || 'UNKNOWN',
      `pid ${snap.server.pid ?? 'UNKNOWN'}\nuptime ${dur(snap.server.uptimeSec)}\n` +
      `heap ${bytes(snap.server.heapUsed)} / ${bytes(snap.server.heapLimit)}\n` +
      `rss ${bytes(snap.server.rss)}\nload ${snap.server.load1 ?? 'UNKNOWN'} on ${snap.server.cores ?? '?'} cores`);

    if (Array.isArray(snap.pm2)) {
      const online = snap.pm2.filter((p) => p.status === 'online').length;
      setRow('pm2', `${online}/${snap.pm2.length} online`,
        snap.pm2.map((p) => `${p.name.padEnd(22)} ${p.status} ${Math.round(p.cpu || 0)}% ${bytes(p.memory)} ⇢${p.restarts}`).join('\n'));
    } else if (snap.pm2Error) {
      setRow('pm2', 'UNKNOWN', snap.pm2Error);
    } else {
      setRow('pm2', 'UNKNOWN', 'process table is only visible to a signed-in owner');
    }

    const npm = snap.npm;
    if (npm) {
      setRow('npm', npm.buildAgeSec == null ? 'UNKNOWN' : ago(npm.buildAgeSec),
        `package ${npm.packageVersion || 'UNKNOWN'}\nlast page build ${npm.lastBuildAt || 'UNKNOWN'}\n` +
        `page build behind source: ${npm.pageBuildBehindSource ? 'yes' : 'no'}`);
    } else {
      setRow('npm', 'UNKNOWN', 'build detail is only visible to a signed-in owner');
    }

    if (Array.isArray(snap.deployments)) {
      setRow('deploy', snap.deployments.length ? `${snap.deployments.length} recent` : 'none recorded',
        snap.deployments.length
          ? snap.deployments.map((d) => `${d.at || 'UNKNOWN'} · ${d.action || '?'} · ${d.build || '?'}`).join('\n')
          : 'No deployment events recorded yet.');
    } else {
      setRow('deploy', 'UNKNOWN', 'deployment history is only visible to a signed-in owner');
    }

    // Stability — evidence-based state from the monitor, never inferred here
    const st = snap.stability;
    if (st) {
      const w = st.window || {};
      const t2 = st.timestamps || {};
      const cd = Number.isFinite(w.remainingSec)
        ? (w.remainingSec > 0 ? `countdown ${Math.floor(w.remainingSec / 60)}m ${w.remainingSec % 60}s` : 'window complete')
        : 'countdown UNKNOWN';
      const checks = st.checks || [];
      const failing = checks.filter((c) => c.status === 'fail').length;
      const lines = [
        `state ${st.state}`,
        st.reason || '',
        `observation window ${w.elapsedSec ?? '?'}s of ${w.configuredSec ?? '?'}s · ${cd}`,
        `window approved: ${w.approved ? 'yes' : 'NO — awaiting owner approval'}`,
        `last check ${t2.lastCheckAt || 'UNKNOWN'}`,
        `last deployment ${t2.lastDeployedAt || 'UNKNOWN'}${Number.isFinite(t2.deployedAgeSec) ? ` (${ago(t2.deployedAgeSec)})` : ''}`,
        Number.isFinite(t2.stableForSec) && t2.buildFirstStableAt ? `stable for ${dur(t2.stableForSec)} since ${t2.buildFirstStableAt}` : 'not yet STABLE',
        '',
        ...checks.map((c) => `${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '?'} ${c.id}${c.detail ? ' — ' + c.detail : ''}`),
      ];
      setRow('stability', st.state, lines.filter(Boolean).join('\n'));

      const badge = failing ? ` · ${failing} failing` : '';
      if (st.state === 'STABLE') {
        if (!idle && !failed) {
          status.textContent = '✓ STABLE' + (active ? ' · build verified' : '');
          status.style.color = '#00ff88';
        }
        scheduleHideWhenStable();
      } else if (st.state === 'VERIFYING') {
        if (!failed) {
          status.textContent = `VERIFYING · ${cd}${badge}`;
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        }
      } else if (st.state === 'DEGRADED' || st.state === 'FAILED') {
        if (!failed) {
          status.textContent = `${st.state}${badge}`;
          status.style.color = st.state === 'FAILED' ? '#ff8a8a' : '#ffd479';
        }
      }

      const stabKey = st.state + '|' + (t2.deployedBuildId || '');
      if (stabKey !== lastStabilityKey) {
        if (st.state === 'STABLE') audit('stability.verified', { detail: `window ${w.elapsedSec}s complete` });
        else if (st.state === 'DEGRADED' || st.state === 'FAILED') audit('stability.degraded', { detail: `${st.state}: ${st.reason || ''}` });
        lastStabilityKey = stabKey;
      }
    }

    // Server
    const b = snap.build || {};
    setRow('server', b.serverStale ? 'RESTART PENDING' : 'CURRENT',
      `page build ${b.id || 'UNKNOWN'}\nserver boot ${b.serverBuild || 'UNKNOWN'}\n` +
      `pending server files ${b.pending ?? 'UNKNOWN'}${b.pendingFiles && b.pendingFiles.length ? '\n' + b.pendingFiles.join('\n') : ''}`);

    // ── spinner state + audit of job transitions ───────────────────────────
    if (job.buildId && job.buildId !== lastBuildId) {
      lastBuildId = job.buildId;
      lastStageId = null;
      lastPercentBucket = null;
      if (running) audit('spinner.activate', { buildId: job.buildId, detail: job.label || 'build started' });
    }
    if (running && job.stage && job.stage.id !== lastStageId) {
      lastStageId = job.stage.id;
      audit('job.stage', { stage: job.stage.id, percent: job.percent, detail: job.stage.label });
    }
    if (Number.isFinite(job.percent)) {
      const bucket = Math.floor(job.percent / 10) * 10;
      if (bucket !== lastPercentBucket) {
        lastPercentBucket = bucket;
        audit('job.progress', { percent: job.percent, stage: job.stage?.id, detail: `${job.percent}% — ${job.stage?.label || job.label}` });
      }
    }
    if (job.status === 'completed') audit('job.complete', { detail: 'build finished; health and stability verification running' });
    if (job.status === 'failed' || failed) audit('job.failed', { detail: job.error || 'build failed' });

    pill.dataset.active = running ? '1' : (active ? '1' : '0');
    pillPct.textContent = running && Number.isFinite(job.percent) ? Math.round(job.percent) + '%'
      : failed ? '✗'
      : (active ? '●' : '●');
    pillPct.classList.toggle('hp-bad', Boolean(failed));
    pill.setAttribute('aria-label',
      running && Number.isFinite(job.percent) ? `Build ${Math.round(job.percent)} percent — open the live panel`
      : active ? 'Work in progress — open the live panel'
      : 'Open the HaksterAI live server panel');

    // A running (or just-finished) build opens the detail section by itself so
    // stage, elapsed, ETA and timestamped updates are visible without a click.
    if ((running || (job.status === 'completed' && job.startedAt &&
        (Date.now() - Date.parse(job.startedAt)) < 600000)) && !panelOpen) {
      panelOpen = true;
      card.dataset.open = '1';
      toggle.setAttribute('aria-expanded', 'true');
    }

    // ── auto expand on build start / auto settle to the spinner when idle ──
    // The spinner lights first, then the panel unfolds a moment later: the
    // spinner is the "something real is happening" signal and it should be
    // seen before the panel covers the page.
    const recentBuild = job.status === 'completed' && job.startedAt && (Date.now() - Date.parse(job.startedAt)) < 600000;
    if (running && collapsed && !manualCollapse) {
      pill.dataset.active = '1';
      if (!pendingExpand) {
        pendingExpand = setTimeout(() => { pendingExpand = null; if (!manualCollapse) expand('build started'); }, 700);
      }
    } else if ((running || recentBuild) && collapsed && !manualCollapse && !pendingExpand) {
      expand('build in verification');
    } else if ((running || recentBuild) && !collapsed && pill.style.display !== 'none') {
      pill.style.display = 'none';
    }
    if (idle && !manualCollapse && collapsed) {
      pill.style.display = 'flex';
    }

    // Toast behaviour: the panel shows itself while work is real, and retreats
    // to the spinner once everything is verified (PhantomIDE's 8 s rule).
    const wasRunning = lastState === 'running';
    if (wasRunning && !running && !failed) scheduleHideWhenStable();

    lastState = running ? 'running' : (idle ? 'idle' : 'other');
  }

  function fillTrackEta(job) {
    const remaining = job.etaSec - (Date.now() - lastFrameAt) / 1000;
    // An estimate that has run out is not "0 seconds" — the stage is simply
    // taking longer than the measured prior said. Say so instead.
    clockEl.textContent = remaining > 0
      ? `ETA ~${dur(Math.round(remaining))} (estimate)`
      : `over the ${dur(job.etaSec)} estimate`;
  }

  function scheduleHideWhenStable() {
    if (hideTimer || manualCollapse) return;
    hideTimer = setTimeout(() => { hideTimer = null; if (!manualCollapse) collapse('idle'); }, HIDE_AFTER_STABLE_MS);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── once-a-second clock + stale-telemetry guard ─────────────────────────
  setInterval(() => {
    if (!lastSnapshot) return;
    const job = lastSnapshot.job || {};
    const since = Date.now() - lastFrameAt;
    const running = job.state === 'RUNNING' || job.state === 'QUEUED' || job.state === 'APPLYING';

    if (since > STALE_AFTER_MS) {
      if (!disconnected) {
        disconnected = true;
        live.textContent = '○ DISCONNECTED';
        live.style.color = '#ff8a8a';
        audit('telemetry.lost', { detail: `no frame for ${Math.round(since / 1000)}s` });
      }
      // With no fresh frame every displayed number is stale, so the honest
      // reading is "unknown" — whatever the last frame happened to say.
      status.textContent = `DISCONNECTED · last frame ${Math.round(since / 1000)}s ago · state UNKNOWN`;
      status.style.color = '#ffd479';
      label.textContent = '?';
      label.style.color = '#ffd479';
      fill.style.width = '100%';
      fill.style.background = '';
      track.dataset.indeterminate = '1';
      track.removeAttribute('aria-valuenow');
      clockEl.textContent = 'ETA unknown — telemetry lost';
      elapsedEl.textContent = 'elapsed UNKNOWN';
      etaEl.textContent = 'telemetry lost';
      ['node', 'pm2', 'npm', 'deploy', 'stability', 'server'].forEach((id) => {
        const v = document.querySelector(`.hp-row[data-panel="${id}"] [data-v]`);
        if (v && v.textContent !== 'UNKNOWN') {
          const d = document.querySelector(`.hp-row[data-panel="${id}"] [data-d]`);
          if (d) d.textContent = `last known: ${v.textContent} (stale — no frame for ${Math.round(since / 1000)}s)`;
          v.textContent = 'UNKNOWN';
          v.classList.remove('hp-bad');
          v.classList.add('hp-warn');
        }
      });
      pill.dataset.active = '0';
      return;
    }

    if (disconnected) {
      disconnected = false;
      live.textContent = '● LIVE';
      live.style.color = '#00ff88';
    }

    if (!running) return;
    const elapsed = Number.isFinite(job.elapsedSec) ? job.elapsedSec + since / 1000 : null;
    const eta = Number.isFinite(job.etaSec) ? job.etaSec - since / 1000 : null;
    clockEl.textContent = eta == null ? 'ETA unknown'
      : eta > 0 ? `ETA ~${dur(Math.round(eta))} (estimate)`
      : `over the ${dur(job.etaSec)} estimate`;
    elapsedEl.textContent = elapsed == null ? 'elapsed UNKNOWN' : `elapsed ${dur(Math.round(elapsed))}`;
    etaEl.textContent = Number.isFinite(job.etaSec)
      ? `based on ${job.etaBasis || 'measured stages'}`
      : (job.etaNote || 'not measurable yet');
  }, 1000);

  // ── transport ───────────────────────────────────────────────────────────
  function connectStream() {
    const headers = { Accept: 'text/event-stream', ...authHeader() };
    let stopped = false;

    fetch(API + '/stream?t=' + Date.now(), { headers, cache: 'no-store' })
      .then((res) => {
        if (!res.ok || !res.body) throw new Error('stream unavailable (' + res.status + ')');
        const scope = res.headers.get('X-Applet-Scope');
        if (scope) scopeEl.textContent = 'scope: ' + scope;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const pump = () => reader.read().then(({ value, done }) => {
          if (done) { if (!stopped) retryIn(3000); return; }
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
            if (!dataLines.length) continue;
            try {
              const payload = JSON.parse(dataLines.map((l) => l.slice(5).trim()).join('\n'));
              if (payload && payload.type === 'snapshot') render(payload);
            } catch (_) { /* a frame we cannot parse is ignored, never guessed at */ }
          }
          pump();
        }).catch(() => { if (!stopped) retryIn(3000); });
        pump();
      })
      .catch(() => {
        live.textContent = '○ OFFLINE';
        live.style.color = '#ff8a8a';
        poll();
        // Keep trying the stream: a restart of the telemetry host must resume
        // live updates without the operator touching the page.
        retryIn(5000);
      });

    return () => { stopped = true; };
  }

  let retryTimer = null;
  function retryIn(ms) {
    live.textContent = '○ RECONNECTING';
    live.style.color = '#ffd479';
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; connectStream(); }, ms);
  }

  function poll() {
    fetch(API + '/status?t=' + Date.now(), { headers: authHeader(), cache: 'no-store' })
      .then((r) => r.json())
      .then((snap) => { live.textContent = '● LIVE (poll)'; live.style.color = '#00ff88'; render(snap); })
      .catch(() => { live.textContent = '○ OFFLINE'; live.style.color = '#ff8a8a'; });
  }

  // Resting state is the small spinner; a real build expands it.
  pill.style.display = 'none';
  status.textContent = 'Connecting…';
  connectStream();
  setInterval(() => { if (!lastSnapshot) poll(); }, 5000);
})();
