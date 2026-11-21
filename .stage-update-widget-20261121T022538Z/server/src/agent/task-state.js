'use strict';
// haksterAi — Persistent Task State ("never forget what I was doing")
//
// Tracks the current task across turns and sessions on disk so the agent
// always has its goal + the steps it already took injected into the system
// prompt every turn. The model never has to ask "what were we doing?".

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.env.HOME || '/home/ghost', '.hakster', 'task-state.json');
const MAX_STEPS = 30;          // sliding window of recent steps
const STALE_MS = 1000 * 60 * 60 * 6;  // a task older than 6h with no activity is auto-archived
const HISTORY_MAX = 20;

function _load() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { active: null, history: [] };
}
function _save(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (_) { /* non-blocking */ }
}

function _now() { return Date.now(); }
function _rel(ts) {
  if (!ts) return 'n/a';
  const d = Math.max(0, _now() - ts);
  if (d < 60000) return Math.round(d / 1000) + 's ago';
  if (d < 3600000) return Math.round(d / 60000) + 'm ago';
  return Math.round(d / 3600000) + 'h ago';
}
function _titleFrom(msg) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'untitled task';
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}
function _isContinuation(msg) {
  const s = String(msg || '').trim();
  if (!s) return true;
  if (s.length < 40) return true;
  return /^(ok|okay|k|yes|yeah|yep|continue|continuing|keep going|go on|go ahead|do it|and|so|then|next|now|also|what about|how about|try|instead|actually|wait|no\b|don't|redo|resume|finish|done\?|is it|are we)\b/i.test(s);
}

function _archive(state) {
  if (!state.active) return;
  state.history.unshift({
    title: state.active.title,
    startedAt: state.active.startedAt,
    endedAt: _now(),
    steps: (state.active.steps || []).slice(-10),
  });
  state.history = state.history.slice(0, HISTORY_MAX);
  state.active = null;
}

// Called at the start of each /api/agent/run. Decides whether to keep the
// active task or start a new one, then refreshes lastActive.
function init({ userMessage } = {}) {
  const state = _load();
  const now = _now();
  // Auto-archive stale tasks
  if (state.active && (now - (state.active.lastActive || state.active.startedAt || 0)) > STALE_MS) {
    _archive(state);
  }
  if (state.active) {
    if (_isContinuation(userMessage)) {
      // continuation — keep the task, just touch
      state.active.lastActive = now;
    } else {
      // new task — archive the old one and start fresh
      _archive(state);
      state.active = {
        title: _titleFrom(userMessage),
        startedAt: now,
        lastActive: now,
        steps: [],
      };
    }
  } else if (userMessage && String(userMessage).trim()) {
    state.active = {
      title: _titleFrom(userMessage),
      startedAt: now,
      lastActive: now,
      steps: [],
    };
  }
  _save(state);
  return state.active;
}

// Record a step (what the agent just did) so the agent never forgets progress.
function addStep(text) {
  const state = _load();
  if (!state.active) return;
  const line = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!line) return;
  // dedupe consecutive identical steps
  const last = state.active.steps[state.active.steps.length - 1];
  if (last && last.text === line) { state.active.lastActive = _now(); _save(state); return; }
  state.active.steps.push({ ts: _now(), text: line });
  if (state.active.steps.length > MAX_STEPS) state.active.steps = state.active.steps.slice(-MAX_STEPS);
  state.active.lastActive = _now();
  _save(state);
}

// Inject this into the system prompt every turn.
function summary() {
  const state = _load();
  const t = state.active;
  if (!t) return '';
  const steps = (t.steps || []).slice(-12);
  const stepsStr = steps.length
    ? steps.map((s, i) => `  ${i + 1}. ${s.text}`).join('\n')
    : '  (none yet — you are just starting)';
  const TODO_ICONS = { pending: '○', in_progress: '◐', done: '✔', blocked: '⛔' };
  const todos = (t.todos || []);
  const planStr = todos.length
    ? todos.map(x => `  [${TODO_ICONS[x.status] || '○'}] ${x.text}`).join('\n')
    : '  (no plan on file — write one with the update_todo tool BEFORE working)';
  return `\n\n## 🎯 Current Task — DO NOT FORGET THIS\nGoal: ${t.title}\nStarted: ${_rel(t.startedAt)} · Last active: ${_rel(t.lastActive)}\nPlan (from your update_todo list):\n${planStr}\nSteps so far:\n${stepsStr}\nRULE: You are in the middle of the task above. RESUME where you left off — do NOT restart from scratch, do NOT ask the user what to do, do NOT ask for clarification unless you hit a real blocker. Keep going until the goal is fully achieved, then confirm completion.`;
}

// Model-writable todo list (plan externalization — keeps a weak model on-task
// across a long round budget: it writes the plan here, the plan is re-read
// into context every turn by summary()).
function setTodos(todos) {
  const state = _load();
  if (!state.active) return;
  if (!Array.isArray(todos)) return;
  state.active.todos = todos.slice(0, 30).map(x => ({
    text: String(x.text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    status: ['pending', 'in_progress', 'done', 'blocked'].includes(x.status) ? x.status : 'pending',
  })).filter(x => x.text);
  state.active.lastActive = _now();
  _save(state);
}
function getTodos() {
  const state = _load();
  return (state.active && state.active.todos) || [];
}

function complete() {
  const state = _load();
  if (state.active) { _archive(state); _save(state); }
  return state.active;
}
function clear() {
  const state = _load();
  state.active = null;
  _save(state);
  return state;
}
function get() { return _load(); }

module.exports = { init, addStep, summary, setTodos, getTodos, complete, clear, get };
