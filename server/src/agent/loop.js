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

  // Kiro-inspired loop tools
  kiroPreToolGuard,
  kiroPostToolScore,
  kiroPromptFilter,
  kiroPreTaskGate,
  kiroRoundBudget,
  kiroTrackCallSignature,
  kiroDiagnosisTimeout,
  kiroExitCodeHandler,
 kiroPreToolGuard,
 kiroPostToolScore,
 kiroPromptFilter,
 kiroPreTaskGate,
 kiroRoundBudget,
 kiroTrackCallSignature,
 kiroDiagnosisTimeout,
 kiroExitCodeHandler,
 // Claude Code-inspired
 claudePreCompactGuard,
 claudePostCompactVerify,
 claudeStopEvaluator,
 claudeSubagentTracker,
 claudeTaskLogger,
 claudeSessionManager,
 claudePermissionHandler,
 claudeCwdChangeDetector,
 // Codex-inspired
 codexSandboxPolicy,
 codexApprovalGate,
 codexContextManager,
 // ReAct/Hermes-inspired
 reactCycleValidator,
 hermesMemoryConsolidation,
 hermesReflectionTrigger,
 hermesSkillExtractor,

  // Internal helpers exposed for testing
  _parseMemorySummary: parseMemorySummary,
  _countTagOverlap: countTagOverlap,
  _safeStat: safeStat,
  _safeRead: safeRead,
  _agentsMdCache: _agentsMdCache
};
// ============================================================
// KIRO-INSPIRED LOOP TOOLS (added — always add, never delete)
// Patterns sourced from Kiro CLI hooks: PreToolUse, PostToolUse,
// UserPromptSubmit, PreTaskExec, and round-budget enforcement.
// ============================================================

/**
 * KiroHook: PreToolUse guard
 * Mirrors Kiro's pre-tool-loop-guard.js — blocks repeated tool calls.
 * Tracks tool call signatures and blocks if the same signature appears
 * 2+ times in the recent window (configurable via LOOP_GUARD.KIRO_REPEAT_BLOCK).
 * @param {Object} ctx - { toolName, args, recentCalls: string[] }
 * @returns {{ block: boolean, reason?: string }}
 */
function kiroPreToolGuard(ctx) {
  const { toolName = 'unknown', args = {}, recentCalls = [] } = ctx || {};
  const sig = `${toolName}:${JSON.stringify(args).slice(0, 200)}`;
  const maxRepeats = LOOP_GUARD.KIRO_REPEAT_BLOCK || 2;
  const repeats = recentCalls.filter(s => s === sig).length;
  if (repeats >= maxRepeats) {
    return { block: true, reason: `Kiro pre-tool guard: blocked repeated call (${repeats}x): ${sig}` };
  }
  // Block known-dangerous tool patterns
  const dangerousPatterns = [
    { tool: 'shell', regex: /rm\s+-rf\s+\//, reason: 'Kiro guard: rm -rf / blocked' },
    { tool: 'shell', regex: /mkfs|dd\s+if=/, reason: 'Kiro guard: destructive disk op blocked' },
    { tool: 'shell', regex: /git\s+push\s+--force/, reason: 'Kiro guard: force push blocked without explicit approval' },
    { tool: 'shell', regex: />\s*\/dev\/sda/, reason: 'Kiro guard: raw device write blocked' },
  ];
  const argStr = typeof args === 'string' ? args : JSON.stringify(args);
  for (const pat of dangerousPatterns) {
    if (toolName === pat.tool && pat.regex.test(argStr)) {
      return { block: true, reason: pat.reason };
    }
  }
  return { block: false };
}

/**
 * KiroHook: PostToolUse progress scorer
 * Mirrors Kiro's post-tool-progress-score.js — scores tool result quality.
 * Returns a score 0-10 and updates loop state for reflection triggers.
 * @param {Object} ctx - { toolName, success, resultSize, hadError, duration }
 * @returns {{ score: number, quality: string, shouldReflect: boolean }}
 */
function kiroPostToolScore(ctx) {
  const { toolName = 'unknown', success = true, resultSize = 0, hadError = false, duration = 0 } = ctx || {};
  let score = 5; // baseline
  // Success bonus
  if (success && !hadError) score += 2;
  // Error penalty
  if (hadError) score -= 3;
  // Result size bonus (got data back)
  if (resultSize > 100) score += 1;
  if (resultSize > 1000) score += 1;
  // Duration penalty (slow calls are less efficient)
  if (duration > 30000) score -= 1;
  if (duration > 60000) score -= 1;
  // Clamp 0-10
  score = Math.max(0, Math.min(10, score));
  const quality = score >= 8 ? 'high' : score >= 5 ? 'medium' : 'low';
  // Trigger reflection on low scores
  const shouldReflect = score <= 2;
  return { score, quality, shouldReflect };
}

/**
 * KiroHook: UserPromptSubmit filter
 * Mirrors Kiro's UserPromptSubmit hook — rejects prompts that would
 * trigger destructive automation without explicit confirmation.
 * @param {string} prompt
 * @returns {{ reject: boolean, reason?: string, sanitized?: string }}
 */
function kiroPromptFilter(prompt) {
  if (!prompt || typeof prompt !== 'string') return { reject: false };
  const lower = prompt.toLowerCase();
  // Patterns that suggest destructive automation
  const destructivePatterns = [
    { regex: /drop\s+(table|database|schema)/, reason: 'Kiro prompt filter: DROP statement requires explicit confirmation' },
    { regex: /truncate\s+table/, reason: 'Kiro prompt filter: TRUNCATE requires explicit confirmation' },
    { regex: /delete\s+all\s+(files|data|records)/, reason: 'Kiro prompt filter: bulk deletion requires explicit confirmation' },
    { regex: /wipe\s+(the\s+)?(server|database|disk|machine)/, reason: 'Kiro prompt filter: wipe operation requires explicit confirmation' },
    { regex: /format\s+(the\s+)?(disk|drive|partition)/, reason: 'Kiro prompt filter: format operation requires explicit confirmation' },
  ];
  for (const pat of destructivePatterns) {
    if (pat.regex.test(lower)) {
      return { reject: true, reason: pat.reason };
    }
  }
  return { reject: false };
}

/**
 * KiroHook: PreTaskExec gate
 * Mirrors Kiro's PreTaskExec hook — blocks spec tasks that lack
 * approval or a clear target. Ensures tasks have required metadata.
 * @param {Object} task - { description, target, approved, trustLevel }
 * @returns {{ block: boolean, reason?: string }}
 */
function kiroPreTaskGate(task) {
  if (!task || typeof task !== 'object') return { block: true, reason: 'Kiro task gate: no task object provided' };
  if (!task.description || task.description.length < 3) {
    return { block: true, reason: 'Kiro task gate: task lacks meaningful description' };
  }
  if (!task.target) {
    return { block: true, reason: 'Kiro task gate: task lacks target (file path or service)' };
  }
  // Trust level check — tasks below trust 10 need explicit approval
  const trust = task.trustLevel || 0;
  if (trust < 10 && !task.approved) {
    return { block: true, reason: `Kiro task gate: task requires approval (trust ${trust} < 10)` };
  }
  return { block: false };
}

/**
 * KiroHook: Round budget enforcer
 * Mirrors Kiro's round budget system — enforces a finite round budget
 * and provides convergence nudges at different thresholds.
 * @param {Object} ctx - { round, maxRounds }
 * @returns {{ exhausted: boolean, phase: string, nudge?: string }}
 */
function kiroRoundBudget(ctx) {
  const { round = 0, maxRounds = 200 } = ctx || {};
  const pct = round / maxRounds;
  if (round >= maxRounds) {
    return { exhausted: true, phase: 'exhausted', nudge: 'Round budget exhausted. Ship current best result.' };
  }
  if (pct >= 0.8) {
    return { exhausted: false, phase: 'converge', nudge: 'Past 80% budget. Pick simplest working option, apply, verify, finish.' };
  }
  if (pct >= 0.67) {
    return { exhausted: false, phase: 'narrow', nudge: 'Past 67% budget. Narrow to the fix. Stop exploring alternatives.' };
  }
  return { exhausted: false, phase: 'build', nudge: null };
}

/**
 * KiroHook: Tool call signature tracker
 * Maintains a rolling window of tool call signatures for loop detection.
 * Mirrors Kiro's .kiro/state/tool-loop.json pattern.
 * @param {string[]} existing - current signature list
 * @param {string} sig - new signature to add
 * @param {number} maxWindow - max signatures to track (default 20)
 * @returns {string[]} - updated signature list
 */
function kiroTrackCallSignature(existing, sig, maxWindow) {
  const window = maxWindow || LOOP_GUARD.KIRO_CALL_WINDOW || 20;
  const list = Array.isArray(existing) ? [...existing] : [];
  list.push(sig);
  // Trim to window size (keep most recent)
  if (list.length > window) {
    return list.slice(list.length - window);
  }
  return list;
}

/**
 * KiroHook: Diagnosis timeout detector
 * Detects when the agent has made too many consecutive read-only calls
 * without a state-modifying action. Mirrors Kiro's idle-detection pattern.
 * Escalates warnings: ⚠️ → 🚨 → 🚨🚨
 * @param {Object} ctx - { readOnlyStreak, lastWriteAction }
 * @returns {{ triggered: boolean, level: string, message?: string }}
 */
function kiroDiagnosisTimeout(ctx) {
  const { readOnlyStreak = 0 } = ctx || {};
  if (readOnlyStreak < 5) return { triggered: false, level: 'none' };
  if (readOnlyStreak >= 7) {
    return { triggered: true, level: 'critical', message: '🚨🚨 DIAGNOSIS TIMEOUT: 7+ read-only calls without action. Act now or emit final answer.' };
  }
  if (readOnlyStreak >= 6) {
    return { triggered: true, level: 'urgent', message: '🚨 DIAGNOSIS TIMEOUT: 6 read-only calls without action. Run the fix now.' };
  }
  return { triggered: true, level: 'warning', message: '⚠️ DIAGNOSIS TIMEOUT: 5 read-only calls without action. Stop diagnosing, start fixing.' };
}

/**
 * KiroHook: Exit code handler
 * Mirrors Kiro's exit code 2 pattern — exit code 2 from a hook means
 * "block execution and return STDERR to the agent."
 * @param {number} code - exit code from tool/hook
 * @param {string} stderr - stderr output
 * @returns {{ block: boolean, feedback?: string }}
 */
function kiroExitCodeHandler(code, stderr) {
  if (code === 2) {
    return { block: true, feedback: `Kiro exit-code-2 block: ${stderr || 'blocked by hook'}` };
  }
  return { block: false };
}

// ============================================================
// CLAUDE CODE-INSPIRED LOOP TOOLS (added — always add, never delete)
// Patterns sourced from Claude Code hooks.ts hook events:
// PreToolUse, PostToolUse, Stop, Notification, PreCompact, PostCompact,
// SessionStart, SessionEnd, SubagentStart, SubagentStop, TaskCreated,
// TaskCompleted, CwdChanged, UserPromptSubmit, PermissionRequest
// ============================================================

/**
 * ClaudeHook: PreCompact context guard
 * Fires before context compaction. Decides if compaction is safe or
 * if critical context would be lost. Mirrors Claude Code PreCompactHookInput.
 * @param {Object} ctx - { tokenCount, maxTokens, activeTasks, pendingApprovals }
 * @returns {{ compact: boolean, preserve: string[], reason?: string }}
 */
function claudePreCompactGuard(ctx) {
  const { tokenCount = 0, maxTokens = 128000, activeTasks = 0, pendingApprovals = 0 } = ctx || {};
  const ratio = tokenCount / maxTokens;
  // Don't compact if we're not near the limit
  if (ratio < 0.7) {
    return { compact: false, preserve: [], reason: 'Context not near limit, no compaction needed' };
  }
  // Don't compact if there are pending approvals — could lose context
  if (pendingApprovals > 0) {
    return { compact: false, preserve: [], reason: `Pending approvals (${pendingApprovals}), deferring compaction` };
  }
  // Compact, but preserve active task context
  const preserve = [];
  if (activeTasks > 0) {
    preserve.push('active_tasks', 'current_file', 'current_phase');
  }
  return { compact: true, preserve, reason: `Compacting at ${Math.round(ratio * 100)}% capacity` };
}

/**
 * ClaudeHook: PostCompact context verifier
 * Fires after context compaction. Verifies critical context survived.
 * Mirrors Claude Code PostCompactHookInput.
 * @param {Object} ctx - { preservedKeys: string[], actualKeys: string[] }
 * @returns {{ verified: boolean, missing: string[] }}
 */
function claudePostCompactVerify(ctx) {
  const { preservedKeys = [], actualKeys = [] } = ctx || {};
  const actualSet = new Set(actualKeys.map(k => k.toLowerCase()));
  const missing = preservedKeys.filter(k => !actualSet.has(k.toLowerCase()));
  return { verified: missing.length === 0, missing };
}

/**
 * ClaudeHook: Stop condition evaluator
 * Fires when the agent considers stopping. Decides if the task is
 * actually complete or if the agent should continue. Mirrors StopHookInput.
 * @param {Object} ctx - { taskComplete, hasErrors, unverifiedChanges, openTodos }
 * @returns {{ shouldStop: boolean, reason?: string }}
 */
function claudeStopEvaluator(ctx) {
  const { taskComplete = false, hasErrors = false, unverifiedChanges = false, openTodos = 0 } = ctx || {};
  if (hasErrors) {
    return { shouldStop: false, reason: 'Claude stop evaluator: errors present, do not stop' };
  }
  if (unverifiedChanges) {
    return { shouldStop: false, reason: 'Claude stop evaluator: unverified changes, run verification first' };
  }
  if (openTodos > 0) {
    return { shouldStop: false, reason: `Claude stop evaluator: ${openTodos} open todos remaining` };
  }
  if (!taskComplete) {
    return { shouldStop: false, reason: 'Claude stop evaluator: task not marked complete' };
  }
  return { shouldStop: true };
}

/**
 * ClaudeHook: Subagent lifecycle tracker
 * Tracks sub-agent spawns and completions. Mirrors SubagentStartHookInput
 * and SubagentStopHookInput. Prevents runaway sub-agent spawning.
 * @param {Object} ctx - { active: number, max: number, action: 'start'|'stop' }
 * @returns {{ allow: boolean, reason?: string }}
 */
function claudeSubagentTracker(ctx) {
  const { active = 0, max = 5, action = 'start' } = ctx || {};
  if (action === 'start') {
    if (active >= max) {
      return { allow: false, reason: `Claude subagent tracker: max ${max} sub-agents reached` };
    }
    return { allow: true };
  }
  return { allow: true }; // stop always allowed
}

/**
 * ClaudeHook: Task lifecycle logger
 * Tracks task creation and completion. Mirrors TaskCreatedHookInput
 * and TaskCompletedHookInput. Useful for progress tracking and metrics.
 * @param {Object} ctx - { action: 'create'|'complete', taskId, taskDesc, duration }
 * @returns {{ logged: boolean, event: string }}
 */
function claudeTaskLogger(ctx) {
  const { action = 'create', taskId = 'unknown', taskDesc = '', duration = 0 } = ctx || {};
  const event = action === 'complete' ? 'task_completed' : 'task_created';
  const detail = action === 'complete' ? `Task ${taskId} completed in ${duration}ms` : `Task ${taskId} created: ${taskDesc}`;
  return { logged: true, event, detail };
}

/**
 * ClaudeHook: Session lifecycle manager
 * Handles session start/end context. Mirrors SessionStartHookInput
 * and SessionEndHookInput. Initializes or cleans up session state.
 * @param {Object} ctx - { action: 'start'|'end', sessionId, workDir }
 * @returns {{ initialized: boolean, cleanup: string[] }}
 */
function claudeSessionManager(ctx) {
  const { action = 'start', sessionId = 'unknown', workDir = '.' } = ctx || {};
  if (action === 'start') {
    return {
      initialized: true,
      cleanup: [],
      detail: `Session ${sessionId} started in ${workDir}`
    };
  }
  // end — return cleanup tasks
  return {
    initialized: false,
    cleanup: ['flush_memories', 'consolidate_skills', 'save_session_state'],
    detail: `Session ${sessionId} ending, cleanup needed`
  };
}

/**
 * ClaudeHook: Permission request handler
 * Evaluates permission requests for tool use. Mirrors PermissionRequestHookInput.
 * Uses trust level to decide auto-approve vs require confirmation.
 * @param {Object} ctx - { tool, args, trustLevel, isDestructive }
 * @returns {{ approved: boolean, reason?: string }}
 */
function claudePermissionHandler(ctx) {
  const { tool = 'unknown', trustLevel = 0, isDestructive = false } = ctx || {};
  // Destructive actions always need confirmation unless trust >= 30
  if (isDestructive && trustLevel < 30) {
    return { approved: false, reason: `Claude permission: destructive ${tool} requires trust 30+ (current: ${trustLevel})` };
  }
  // Non-destructive: auto-approve at trust 10+
  if (!isDestructive && trustLevel >= 10) {
    return { approved: true };
  }
  // Below trust 10: suggest mode, needs confirmation
  return { approved: false, reason: `Claude permission: trust ${trustLevel} < 10, confirmation required for ${tool}` };
}

/**
 * ClaudeHook: CWD change detector
 * Detects working directory changes mid-session. Mirrors CwdChangedHookInput.
 * Invalidates caches and re-injects steering when CWD changes.
 * @param {Object} ctx - { oldCwd, newCwd }
 * @returns {{ changed: boolean, actions: string[] }}
 */
function claudeCwdChangeDetector(ctx) {
  const { oldCwd = '', newCwd = '' } = ctx || {};
  if (oldCwd === newCwd) {
    return { changed: false, actions: [] };
  }
  return {
    changed: true,
    actions: ['invalidate_agents_md_cache', 'reload_steering', 'reset_file_cache', 'reinject_learned_lessons'],
    detail: `CWD changed: ${oldCwd} → ${newCwd}`
  };
}

// ============================================================
// CODEX-INSPIRED LOOP TOOLS (added — always add, never delete)
// Patterns sourced from Codex CLI codex-rs/core/src:
// SandboxPolicy, AskForApproval, approval_policy, sandbox_mode
// ============================================================

/**
 * CodexHook: Sandbox policy evaluator
 * Mirrors Codex's SandboxPolicy — restricts file writes and command
 * execution based on the current sandbox level.
 * @param {Object} ctx - { level: 'readonly'|'limited'|'full', path, operation }
 * @returns {{ allowed: boolean, reason?: string }}
 */
function codexSandboxPolicy(ctx) {
  const { level = 'full', path = '', operation = 'write' } = ctx || {};
  if (level === 'readonly') {
    if (operation === 'write' || operation === 'execute' || operation === 'delete') {
      return { allowed: false, reason: `Codex sandbox [readonly]: ${operation} blocked` };
    }
    return { allowed: true };
  }
  if (level === 'limited') {
    // Block writes outside project dir
    const blockedPaths = ['/etc', '/usr', '/boot', '/sys', '/proc', '/dev'];
    for (const bp of blockedPaths) {
      if (path.startsWith(bp)) {
        return { allowed: false, reason: `Codex sandbox [limited]: ${operation} on ${path} blocked (system path)` };
      }
    }
    return { allowed: true };
  }
  // full — everything allowed
  return { allowed: true };
}

/**
 * CodexHook: Approval policy gate
 * Mirrors Codex's AskForApproval — decides if an action needs explicit
 * user approval based on the approval policy.
 * @param {Object} ctx - { policy: 'never'|'onRequest'|'always', action, isDestructive }
 * @returns {{ needsApproval: boolean, reason?: string }}
 */
function codexApprovalGate(ctx) {
  const { policy = 'onRequest', action = '', isDestructive = false } = ctx || {};
  if (policy === 'always') {
    return { needsApproval: true, reason: `Codex approval [always]: ${action} requires approval` };
  }
  if (policy === 'never') {
    return { needsApproval: false };
  }
  // onRequest — only destructive actions need approval
  if (isDestructive) {
    return { needsApproval: true, reason: `Codex approval [onRequest]: destructive ${action} requires approval` };
  }
  return { needsApproval: false };
}

/**
 * CodexHook: Context window manager
 * Mirrors Codex's context_manager — tracks context window usage and
 * triggers compaction or truncation when approaching limits.
 * @param {Object} ctx - { tokensUsed, maxTokens, strategy: 'compact'|'truncate'|'summarize' }
 * @returns {{ action: string, threshold: number, reason?: string }}
 */
function codexContextManager(ctx) {
  const { tokensUsed = 0, maxTokens = 128000, strategy = 'compact' } = ctx || {};
  const ratio = tokensUsed / maxTokens;
  if (ratio >= 0.95) {
    return { action: strategy, threshold: ratio, reason: `Codex context: ${Math.round(ratio * 100)}% full, triggering ${strategy}` };
  }
  if (ratio >= 0.85) {
    return { action: 'warn', threshold: ratio, reason: `Codex context: ${Math.round(ratio * 100)}% full, approaching limit` };
  }
  return { action: 'none', threshold: ratio };
}

// ============================================================
// REACT/HERMES-INSPIRED LOOP TOOLS (added — always add, never delete)
// Patterns sourced from ReAct (Reason+Act) and Hermes/Nous agent loop:
// thought-action-observation cycle, memory consolidation, reflection
// ============================================================

/**
 * ReActHook: Thought-action-observation cycle validator
 * Validates that the ReAct cycle is progressing correctly — each step
 * should produce a thought, an action, and an observation.
 * @param {Object} ctx - { phase: 'thought'|'action'|'observation', hasContent, isEmpty }
 * @returns {{ valid: boolean, reason?: string }}
 */
function reactCycleValidator(ctx) {
 const { phase = 'thought', hasContent = false, isEmpty = true } = ctx || {};
 if (isEmpty || !hasContent) {
 return { valid: false, reason: `ReAct cycle: ${phase} phase produced no content` };
 }
 // Check for thought without action (stalling in thought)
 if (phase === 'thought' && ctx.consecutiveThoughts > 3) {
 return { valid: false, reason: `ReAct cycle: ${ctx.consecutiveThoughts} consecutive thoughts without action — stalling` };
 }
 // NEW: stop repeated identical tool calls
 if (ctx.recentActions) {
 const last = ctx.recentActions.slice(-4);
 const sameToolLoop =
 last.length >= 3 &&
 last.every(a =>
 a.type === 'tool' &&
 a.name === last[0].name &&
 JSON.stringify(a.args) === JSON.stringify(last[0].args)
 );
 if (sameToolLoop) {
 return {
 valid: false,
 reason: `Tool repeat-loop: ${last[0].name} called identically ${last.length}x — forcing reasoning output`,
 };
 }
 }

 return { valid: true };
}

/**
 * HermesHook: Memory consolidation trigger
 * Mirrors Hermes/Nous memory consolidation — decides when to consolidate
 * raw memories into structured memory based on volume and age.
 * @param {Object} ctx - { rawCount, threshold, oldestAge, lastConsolidation }
 * @returns {{ shouldConsolidate: boolean, reason?: string }}
 */
function hermesMemoryConsolidation(ctx) {
  const { rawCount = 0, threshold = 50, oldestAge = 0, lastConsolidation = 0 } = ctx || {};
  if (rawCount >= threshold) {
    return { shouldConsolidate: true, reason: `Hermes memory: ${rawCount} raw memories >= threshold ${threshold}` };
  }
  // Also trigger if oldest memory is very old (stale data)
  if (oldestAge > 3600000 && rawCount > 10) {
    return { shouldConsolidate: true, reason: `Hermes memory: oldest memory ${Math.round(oldestAge / 60000)}min old, consolidating` };
  }
  return { shouldConsolidate: false };
}

/**
 * HermesHook: Reflection trigger evaluator
 * Mirrors Hermes/Nous reflection — decides when the agent should pause
 * and reflect on its progress. Triggers on stalls, errors, or periodic.
 * @param {Object} ctx - { turnsSinceReflection, errorStreak, progressScore, lastReflection }
 * @returns {{ shouldReflect: boolean, reason?: string }}
 */
function hermesReflectionTrigger(ctx) {
  const { turnsSinceReflection = 0, errorStreak = 0, progressScore = 5, lastReflection = 0 } = ctx || {};
  // Reflect after many turns without reflection
  if (turnsSinceReflection >= 10) {
    return { shouldReflect: true, reason: `Hermes reflection: ${turnsSinceReflection} turns since last reflection` };
  }
  // Reflect on error streak
  if (errorStreak >= 3) {
    return { shouldReflect: true, reason: `Hermes reflection: ${errorStreak} consecutive errors` };
  }
  // Reflect on low progress score
  if (progressScore <= 3) {
    return { shouldReflect: true, reason: `Hermes reflection: progress score ${progressScore} is low` };
  }
  return { shouldReflect: false };
}

/**
 * HermesHook: Skill extraction evaluator
 * Mirrors Hermes/Nous skill extraction — decides when a pattern has
 * appeared enough times to warrant extraction into a reusable skill.
 * @param {Object} ctx - { pattern, occurrences, lastExtraction, category }
 * @returns {{ shouldExtract: boolean, reason?: string }}
 */
function hermesSkillExtractor(ctx) {
  const { pattern = '', occurrences = 0, lastExtraction = 0, category = 'general' } = ctx || {};
  if (occurrences >= 3 && !lastExtraction) {
    return { shouldExtract: true, reason: `Hermes skill: pattern "${pattern}" appeared ${occurrences}x, extracting` };
  }
  if (occurrences >= 5 && lastExtraction > 0) {
    return { shouldExtract: true, reason: `Hermes skill: pattern "${pattern}" appeared ${occurrences}x since last extraction, updating` };
  }
  return { shouldExtract: false };
}
