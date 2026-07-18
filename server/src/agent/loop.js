/**
 * haksterAi — Unified Agent Loop Module
 *
 * Synthesizes loop patterns from Claude Code, Codex CLI, Kiro, and Hermes/Nous
 * into a structured phase-based state machine that wraps and extends the
 * existing battle-tested agentLoop in index.js.
 *
 * Phases: THINK → PLAN → ACT → OBSERVE → REFLECT → CONSOLIDATE
 *
 * Exports:
 *   - AgentLoopPhase enum
 *   - loopPhaseTransitions map
 *   - shouldConsolidate(state)
 *   - shouldReflect(state)
 *   - injectAgentsMd(cwd)
 *   - injectLearnedLessons(cwd, contextTags)
 *   - trustEscalation object
 */

const fs = require('fs');
const path = require('path');

// ── Phase Enum ──────────────────────────────────────────────────────────────

const AgentLoopPhase = {
  THINK: 0,
  PLAN: 1,
  ACT: 2,
  OBSERVE: 3,
  REFLECT: 4,
  CONSOLIDATE: 5
};

// ── Phase Transition Map ─────────────────────────────────────────────────────

const loopPhaseTransitions = {
  [AgentLoopPhase.THINK]: [AgentLoopPhase.PLAN],
  [AgentLoopPhase.PLAN]: [AgentLoopPhase.ACT],
  [AgentLoopPhase.ACT]: [AgentLoopPhase.OBSERVE],
  [AgentLoopPhase.OBSERVE]: [AgentLoopPhase.REFLECT, AgentLoopPhase.THINK],
  [AgentLoopPhase.REFLECT]: [AgentLoopPhase.CONSOLIDATE, AgentLoopPhase.THINK],
  [AgentLoopPhase.CONSOLIDATE]: [AgentLoopPhase.THINK]
};

// ── Loop-Guard Config ────────────────────────────────────────────────────────

const LOOP_GUARD = {
  CONSOLIDATION_INTERVAL: 25,           // turns between auto-consolidation
  CONSOLIDATION_THRESHOLD: 10,           // raw memory count threshold
  CONSOLIDATION_THROTTLE: 10,           // min turns between consolidations
  NO_PROGRESS_REFLECT: 3,               // no-progress count triggers REFLECT
  SAME_TOOL_ERROR_REFLECT: 3,            // same-tool errors trigger REFLECT
  SELF_RECURSION_LIMIT: 10,             // consecutive THINK→PLAN without ACT
  MEMORY_INJECTION_BUDGET: 2000,         // max chars for memory injection in prompt
  SUMMARY_TOKEN_BUDGET: 1500,            // max tokens for learned lessons injection
  AGENTS_MD_CACHE_TTL: 30000             // mtime cache TTL in ms (30s)
};

// ── shouldConsolidate ────────────────────────────────────────────────────────
/**
 * Determines whether the CONSOLIDATE phase should be triggered.
 *
 * Triggers on:
 *   - rawMemoryCount >= CONSOLIDATION_THRESHOLD (10)
 *   - turn % CONSOLIDATION_INTERVAL === 0 (every 25 turns)
 *   - session end signal (isSessionEnd === true)
 *   - explicit /consolidate command
 *
 * Throttle: max 1 consolidation per CONSOLIDATION_THROTTLE (10) turns.
 *
 * @param {object} state - Current loop state
 * @param {number} state.turn - Current turn number
 * @param {number} state.rawMemoryCount - Number of raw memories
 * @param {number} state.lastConsolidationTurn - Turn of last consolidation
 * @param {boolean} [state.isSessionEnd] - Whether session is ending
 * @param {boolean} [state.explicitConsolidate] - Whether user invoked /consolidate
 * @returns {boolean}
 */
function shouldConsolidate(state) {
  const { turn = 0, rawMemoryCount = 0, lastConsolidationTurn = -Infinity } = state;
  const { isSessionEnd = false, explicitConsolidate = false } = state;

  // Throttle: never consolidate within CONSOLIDATION_THROTTLE turns of last one
  if (turn - lastConsolidationTurn < LOOP_GUARD.CONSOLIDATION_THROTTLE) {
    return false;
  }

  // Trigger: raw memory threshold
  if (rawMemoryCount >= LOOP_GUARD.CONSOLIDATION_THRESHOLD) return true;

  // Trigger: interval (every N turns)
  if (turn > 0 && turn % LOOP_GUARD.CONSOLIDATION_INTERVAL === 0) return true;

  // Trigger: session end
  if (isSessionEnd) return true;

  // Trigger: explicit /consolidate
  if (explicitConsolidate) return true;

  return false;
}

// ── shouldReflect ────────────────────────────────────────────────────────────
/**
 * Determines whether the REFLECT phase should be triggered based on
 * loop detection signals.
 *
 * Triggers on any of:
 *   - noProgressCount >= 3
 *   - semanticLoopDetected === true
 *   - sameToolErrorCount >= 3
 *   - isClarifyingQuestion === true
 *   - isFilesystemWandering === true
 *
 * @param {object} state - Current loop state
 * @param {number} state.noProgressCount - Consecutive turns without real progress
 * @param {boolean} state.semanticLoopDetected - Semantic loop detected
 * @param {number} state.sameToolErrorCount - Same tool error streak count
 * @param {boolean} state.isClarifyingQuestion - Last message was clarifying question
 * @param {boolean} state.isFilesystemWandering - Detected filesystem wandering
 * @returns {boolean}
 */
function shouldReflect(state) {
  const {
    noProgressCount = 0,
    semanticLoopDetected = false,
    sameToolErrorCount = 0,
    isClarifyingQuestion = false,
    isFilesystemWandering = false
  } = state;

  if (noProgressCount >= LOOP_GUARD.NO_PROGRESS_REFLECT) return true;
  if (semanticLoopDetected) return true;
  if (sameToolErrorCount >= LOOP_GUARD.SAME_TOOL_ERROR_REFLECT) return true;
  if (isClarifyingQuestion) return true;
  if (isFilesystemWandering) return true;

  return false;
}

// ── AGENTS.md Walk-Up Discovery ──────────────────────────────────────────────

const _agentsMdCache = new Map();

/**
 * Walks up from cwd to filesystem root looking for AGENTS.md files.
 * Checks both `dir/AGENTS.md` and `dir/.hakster/AGENTS.md`.
 * Caches content by mtime to avoid redundant reads.
 *
 * @param {string} cwd - Starting directory
 * @returns {string} Combined AGENTS.md content (empty string if none found)
 */
function injectAgentsMd(cwd) {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  const sections = [];

  while (dir !== root) {
    // Check dir/AGENTS.md
    const primary = path.join(dir, 'AGENTS.md');
    const primaryStat = safeStat(primary);
    if (primaryStat) {
      const cached = _agentsMdCache.get(primary);
      if (cached && cached.mtime === primaryStat.mtimeMs) {
        sections.push(cached.content);
      } else {
        const content = safeRead(primary);
        if (content) {
          _agentsMdCache.set(primary, { mtime: primaryStat.mtimeMs, content });
          sections.push(content);
        }
      }
    }

    // Check dir/.hakster/AGENTS.md
    const hakster = path.join(dir, '.hakster', 'AGENTS.md');
    const haksterStat = safeStat(hakster);
    if (haksterStat) {
      const cached = _agentsMdCache.get(hakster);
      if (cached && cached.mtime === haksterStat.mtimeMs) {
        sections.push(cached.content);
      } else {
        const content = safeRead(hakster);
        if (content) {
          _agentsMdCache.set(hakster, { mtime: haksterStat.mtimeMs, content });
          sections.push(content);
        }
      }
    }

    // Walk up
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n---\n\n');
}

// ── Learned Lessons Injection ─────────────────────────────────────────────────

/**
 * Loads .hakster/memory_summary.md and scores entries by relevance
 * to the current context. Returns top entries within token budget.
 *
 * Relevance scoring weights:
 *   - Tag match:      0.30
 *   - Recency:        0.20
 *   - Confidence:     0.20
 *   - Frequency:      0.15
 *   - Type priority:  0.15 (Errors > Patterns > Preferences > Conventions)
 *
 * @param {string} cwd - Project root directory
 * @param {string[]} contextTags - Tags from current context (files, tools, topics)
 * @returns {string} Formatted lessons string (empty if none found)
 */
function injectLearnedLessons(cwd, contextTags) {
  const summaryPath = path.join(cwd, '.hakster', 'memory_summary.md');
  const content = safeRead(summaryPath);
  if (!content) return '';

  const entries = parseMemorySummary(content);
  if (entries.length === 0) return '';

  const scored = entries.map(entry => {
    let score = 0;

    // Tag match (0.30)
    const tagOverlap = countTagOverlap(entry.tags || [], contextTags || []);
    score += (tagOverlap / Math.max(contextTags.length || 1, 1)) * 0.30;

    // Recency (0.20)
    const age = (Date.now() - (entry.timestamp || 0)) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 1 - age / 30) * 0.20; // linear decay over 30 days

    // Confidence (0.20)
    score += (entry.confidence || 0.5) * 0.20;

    // Frequency (0.15)
    score += Math.min(entry.frequency || 1, 5) / 5 * 0.15;

    // Type priority (0.15)
    const typePriority = { error: 1.0, pattern: 0.8, preference: 0.6, convention: 0.4 };
    score += (typePriority[entry.type] || 0.5) * 0.15;

    return { ...entry, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Build output within budget
  let budget = LOOP_GUARD.MEMORY_INJECTION_BUDGET;
  const lines = [];
  for (const entry of scored) {
    const line = formatLessonLine(entry);
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }

  return lines.length > 0
    ? '## 🧠 Learned Lessons\n' + lines.join('\n')
    : '';
}

// ── Trust Escalation ─────────────────────────────────────────────────────────

const trustEscalation = {
  // Per-session trust score
  _score: 0,
  _idleTurns: 0,
  _lastActivityTurn: 0,
  _denied: false,

  // Trust level thresholds
  levels: {
    SUGGEST: 0,
    AUTO_EDIT: 10,
    FULL_AUTO: 30
  },

  /**
   * Get current trust score
   * @returns {number}
   */
  getScore() {
    return this._score;
  },

  /**
   * Get current trust level name
   * @returns {string}
   */
  getLevel() {
    if (this._score >= this.levels.FULL_AUTO) return 'FULL_AUTO';
    if (this._score >= this.levels.AUTO_EDIT) return 'AUTO_EDIT';
    return 'SUGGEST';
  },

  /**
   * Check if an action is allowed at current trust level
   * @param {string} action - 'read', 'edit', 'test', 'build', 'destructive'
   * @returns {boolean}
   */
  isAllowed(action) {
    const level = this.getLevel();
    if (action === 'read') return true; // reads always allowed
    if (action === 'edit') return level !== 'SUGGEST'; // need AUTO_EDIT+
    if (action === 'test') return level !== 'SUGGEST';
    if (action === 'build') return true; // builds always allowed (non-destructive)
    if (action === 'destructive') return level === 'FULL_AUTO';
    return false;
  },

  /**
   * Record progress-earning activity
   * @param {string} type - 'read', 'edit', 'test', 'build'
   * @param {number} turn - Current turn number
   */
  recordActivity(type, turn) {
    const rewards = { read: 1, edit: 2, test: 3, build: 5 };
    this._score += rewards[type] || 0;
    this._idleTurns = 0;
    this._lastActivityTurn = turn;
  },

  /**
   * Apply idle decay — call once per turn
   * @param {number} turn - Current turn number
   */
  decay(turn) {
    if (turn - this._lastActivityTurn >= 5) {
      this._score = Math.max(0, this._score - 1);
      this._lastActivityTurn = turn;
    }
  },

  /**
   * Record a destructive action denial — resets trust to 0
   */
  recordDenial() {
    this._score = 0;
    this._denied = true;
  },

  /**
   * Reset trust for a new session
   */
  reset() {
    this._score = 0;
    this._idleTurns = 0;
    this._lastActivityTurn = 0;
    this._denied = false;
  }
};

// ── Phase Transition Guard ────────────────────────────────────────────────────

/**
 * Validates a phase transition. Returns true if valid, false if invalid.
 *
 * Invalid transitions:
 *   - Transition not in loopPhaseTransitions
 *   - Self-recursion: 10+ consecutive THINK→PLAN without ACT
 *
 * @param {number} from - Current phase (AgentLoopPhase value)
 * @param {number} to - Proposed next phase
 * @param {object} state - Loop state with self-recursion tracking
 * @param {number} [state.thinkPlanStreak] - Consecutive THINK→PLAN cycles
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validatePhaseTransition(from, to, state) {
  const allowed = loopPhaseTransitions[from] || [];
  if (!allowed.includes(to)) {
    return { allowed: false, reason: `Invalid transition: ${phaseName(from)} → ${phaseName(to)}` };
  }

  // Self-recursion limit: THINK→PLAN without ACT
  const thinkPlanStreak = (state && state.thinkPlanStreak) || 0;
  if (from === AgentLoopPhase.PLAN && to !== AgentLoopPhase.ACT && thinkPlanStreak >= LOOP_GUARD.SELF_RECURSION_LIMIT) {
    return { allowed: false, reason: `Self-recursion limit: ${thinkPlanStreak} THINK→PLAN cycles without ACT` };
  }

  return { allowed: true };
}

// ── Helper: Phase Name ───────────────────────────────────────────────────────

function phaseName(phase) {
  const names = {
    [AgentLoopPhase.THINK]: 'THINK',
    [AgentLoopPhase.PLAN]: 'PLAN',
    [AgentLoopPhase.ACT]: 'ACT',
    [AgentLoopPhase.OBSERVE]: 'OBSERVE',
    [AgentLoopPhase.REFLECT]: 'REFLECT',
    [AgentLoopPhase.CONSOLIDATE]: 'CONSOLIDATE'
  };
  return names[phase] || `UNKNOWN(${phase})`;
}

// ── Helper: Memory Summary Parser ────────────────────────────────────────────

/**
 * Parses memory_summary.md into structured entries.
 * Expected format:
 *   ## Section Name
 *   - observation text | tags: tag1,tag2 | conf: 0.8 | freq: 3 | type: pattern | ts: 2025-01-01
 *
 * Falls back to treating each line as a raw entry with minimal metadata.
 *
 * @param {string} content - Raw memory_summary.md content
 * @returns {Array<object>} Parsed entries
 */
function parseMemorySummary(content) {
  const entries = [];
  const lines = content.split('\n');
  let currentSection = 'general';

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (!bulletMatch) continue;

    const text = bulletMatch[1];

    // Try structured format: text | key: value pairs
    const parts = text.split('|').map(s => s.trim());
    const observation = parts[0] || text;
    const meta = {};

    for (let i = 1; i < parts.length; i++) {
      const kv = parts[i].match(/^(\w+):\s*(.+)/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
    }

    entries.push({
      observation,
      section: currentSection,
      tags: meta.tags ? meta.tags.split(',').map(t => t.trim()) : [currentSection],
      confidence: meta.conf ? parseFloat(meta.conf) : 0.5,
      frequency: meta.freq ? parseInt(meta.freq, 10) : 1,
      type: meta.type || 'pattern',
      timestamp: meta.ts ? new Date(meta.ts).getTime() : Date.now()
    });
  }

  return entries;
}

// ── Helper: Format Lesson Line ───────────────────────────────────────────────

function formatLessonLine(entry) {
  const tag = entry.section || 'general';
  return `- [${tag}] ${entry.observation}`;
}

// ── Helper: Tag Overlap ──────────────────────────────────────────────────────

function countTagOverlap(entryTags, contextTags) {
  if (!entryTags.length || !contextTags.length) return 0;
  const contextSet = new Set(contextTags.map(t => t.toLowerCase()));
  return entryTags.filter(t => contextSet.has(t.toLowerCase())).length;
}

// ── Helper: Safe File Ops ────────────────────────────────────────────────────

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch (_) { return null; }
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch (_) { return ''; }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  AgentLoopPhase,
  loopPhaseTransitions,
  LOOP_GUARD,
  shouldConsolidate,
  shouldReflect,
  injectAgentsMd,
  injectLearnedLessons,
  trustEscalation,
  validatePhaseTransition,
  phaseName,

  // Internal helpers exposed for testing
  _parseMemorySummary: parseMemorySummary,
  _countTagOverlap: countTagOverlap,
  _safeStat: safeStat,
  _safeRead: safeRead,
  _agentsMdCache: _agentsMdCache
};