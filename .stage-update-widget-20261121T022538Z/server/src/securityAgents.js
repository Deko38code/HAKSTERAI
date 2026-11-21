'use strict';

// ── Infrastructure security agents (read-only) ─────────────────────────────
// Two independent agents review the same read-only sweep of this box and write
// a rundown for the owner:
//
//   codex    — the locally-authenticated `codex` CLI (Codex Pro auth), used for
//              attack-surface and code-path review.
//   deepseek — the DeepSeek lane, used for log/auth/risk analysis.
//
// The sweep itself is autoAgent's existing read-only collector (ports, firewall
// state, pending updates, account posture, code audit, SSH/web anomalies). No
// agent gets shell access: both are asked for findings and recommendations
// only, and every recommended change is labelled as an owner-approval item.
// This module never edits config, never touches a process, and never restarts
// anything. Runs are stored in server/data/security-agents.json and pushed to
// the Telegram fleet (recon bot) as a full rundown.

const fs = require('fs');
const path = require('path');
const autoAgent = require('./autoAgent');

const STATE_FILE = path.join(__dirname, '..', 'data', 'security-agents.json');
const HISTORY_LIMIT = 40;
const THROTTLE_MS = 10 * 60 * 1000;          // reuse a fresh run instead of re-sweeping
const SCHEDULE_MS = 6 * 60 * 60 * 1000;      // automatic sweep every six hours
const STARTUP_DELAY_MS = 90 * 1000;          // let the server settle after a restart
const ASK_FILE = path.join(__dirname, '..', 'data', 'security-agent-asks.json');
const ASK_LIMIT = 40;                        // stored Q/A per agent
const ASK_MIN_GAP_MS = 3000;                 // no machine-gunning one agent
const ASK_MAX_CHARS = 700;
const ASK_CONTEXT_TURNS = 3;                 // prior Q/A sent back for follow-ups

const AGENTS = [
  {
    id: 'codex',
    label: 'Codex Agent',
    provider: 'codex-cli',
    model: process.env.CODEX_CLI_MODEL || 'gpt-6-luna',
    maxTokens: 900,
    job: 'Attack surface, exposed services and code-path review',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Agent',
    provider: 'deepseek',
    model: process.env.DEEPSEEK_MODEL || '',
    maxTokens: 2400,
    job: 'Auth logs, anomaly correlation and risk scoring',
  },
];

let lastState = null;
let currentRun = null;
let timer = null;
let appRef = null;

function ensureDir() {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {}
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(next) {
  ensureDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function clip(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── What the platform is, so the agents know it in and out ─────────────────
// Every section is read-only and individually guarded: a missing file or a
// dead lane degrades one line of the brief, never the run. No secret values
// are read here — only names, counts, states and route paths.
function platformBrief() {
  const lines = [];
  const root = path.join(__dirname, '..', '..');

  // 1) Process table (pm2 owns it — read-only listing, never a change).
  try {
    const out = require('child_process').execFileSync('pm2', ['jlist'], { timeout: 8000, env: process.env }).toString();
    const list = JSON.parse(out).map((p) => ({
      name: p.name,
      status: p.pm2_env && p.pm2_env.status,
      restarts: (p.pm2_env && p.pm2_env.restart_time) || 0,
      memMb: Math.round(((p.monit && p.monit.memory) || 0) / 1048576),
    }));
    const down = list.filter((p) => p.status !== 'online');
    const heavy = [...list].sort((a, b) => b.memMb - a.memMb).slice(0, 5);
    lines.push('processes (pm2): ' + list.length + ' total, ' + down.length + ' not online'
      + (down.length ? ' [' + down.map((p) => p.name + ':' + p.status).join(', ') + ']' : '')
      + ' · top memory: ' + heavy.map((p) => p.name + ' ' + p.memMb + 'MB').join(', '));
  } catch { lines.push('processes (pm2): not readable from this lane'); }

  // 2) HTTP surface actually mounted on this server.
  try {
    const rows = [];
    const stack = (appRef && appRef._router && appRef._router.stack) || [];
    for (const layer of stack) {
      if (!layer.route || !layer.route.path) continue;
      const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      rows.push(methods.map((m) => m.toUpperCase()).join('|') + ' ' + layer.route.path);
    }
    const api = rows.filter((r) => r.includes('/api/'));
    const pages = rows.filter((r) => !r.includes('/api/'));
    lines.push('http: ' + rows.length + ' routes mounted (' + api.length + ' api, ' + pages.length + ' page/asset). api groups: '
      + [...new Set(api.map((r) => (r.split(' ')[1].split('/').slice(1, 3).join('/'))))].slice(0, 18).join(', '));
  } catch { lines.push('http: route table not readable'); }

  // 3) Command Center registry — the owner's script/command brain.
  try {
    const cmds = JSON.parse(fs.readFileSync(path.join(root, 'command-center', 'commands.json'), 'utf8')).commands || [];
    const user = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'command-center', 'user-commands.json'), 'utf8')).commands || []; } catch { return []; } })();
    const sections = {};
    for (const c of cmds) sections[c.section] = (sections[c.section] || 0) + 1;
    lines.push('command center: ' + cmds.length + ' documented commands + ' + user.length + ' session-added, served at /commands (/api/commands owner-only). sections: '
      + Object.entries(sections).slice(0, 12).map(([k, v]) => k + '=' + v).join(' · '));
  } catch { lines.push('command center: registry not readable'); }

  // 4) Peer sync (Parrot <-> Dell) — PhantomIDE must stay in step with this box.
  try {
    const port = process.env.PORT || 3579;
    let peer = null;
    try {
      const raw = require('child_process').execFileSync('curl', ['-sS', '-m', '3', `http://127.0.0.1:${port}/api/peer/status`], { timeout: 6000 }).toString();
      peer = JSON.parse(raw);
    } catch {}
    const parrotDir = fs.existsSync(path.join(root, 'command-center', 'parrot')) ? ' · parrot mirror dir present' : '';
    lines.push('phantomide sync: phantomide.com (Parrot box) <-> haksterai.com (this Dell box) via /api/peer/status, /api/peer/sync, /api/peer/receive'
      + (peer ? ' · peer now: ' + (peer.connected ? 'connected' : 'NOT connected') + ' (' + (peer.phantomUrl || 'url unset') + (peer.error ? ', ' + clip(peer.error, 80) : '') + ')' : ' · peer status unreadable')
      + parrotDir);
  } catch { lines.push('phantomide sync: not readable'); }

  // 5) Telegram fleet — roles, sub-agents, scripts. Names only, never tokens.
  try {
    const bots = require('./telegramBots');
    const roles = Array.isArray(bots.ROLES) ? bots.ROLES : Object.keys(bots.ROLES || {});
    const configured = roles.filter((r, i) => Boolean(process.env['TELEGRAM_BOT_TOKEN_' + (i + 1)]));
    let subs = [];
    try { subs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'telegram-subagents.json'), 'utf8')).subagents || []; } catch {}
    const scripts = fs.readdirSync(path.join(root, 'server', 'scripts')).filter((f) => /^telegram-.*\.(js|mjs)$/.test(f));
    lines.push('telegram fleet: ' + roles.length + ' roles [' + roles.join(', ') + '], ' + configured.length + ' with a token configured'
      + (subs.length ? ' · sub-agents: ' + subs.map((s) => s.name).join(', ') : '')
      + ' · scripts: ' + scripts.join(', '));
  } catch { lines.push('telegram fleet: roles not readable'); }

  // 6) Agent roster on disk.
  try {
    const dir = path.join(require('os').homedir(), '.agents');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    lines.push('agent roster (~/.agents): ' + files.length + ' [' + files.join(', ') + ']');
  } catch { lines.push('agent roster: ~/.agents not readable'); }

  // 7) This module's own schedule, so the agents can describe the cadence.
  lines.push('security agents: codex + deepseek review this exact platform every 6h, on manual run, and after each restart; rundowns go to the Telegram recon bot.');
  return clip(lines.join('\n'), 3200);
}

// ── The brief both agents receive ──────────────────────────────────────────
function sweepBrief(sweep) {
  const checks = (sweep.checks || []).map((c) => `- ${c.label} [${c.state}] ${clip(c.detail, 300)}`);
  const ip = sweep.ip || {};
  const lines = [
    `host: ${(sweep.host && sweep.host.hostname) || 'unknown'}`,
    `sweep state: ${sweep.state} (took ${sweep.durationMs}ms, finished ${sweep.finishedAt})`,
    '',
    'checks:',
    ...checks,
    '',
    `ssh events in ${ip.windowHours || 0}h window: ${ip.events || 0} (${ip.failures || 0} failures, ${ip.invalidUsers || 0} invalid users, ${ip.successes || 0} successes)`,
    `ssh ip verdict: ${ip.state || 'unknown'} · ${ip.uniqueIps || 0} unique IPs (${ip.publicIps || 0} public) · pending anomalies: ${ip.pendingAnomalies || 0}`,
    `top failure IPs: ${(ip.topFailureIps || []).slice(0, 5).map((x) => `${x.ip}×${x.count}`).join(', ') || 'none'}`,
    `web clients in ${ip.windowHours || 0}h: ${ip.webIps || 0} distinct IPs · top: ${(ip.webTop || []).slice(0, 3).map((x) => `${x.ip}×${x.count}`).join(', ') || 'none'}`,
    `access-guard denials: ${(ip.denials || []).length}`,
  ];
  const findings = sweep.codeFindings || [];
  if (findings.length) {
    lines.push('', 'code audit findings:');
    for (const f of findings.slice(0, 12)) {
      lines.push(`- ${clip(f.label || f.id || 'finding', 160)}: ${clip(f.detail || f.message || '', 240)}`);
    }
  }
  return clip(lines.join('\n'), 5000);
}

function systemFor(agent) {
  return [
    `You are the ${agent.label} on a small production server (haksterai.com). Your job: ${agent.job}.`,
    'You are given the platform map (processes, HTTP routes, Command Center registry, peer sync, Telegram fleet, agent roster) and a read-only security sweep. Write a rundown for the owner.',
    'Rules:',
    '- Use only what the sweep proves. If a number or fact is missing, say "not observed" instead of guessing.',
    '- Never invent CVEs, hosts, counts, log lines or metrics.',
    '- Recommend, never execute. Any change that would need shell, config, firewall, service or user changes must be listed under ACTIONS NEEDING OWNER APPROVAL.',
    '- Never suggest killing processes, dropping caches, reinstalling packages, or disabling the Cloudflare tunnels.',
    '- This is a cluster: this Dell box serves haksterai.com, the Parrot box serves phantomide.com, and the Telegram bot fleet is their reporting layer. Treat a desync between boxes, or a bot/role that is configured but not delivering, as a real finding.',
    '- No secrets, tokens, keys, IPs of private users, or credentials of any kind.',
    '- Plain text only, no markdown fences, no backticks. Keep it under 220 words.',
    '',
    'Use exactly these headings, each on its own line:',
    'VERDICT: one line — clear, watch, or act now, and why.',
    'WHAT I CHECKED: up to four short lines.',
    'RISKS: up to three lines, each starting with P0/P1/P2/P3. Write "none observed" when clean.',
    'EVIDENCE: up to three lines quoting the sweep values that justify the risks.',
    'ACTIONS NEEDING OWNER APPROVAL: up to three numbered lines, or "none".',
  ].join('\n');
}

function normalizeRundown(text) {
  return String(text || '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/`/g, '')
    .replace(/\r/g, '')
    .trim();
}

async function askAgent(agent, sweep) {
  const startedAt = Date.now();
  const brief = sweepBrief(sweep);
  const platform = platformBrief();
  // Reasoning lanes (deepseek) can spend the whole allowance thinking and send
  // back an empty answer, so they get a bigger budget and one retry.
  const budget = agent.maxTokens || 1200;
  try {
    const providers = require('./providers');
    const call = (maxTokens) => providers.chat({
      provider: agent.provider,
      model: agent.model || undefined,
      maxTokens,
      system: systemFor(agent),
      messages: [{ role: 'user', content: 'Platform map (haksterai.com, read-only, verified at run time):\n' + platform + '\n\nSecurity sweep of the Dell:\n\n' + brief }],
    });
    let res = await call(budget);
    let text = normalizeRundown(res && res.content);
    if (!text) {
      res = await call(Math.max(2400, budget * 2));
      text = normalizeRundown(res && res.content);
    }
    if (!text) throw new Error('empty rundown (lane returned reasoning only)');
    return {
      id: agent.id,
      label: agent.label,
      provider: (res && res.provider) || agent.provider,
      model: (res && res.model) || agent.model || '',
      fallback: Boolean(res && res.fallback),
      ok: true,
      ms: Date.now() - startedAt,
      ranAt: new Date().toISOString(),
      rundown: clip(text, 4000),
      error: '',
    };
  } catch (err) {
    return {
      id: agent.id,
      label: agent.label,
      provider: agent.provider,
      model: agent.model || '',
      fallback: false,
      ok: false,
      ms: Date.now() - startedAt,
      ranAt: new Date().toISOString(),
      rundown: '',
      error: clip(err && err.message ? err.message : String(err), 300),
    };
  }
}

// ── Owner questions: ask one agent about this box ──────────────────────────
// The cards on the dashboard each carry an input bar. A question is answered by
// that one agent with the same read-only sweep + platform map the scheduled
// rundown uses, plus the last few question/answer pairs so a follow-up ("and
// what about that port?") keeps context. Still read-only: the agent recommends
// and the owner approves. Q/A is kept in a small ring file so a reload shows it.
const askInflight = new Map();
const askLastAt = new Map();

function readAsks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ASK_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeAsks(next) {
  ensureDir();
  const tmp = ASK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, ASK_FILE);
}

function recentAsks(agentId, limit = ASK_CONTEXT_TURNS, all = null) {
  const source = all || readAsks();
  return (source[agentId] || []).slice(0, limit);
}

function askSystem(agent) {
  return [
    `You are the ${agent.label} on a small production server cluster (haksterai.com on this Dell; phantomide.com on the Parrot box). Your job: ${agent.job}.`,
    'The owner is asking you a direct question. Answer it from the platform map and the read-only security sweep you are given.',
    'Rules:',
    '- Answer the question itself first, in one or two sentences, then the detail.',
    '- Use only what the sweep and platform map prove. If a fact is missing, write "not observed" instead of guessing.',
    '- Never invent CVEs, hosts, counts, log lines or metrics.',
    '- Recommend, never execute. Anything needing shell, config, firewall, service or user changes goes under FIX NEEDED (OWNER APPROVAL).',
    '- Never suggest killing processes, dropping caches, reinstalling packages, or changing the Cloudflare tunnels.',
    '- No secrets, tokens, keys, or private user data.',
    '- Plain text only, no markdown fences, no backticks. Keep it under 180 words.',
    '',
    'Format: one line starting "ANSWER:", then optionally the numbered list under',
    '"FIX NEEDED (OWNER APPROVAL):" (write "none" when the box needs nothing),',
    'and one line "CHECKED AGAINST:" naming the sweep values you relied on.',
  ].join('\n');
}

async function askAgentQuestion(agent, sweep, question, history) {
  const startedAt = Date.now();
  const prior = (history || []).slice().reverse();
  const convo = [];
  for (const turn of prior) {
    if (!turn || !turn.q) continue;
    convo.push({ role: 'user', content: clip(turn.q, ASK_MAX_CHARS) });
    convo.push({ role: 'assistant', content: clip(turn.a || turn.error || '', 1200) });
  }
  convo.push({
    role: 'user',
    content: 'Platform map (haksterai.com, read-only, verified at run time):\n' + platformBrief()
      + '\n\nSecurity sweep of the Dell:\n\n' + sweepBrief(sweep)
      + '\n\nOwner question: ' + question,
  });

  const budget = agent.maxTokens || 1200;
  try {
    const providers = require('./providers');
    const call = (maxTokens) => providers.chat({
      provider: agent.provider,
      model: agent.model || undefined,
      maxTokens,
      system: askSystem(agent),
      messages: convo,
    });
    let res = await call(budget);
    let text = normalizeRundown(res && res.content);
    if (!text) {
      res = await call(Math.max(2400, budget * 2));
      text = normalizeRundown(res && res.content);
    }
    if (!text) throw new Error('empty answer (lane returned reasoning only)');
    return {
      ok: true,
      text: clip(text, 4000),
      ms: Date.now() - startedAt,
      provider: (res && res.provider) || agent.provider,
      model: (res && res.model) || agent.model || '',
      error: '',
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      ms: Date.now() - startedAt,
      provider: agent.provider,
      model: agent.model || '',
      error: clip(err && err.message ? err.message : String(err), 300),
    };
  }
}

/** Ask one agent a question. Throws only for validation / busy / cooldown. */
async function askQuestion({ agentId, question, by = 'owner-dashboard' } = {}) {
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent) throw new Error('agent must be one of: ' + AGENTS.map((a) => a.id).join(', '));
  const q = String(question || '').replace(/\s+/g, ' ').trim();
  if (q.length < 3) throw new Error('question is too short');
  if (q.length > ASK_MAX_CHARS) throw new Error('question is too long (max ' + ASK_MAX_CHARS + ' characters)');
  if (askInflight.has(agent.id)) throw new Error(agent.label + ' is still answering the previous question');
  const last = askLastAt.get(agent.id) || 0;
  if (Date.now() - last < ASK_MIN_GAP_MS) throw new Error('give it a second before asking again');
  askLastAt.set(agent.id, Date.now());

  const run = (async () => {
    const cached = lastState || readState();
    let sweep = null;
    let fresh = false;
    if (cached && cached.sweep && cached.ranAt) {
      const age = Date.now() - Date.parse(cached.ranAt);
      if (Number.isFinite(age) && age >= 0 && age < THROTTLE_MS) {
        sweep = { ...cached.sweep, host: cached.host, checks: cached.sweep.checks || [] };
      }
    }
    if (!sweep) {
      sweep = await autoAgent.runAutoAgent({ trigger: 'security-ask', force: true });
      fresh = true;
    }
    const history = recentAsks(agent.id);
    const answer = await askAgentQuestion(agent, sweep, q, history);
    const entry = {
      q,
      a: answer.text,
      ok: answer.ok,
      error: answer.error || '',
      at: new Date().toISOString(),
      ms: answer.ms,
      model: answer.model,
      provider: answer.provider,
      sweepAt: sweep.finishedAt || null,
      sweepState: sweep.state || null,
      sweepFresh: fresh,
      by,
    };
    const all = readAsks();
    all[agent.id] = [entry].concat(Array.isArray(all[agent.id]) ? all[agent.id] : []).slice(0, ASK_LIMIT);
    try { writeAsks(all); } catch (err) { console.warn('[security-agents] ask log write failed:', err.message); }
    return {
      ok: answer.ok,
      agent: agent.id,
      label: agent.label,
      question: q,
      answer: answer.text,
      error: answer.error || '',
      ms: answer.ms,
      provider: answer.provider,
      model: answer.model,
      sweepAt: entry.sweepAt,
      sweepState: entry.sweepState,
      sweepFresh: fresh,
      ranAt: entry.at,
    };
  })();

  askInflight.set(agent.id, run);
  try { return await run; } finally { askInflight.delete(agent.id); }
}

function telegramRundown(state) {
  const lines = [
    `sweep ${state.sweep.state} · ${state.sweep.finishedAt} · ${state.sweep.durationMs}ms`,
    `checks: ${(state.sweep.checks || []).map((c) => `${c.id}=${c.state}`).join(' ')}`,
  ];
  for (const a of state.agents) {
    lines.push('', `${a.label} (${a.model || a.provider}) ${a.ok ? 'ok in ' + a.ms + 'ms' : 'FAILED: ' + a.error}`);
    if (a.ok) lines.push(a.rundown);
  }
  return clip(lines.join('\n'), 3500);
}

async function notifyFleet(state) {
  try {
    const bots = require('./telegramBots');
    if (bots && typeof bots.sendReconResult === 'function') {
      await bots.sendReconResult('security agents', telegramRundown(state));
    }
  } catch (err) {
    console.warn('[security-agents] telegram rundown failed:', err && err.message);
  }
}

async function doRun({ trigger = 'manual', only = null, notify = false } = {}) {
  const sweep = await autoAgent.runAutoAgent({ trigger: 'security-agents', force: true });
  const targets = only ? AGENTS.filter((a) => a.id === only) : AGENTS;
  const agents = [];
  for (const agent of targets) {
    // Sequential on purpose: two cloud lanes at once on a 7.7 Gi box with a
    // loaded CPU only makes both slower, and Codex CLI is the slow one.
    agents.push(await askAgent(agent, sweep));
  }

  const previous = lastState || readState() || {};
  const merged = AGENTS.map((a) => {
    const fresh = agents.find((x) => x.id === a.id);
    if (fresh) return fresh;
    const old = (previous.agents || []).find((x) => x.id === a.id);
    return old || { id: a.id, label: a.label, provider: a.provider, model: a.model, ok: false, ms: 0, ranAt: null, rundown: '', error: 'not run yet', fallback: false };
  });

  const state = {
    running: false,
    trigger,
    ranAt: new Date().toISOString(),
    scheduleMs: SCHEDULE_MS,
    throttleMs: THROTTLE_MS,
    host: sweep.host,
    sweep: {
      state: sweep.state,
      checks: sweep.checks || [],
      ip: sweep.ip || {},
      codeFindings: sweep.codeFindings || [],
      durationMs: sweep.durationMs,
      finishedAt: sweep.finishedAt,
      readOnly: true,
    },
    agents: merged,
  };

  const previousHistory = Array.isArray(previous.history) ? previous.history : [];
  state.history = [{
    ranAt: state.ranAt,
    trigger,
    sweepState: state.sweep.state,
    agents: merged.map((a) => ({ id: a.id, ok: a.ok, ms: a.ms, model: a.model })),
  }].concat(previousHistory).slice(0, HISTORY_LIMIT);

  writeState(state);
  lastState = state;
  if (notify) await notifyFleet(state);
  return state;
}

async function runSecurityAgents({ trigger = 'manual', force = false, only = null, notify = false } = {}) {
  if (currentRun) return { ...(await currentRun), reused: true };
  const cached = lastState || readState();
  if (!force && cached && cached.ranAt) {
    const age = Date.now() - Date.parse(cached.ranAt);
    if (Number.isFinite(age) && age >= 0 && age < THROTTLE_MS) {
      return { ...cached, reused: true, nextRunInMs: THROTTLE_MS - age };
    }
  }
  currentRun = doRun({ trigger, only, notify }).finally(() => { currentRun = null; });
  return currentRun;
}

function getState() {
  const cached = lastState || readState();
  if (!cached) {
    return {
      running: Boolean(currentRun),
      scheduleMs: SCHEDULE_MS,
      throttleMs: THROTTLE_MS,
      ranAt: null,
      sweep: null,
      agents: AGENTS.map((a) => ({
        id: a.id, label: a.label, provider: a.provider, model: a.model,
        ok: false, ms: 0, ranAt: null, rundown: '', error: 'not run yet', fallback: false,
      })),
      history: [],
      asks: {},
    };
  }
  const asksFile = readAsks();
  const asks = {};
  for (const a of AGENTS) asks[a.id] = (asksFile[a.id] || []).slice(0, 3);
  return { ...cached, running: Boolean(currentRun), asks };
}

function startSecurityAgents({ app = null } = {}) {
  if (app) appRef = app;
  const kick = setTimeout(() => {
    runSecurityAgents({ trigger: 'startup', force: true, notify: true })
      .then((s) => console.log(`  ✓ Security agents ran on startup: sweep ${s.sweep && s.sweep.state}`))
      .catch((e) => console.warn('  ⚠ Security agents startup run failed:', e && e.message));
  }, STARTUP_DELAY_MS);
  if (typeof kick.unref === 'function') kick.unref();

  if (!timer) {
    timer = setInterval(() => {
      runSecurityAgents({ trigger: 'schedule', force: true, notify: true })
        .catch((e) => console.warn('  ⚠ Security agents scheduled run failed:', e && e.message));
    }, SCHEDULE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return kick;
}

module.exports = {
  AGENTS,
  STATE_FILE,
  SCHEDULE_MS,
  runSecurityAgents,
  askQuestion,
  recentAsks,
  getState,
  startSecurityAgents,
};
