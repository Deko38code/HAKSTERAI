'use strict';

const fs = require('fs');
const path = require('path');

// Resolve the real (non-root) operator's .hakster dir, even if this process was
// launched as root (which would otherwise point HOME at /root). Mirrors the same
// resolution used in ./mcp.js so both agree on one machine-independent path —
// single-operator box: exactly one non-root home dir under /home.
function resolveGhostHome() {
  if (process.env.HAKSTER_HOME) return process.env.HAKSTER_HOME;
  if (process.getuid && process.getuid() === 0) {
    if (process.env.SUDO_USER) {
      try {
        const { execFileSync } = require('child_process');
        const home = execFileSync('getent', ['passwd', process.env.SUDO_USER]).toString().trim().split(':')[5];
        if (home) return home;
      } catch { /* getent unavailable or user not found — fall through */ }
    }
    try {
      const users = fs.readdirSync('/home').filter((u) => u !== 'lost+found');
      if (users.length === 1) return path.join('/home', users[0]);
    } catch { /* /home unreadable — fall through */ }
  }
  return require('os').homedir();
}
const HAKSTER_DIR = path.join(resolveGhostHome(), '.hakster');

const {
  AgentLoopPhase,
  injectAgentsMd,
  injectLearnedLessons,
  trustEscalation,
  _parseMemorySummary,
  _countTagOverlap,
  _safeRead,
  _safeStat
} = require('./loop');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RAW_MEMORY_LIMIT = 500;   // consolidation room: store 5x more raw memories before evicting
const TAG_OVERLAP_THRESHOLD = 0.5;
const OBSERVATION_SIMILARITY_THRESHOLD = 0.6;
const SKILL_RECURRENCE_THRESHOLD = 3;
const SUMMARY_MAX_TOKENS = 1500;
const SUMMARY_CHARS_BUDGET = 6000; // ~1500 tokens at 4 chars/token
const BANK_CAP = 300;              // per-bank storage cap (each bank is its own "room")

// Memory banks ("consolidation rooms"). Each bank persists to its own JSON file
// under .hakster/memories/banks/<slug>.json so categories have dedicated,
// higher-capacity storage that survives across consolidation runs (Hermes-style
// per-store memory layout).
const MEMORY_SECTIONS = [
  'Patterns',
  'Errors Encountered',
  'User Preferences',
  'Conventions',
  'Project Facts',
  'Tools & Commands',
  'Recon & Targets',
  'Vulnerabilities & Findings',
  'Infrastructure & Network',
  'Lessons & Anti-patterns',
  'Playbooks & Workflows'
];

const MEMORY_SECTION_KEYS = {
  pattern: 'Patterns',
  error: 'Errors Encountered',
  preference: 'User Preferences',
  convention: 'Conventions',
  fact: 'Project Facts',
  tool: 'Tools & Commands',
  command: 'Tools & Commands',
  recon: 'Recon & Targets',
  target: 'Recon & Targets',
  vuln: 'Vulnerabilities & Findings',
  vulnerability: 'Vulnerabilities & Findings',
  finding: 'Vulnerabilities & Findings',
  infra: 'Infrastructure & Network',
  network: 'Infrastructure & Network',
  lesson: 'Lessons & Anti-patterns',
  antipattern: 'Lessons & Anti-patterns',
  playbook: 'Playbooks & Workflows',
  workflow: 'Playbooks & Workflows'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId() {
  const ts = Date.now();
  const seq = Math.floor(Math.random() * 10000);
  return `mem_${ts}_${seq}`;
}

function jaccardSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map(t => t.toLowerCase()));
  const setB = new Set(b.map(t => t.toLowerCase()));
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function substringSimilarity(a, b) {
  if (!a || !b) return 0;
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  if (sa === sb) return 1;
  if (sa.includes(sb) || sb.includes(sa)) {
    const longer = sa.length > sb.length ? sa : sb;
    const shorter = sa.length > sb.length ? sb : sa;
    return shorter.length / longer.length;
  }
  // Simple bigram overlap
  const bigramsA = new Set();
  for (let i = 0; i < sa.length - 1; i++) bigramsA.add(sa.substring(i, i + 2));
  const bigramsB = new Set();
  for (let i = 0; i < sb.length - 1; i++) bigramsB.add(sb.substring(i, i + 2));
  let overlap = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) overlap++;
  }
  const total = bigramsA.size + bigramsB.size;
  return total === 0 ? 0 : (2 * overlap) / total;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function writeText(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// initMemory(cwd)
// Creates .hakster/ directory structure and initial files.
// Returns the cwd path.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Per-bank storage ("consolidation rooms") — Hermes-style structured memory
// ---------------------------------------------------------------------------
function bankSlug(section) {
  return String(section).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function bankPath(cwd, section) {
  return path.join(HAKSTER_DIR, 'memories', 'banks', `${bankSlug(section)}.json`);
}

function readBank(cwd, section) {
  return readJson(bankPath(cwd, section), []);
}

// Append deduped entries to a bank file, dedup by observation similarity, cap
// to BANK_CAP (drop oldest). Returns the bank size after write.
function persistBank(cwd, section, newEntries) {
  if (!newEntries || newEntries.length === 0) return readBank(cwd, section).length;
  ensureDir(path.join(HAKSTER_DIR, 'memories', 'banks'));
  const all = readBank(cwd, section).slice();
  for (const entry of newEntries) {
    let dup = false;
    for (const e of all) {
      if (substringSimilarity(entry.observation, e.observation) > OBSERVATION_SIMILARITY_THRESHOLD) {
        e.confidence = Math.max(e.confidence || 0, entry.confidence || 0);
        for (const t of (entry.tags || [])) if (!(e.tags || []).includes(t)) (e.tags = e.tags || []).push(t);
        dup = true; break;
      }
    }
    if (!dup) all.push({
      id: entry.id || generateId(),
      timestamp: entry.timestamp || new Date().toISOString(),
      tags: entry.tags || [],
      observation: entry.observation,
      type: entry.type,
      confidence: entry.confidence || 0.5,
      bankedAt: new Date().toISOString()
    });
  }
  while (all.length > BANK_CAP) all.shift();
  writeJson(bankPath(cwd, section), all);
  return all.length;
}

function bankTypeForSection(section) {
  for (const [k, v] of Object.entries(MEMORY_SECTION_KEYS)) if (v === section) return k;
  return 'pattern';
}

// Hermes-style direct memory add: write an observation straight into a named
// bank without going through the raw -> consolidate pipeline.
function addMemoryToBank(cwd, section, observation, tags = [], opts = {}) {
  if (!section || !observation || typeof observation !== 'string') return false;
  const sec = MEMORY_SECTIONS.includes(section) ? section : 'Patterns';
  persistBank(cwd, sec, [{
    id: opts.id || generateId(),
    timestamp: opts.timestamp || new Date().toISOString(),
    tags: Array.isArray(tags) ? tags : [tags].filter(Boolean),
    observation,
    type: opts.type || bankTypeForSection(sec),
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.7
  }]);
  return true;
}

// ---------------------------------------------------------------------------
// pullMemoryBanks(cwd, opts) — read the per-bank stores built by
// addMemoryToBank/persistBank and hand back a clustered digest, grouped by
// bank (not flattened into one pile), so a task starts with relevant prior
// findings instead of the model rediscovering the same ground every time.
// readBank() was previously write-only outside this module — banks kept
// accumulating real content (patterns, errors, conventions, recon findings,
// playbooks, ...) but nothing ever pulled it back into context. Call this at
// the START of each task (not just once at session boot like buildSystemPrompt)
// so newly-banked lessons from earlier in the session are visible too.
// ---------------------------------------------------------------------------
const UNIVERSAL_BANK_SECTIONS = ['Lessons & Anti-patterns', 'Errors Encountered', 'User Preferences', 'Conventions'];

// ── Cross-agent memory: read Phantom's memory notes, read-only ─────────────
// Same machine, same operator — Phantom (phantom-cli.js) and haksterAi learn
// genuinely overlapping lessons. Read-only (never writes into Phantom's
// memory file) so there's no concurrent-write risk between the two agents.
const PHANTOM_MEMORY_FILE = '/home/ghost/.phantom-memory.json';
function getPhantomCrossMemoryText(limit = 8) {
  try {
    if (!fs.existsSync(PHANTOM_MEMORY_FILE)) return '';
    const mem = JSON.parse(fs.readFileSync(PHANTOM_MEMORY_FILE, 'utf8'));
    let notes = [];
    if (Array.isArray(mem.notes)) notes = mem.notes;
    else if (Array.isArray(mem.entries)) notes = mem.entries.map((e) => e.value || e.key || String(e));
    if (!notes.length) return '';
    return notes.slice(-limit).map((n) => `- ${String(n).slice(0, 200)}`).join('\n');
  } catch { return ''; }
}

// ── Cross-agent memory: read Claude Code's memory index, read-only ─────────
// Same machine, same operator — Claude Code (this CLI's own agent identity)
// keeps a separate persistent memory at ~/.claude/projects/-home-ghost/memory/
// (user profile, feedback, project facts, references) that never flows into
// haksterAi's own memory system. Read-only: this only reads Claude Code's
// index file (one-line hooks, no raw file bodies, no secrets) so haksterAi's
// context includes what Claude Code has already learned about the operator
// and this machine, without haksterAi ever writing back into it.
const CLAUDE_CODE_MEMORY_INDEX = '/home/ghost/.claude/projects/-home-ghost/memory/MEMORY.md';
function getClaudeCodeCrossMemoryText(limit = 12) {
  try {
    if (!fs.existsSync(CLAUDE_CODE_MEMORY_INDEX)) return '';
    const md = fs.readFileSync(CLAUDE_CODE_MEMORY_INDEX, 'utf8');
    const lines = md.split('\n')
      .map((l) => l.match(/^- \[(.+?)\]\(.+?\) — (.+)$/))
      .filter(Boolean)
      .map((m) => `- ${m[1]}: ${m[2]}`.slice(0, 220));
    if (!lines.length) return '';
    return lines.slice(0, limit).join('\n');
  } catch { return ''; }
}

function pullMemoryBanks(cwd, opts = {}) {
  const query = opts.query || '';
  const perBankLimit = opts.perBankLimit || 3;
  const maxChars = opts.maxChars || 1500;

  const scored = [];
  for (const section of MEMORY_SECTIONS) {
    const entries = readBank(cwd, section);
    if (entries.length === 0) continue;
    const isUniversal = UNIVERSAL_BANK_SECTIONS.includes(section);
    const ranked = entries
      .map((e) => ({ e, score: query ? substringSimilarity(query, e.observation || '') : (e.confidence || 0.5) }))
      .sort((a, b) => b.score - a.score);
    // Topical banks (recon, vulns, infra, tools, ...) only earn a slot when they
    // actually match this task; universal banks (lessons, errors, prefs,
    // conventions) are worth a look regardless of topic.
    const top = query && !isUniversal ? ranked.filter((r) => r.score > 0.15).slice(0, perBankLimit) : ranked.slice(0, perBankLimit);
    if (top.length > 0) scored.push({ section, items: top.map((r) => r.e) });
  }
  const phantomText = getPhantomCrossMemoryText();
  const claudeCodeText = getClaudeCodeCrossMemoryText();
  if (scored.length === 0 && !phantomText && !claudeCodeText) return '';

  let out = '## Memory Banks (pulled for this task)\n';
  let used = out.length;
  for (const bank of scored) {
    let block = `\n### ${bank.section}\n`;
    for (const item of bank.items) {
      const line = `- ${String(item.observation).slice(0, 220)}\n`;
      if (used + block.length + line.length > maxChars) break;
      block += line;
    }
    if (block.trim().split('\n').length <= 1) continue; // header only — nothing fit the budget
    if (used + block.length > maxChars) break;
    out += block;
    used += block.length;
  }
  if (phantomText) {
    const block = `\n### From Phantom (shared lessons, same machine)\n${phantomText}\n`;
    if (used + block.length <= maxChars) { out += block; used += block.length; }
  }
  if (claudeCodeText) {
    const block = `\n### From Claude Code (this CLI's own memory, read-only)\n${claudeCodeText}\n`;
    if (used + block.length <= maxChars) { out += block; used += block.length; }
  }
  return out.trim();
}

function initMemory(cwd) {
  const haksterDir = HAKSTER_DIR;
  const memoriesDir = path.join(haksterDir, 'memories');
  const skillsDir = path.join(haksterDir, 'skills');

  ensureDir(haksterDir);
  ensureDir(memoriesDir);
  ensureDir(skillsDir);

  // raw_memories.json
  const rawMemoriesPath = path.join(memoriesDir, 'raw_memories.json');
  if (!fs.existsSync(rawMemoriesPath)) {
    writeJson(rawMemoriesPath, []);
  }

  // MEMORY.md
  const memoryMdPath = path.join(haksterDir, 'MEMORY.md');
  if (!fs.existsSync(memoryMdPath)) {
    const timestamp = new Date().toISOString();
    const sections = MEMORY_SECTIONS.map(s => `### ${s}\n`).join('\n');
    const content = [
      '# haksterAi Memory',
      '',
      `_Last consolidated: ${timestamp}_`,
      `_Raw memories processed: 0_`,
      `_Skills extracted: 0_`,
      '',
      '## Project: haksterAi',
      '',
      sections,
      '## Cross-Project Patterns',
      ''
    ].join('\n');
    writeText(memoryMdPath, content);
  }

  // memory_summary.md
  const summaryPath = path.join(haksterDir, 'memory_summary.md');
  if (!fs.existsSync(summaryPath)) {
    const timestamp = new Date().toISOString();
    writeText(summaryPath, `# Memory Summary\n\n_Consolidated: ${timestamp}_\n\n_No lessons yet._\n`);
  }

  // skills/index.json
  const skillIndexPath = path.join(skillsDir, 'index.json');
  if (!fs.existsSync(skillIndexPath)) {
    writeJson(skillIndexPath, { skills: [], lastUpdated: new Date().toISOString() });
  }

  return cwd;
}

// ---------------------------------------------------------------------------
// addRawMemory(entry, cwd)
// Validates, deduplicates, and appends a raw memory entry.
// Returns boolean success.
// ---------------------------------------------------------------------------
function addRawMemory(entry, cwd) {
  // Validate required fields
  const required = ['id', 'timestamp', 'turn', 'phase', 'tags', 'observation', 'type', 'confidence'];
  for (const field of required) {
    if (entry[field] === undefined || entry[field] === null) {
      return false;
    }
  }

  // Validate type
  const validTypes = ['pattern','error','preference','convention','skill_candidate','tool','command','recon','target','vuln','vulnerability','finding','infra','network','lesson','antipattern','playbook','workflow','fact'];
  if (!validTypes.includes(entry.type)) {
    return false;
  }

  // Validate confidence range
  if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
    return false;
  }

  // Ensure tags is an array
  if (!Array.isArray(entry.tags)) {
    return false;
  }

  const memoriesDir = path.join(HAKSTER_DIR, 'memories');
  const rawMemoriesPath = path.join(memoriesDir, 'raw_memories.json');

  ensureDir(memoriesDir);
  const memories = readJson(rawMemoriesPath, []);

  // Deduplication check
  for (const existing of memories) {
    // Tag overlap check (Jaccard similarity > threshold)
    const tagSim = jaccardSimilarity(entry.tags, existing.tags);
    if (tagSim > TAG_OVERLAP_THRESHOLD) {
      // Increment confidence of existing entry, skip new
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      writeJson(rawMemoriesPath, memories);
      return false; // Duplicate — merged
    }

    // Observation substring similarity check
    const obsSim = substringSimilarity(entry.observation, existing.observation);
    if (obsSim > OBSERVATION_SIMILARITY_THRESHOLD) {
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      writeJson(rawMemoriesPath, memories);
      return false; // Duplicate — merged
    }
  }

  // Add new entry
  memories.push({
    id: entry.id || generateId(),
    timestamp: entry.timestamp || new Date().toISOString(),
    turn: entry.turn,
    phase: entry.phase,
    tags: entry.tags,
    observation: entry.observation,
    context: entry.context || {},
    type: entry.type,
    confidence: entry.confidence
  });

  // FIFO eviction if over limit
  while (memories.length > RAW_MEMORY_LIMIT) {
    memories.shift();
  }

  writeJson(rawMemoriesPath, memories);
  return true;
}

// ---------------------------------------------------------------------------
// consolidateMemories(cwd)
// Reads raw memories, groups by tags, deduplicates observations,
// merges into MEMORY.md sections, regenerates memory_summary.md,
// archives and clears raw memories.
// ---------------------------------------------------------------------------

// Actual pending raw-memory count — what shouldConsolidate()'s rawMemoryCount
// param is meant to receive (real count, not a proxy like tool-call count).
function getRawMemoryCount() {
  return readJson(path.join(HAKSTER_DIR, 'memories', 'raw_memories.json'), []).length;
}

function consolidateMemories(cwd) {
  const haksterDir = HAKSTER_DIR;
  const memoriesDir = path.join(haksterDir, 'memories');
  const rawMemoriesPath = path.join(memoriesDir, 'raw_memories.json');
  const memoryMdPath = path.join(haksterDir, 'MEMORY.md');
  const summaryPath = path.join(haksterDir, 'memory_summary.md');

  // Read raw memories
  const memories = readJson(rawMemoriesPath, []);
  if (memories.length === 0) {
    return { consolidated: 0, skillsExtracted: 0 };
  }

  // Group by type → section name
  const grouped = {};
  for (const mem of memories) {
    const sectionKey = MEMORY_SECTION_KEYS[mem.type] || 'Patterns';
    if (!grouped[sectionKey]) grouped[sectionKey] = [];
    grouped[sectionKey].push(mem);
  }

  // Deduplicate within each group
  const deduped = {};
  for (const [section, entries] of Object.entries(grouped)) {
    const kept = [];
    for (const entry of entries) {
      let isDuplicate = false;
      for (const existing of kept) {
        const sim = substringSimilarity(entry.observation, existing.observation);
        if (sim > OBSERVATION_SIMILARITY_THRESHOLD) {
          // Merge: keep higher confidence, combine tags
          existing.confidence = Math.max(existing.confidence, entry.confidence);
          for (const tag of entry.tags) {
            if (!existing.tags.includes(tag)) existing.tags.push(tag);
          }
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) kept.push(entry);
    }
    deduped[section] = kept;
  }

  // ── Persist each bank to its own storage room (per-bank JSON) ──
  for (const section of MEMORY_SECTIONS) {
    const entries = deduped[section] || [];
    if (entries.length > 0) persistBank(cwd, section, entries);
  }

  // Read existing MEMORY.md content (if exists)
  let existingMd = readText(memoryMdPath);
  const timestamp = new Date().toISOString();

  // Build new section content
  let newSections = '';
  for (const section of MEMORY_SECTIONS) {
    const entries = deduped[section] || [];
    newSections += `\n### ${section}\n`;
    if (entries.length > 0) {
      for (const entry of entries) {
        const tags = entry.tags.join(', ');
        newSections += `- **[${tags}]** ${entry.observation}\n`;
      }
    } else {
      newSections += '\n';
    }
  }

  // Reconstruct MEMORY.md with append-only for existing content
  if (existingMd) {
    // Find and replace sections in existing content
    // Strategy: keep header, replace section bodies
    // Plain indexOf, not regex: a backtracking `(?:.*\n)*?` header-scan over a large
    // MEMORY.md that doesn't contain the marker (e.g. header format drift) is
    // catastrophic-backtracking-prone and can peg the event loop for minutes,
    // hanging the whole server (diagnosed via CPU profile — 100% of the pegged
    // worker's self-time was this line).
    const headerMarker = '## Project: haksterAi\n';
    const markerIdx = existingMd.startsWith('# haksterAi Memory\n') ? existingMd.indexOf(headerMarker) : -1;
    const header = markerIdx !== -1 ? existingMd.slice(0, markerIdx + headerMarker.length) : `# haksterAi Memory\n\n_Last consolidated: ${timestamp}_\n_Raw memories processed: ${memories.length}_\n_Skills extracted: 0_\n\n## Project: haksterAi\n`;

    // Rebuild with new section data appended
    let rebuilt = header.replace(
      /_Last consolidated:.*\n_Raw memories processed:.*\n_Skills extracted:.*\n/,
      `_Last consolidated: ${timestamp}\n_Raw memories processed: ${memories.length}\n_Skills extracted: 0\n`
    );

    // Append new observations to existing sections
    for (const section of MEMORY_SECTIONS) {
      const sectionRegex = new RegExp(`(### ${section}\\n)([\\s\\S]*?)(?=###|##|$)`, 's');
      const entries = deduped[section] || [];
      const additions = entries.map(e => `- **[${e.tags.join(', ')}]** ${e.observation}`).join('\n');

      if (additions && rebuilt.match(sectionRegex)) {
        rebuilt = rebuilt.replace(sectionRegex, `$1$2${additions}\n`);
      }
    }

    // Append any new banks that don't yet exist in MEMORY.md
    for (const section of MEMORY_SECTIONS) {
      const entries = deduped[section] || [];
      const additions = entries.map(e => `- **[${e.tags.join(', ')}]** ${e.observation}`).join('\n');
      if (additions && !rebuilt.includes(`### ${section}`)) {
        rebuilt += `\n### ${section}\n${additions}\n`;
      }
    }

    // Add cross-project patterns section
    if (! rebuilt.includes('## Cross-Project Patterns')) {
      rebuilt += '\n## Cross-Project Patterns\n';
    }

    writeText(memoryMdPath, rebuilt);
  } else {
    // Create fresh MEMORY.md
    const content = [
      '# haksterAi Memory',
      '',
      `_Last consolidated: ${timestamp}`,
      `_Raw memories processed: ${memories.length}`,
      '_Skills extracted: 0',
      '',
      '## Project: haksterAi',
      newSections,
      '## Cross-Project Patterns',
      ''
    ].join('\n');
    writeText(memoryMdPath, content);
  }

  // Regenerate memory_summary.md within budget
  const fullMd = readText(memoryMdPath);
  const summaryLines = [];
  summaryLines.push('# Memory Summary');
  summaryLines.push('');
  summaryLines.push(`_Consolidated: ${timestamp}_`);
  summaryLines.push('');

  // Extract key lessons from MEMORY.md
  const lessonLines = fullMd.split('\n').filter(line => line.startsWith('- **'));
  let charBudget = SUMMARY_CHARS_BUDGET;
  for (const line of lessonLines) {
    if (charBudget <= 0) break;
    if (line.length <= charBudget) {
      summaryLines.push(line);
      charBudget -= line.length;
    } else {
      // Truncate to fit budget
      summaryLines.push(line.substring(0, charBudget - 3) + '...');
      charBudget = 0;
    }
  }

  if (summaryLines.length <= 3) {
    summaryLines.push('_No lessons yet._');
  }

  writeText(summaryPath, summaryLines.join('\n'));

  // Archive raw memories
  if (process.env.HAKSTER_RAW_ARCHIVE !== 'false') {
    const archiveName = `raw_memories_archive_${Date.now()}.json`;
    const archivePath = path.join(memoriesDir, archiveName);
    writeJson(archivePath, memories);
  }

  // Clear raw memories
  writeJson(rawMemoriesPath, []);

  // Try to extract skills
  const skillsExtracted = extractSkillFromMemories(memories, cwd);

  return {
    consolidated: memories.length,
    skillsExtracted
  };
}

// ---------------------------------------------------------------------------
// extractSkill(entries, cwd)
// Finds patterns recurring 3+ times, creates SKILL.md files.
// Returns number of skills extracted.
// ---------------------------------------------------------------------------
function extractSkill(entries, cwd) {
  return extractSkillFromMemories(entries, cwd);
}

function extractSkillFromMemories(entries, cwd) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  const skillsDir = path.join(HAKSTER_DIR, 'skills');
  const skillIndexPath = path.join(skillsDir, 'index.json');

  ensureDir(skillsDir);

  // Group entries by tag sets
  const tagGroups = {};
  for (const entry of entries) {
    if (entry.type !== 'pattern' && entry.type !== 'skill_candidate') continue;
    const key = [...entry.tags].sort().join('|');
    if (!tagGroups[key]) tagGroups[key] = [];
    tagGroups[key].push(entry);
  }

  // Find groups with 3+ occurrences
  const newSkills = [];
  for (const [tagKey, groupEntries] of Object.entries(tagGroups)) {
    if (groupEntries.length < SKILL_RECURRENCE_THRESHOLD) continue;

    const skillName = groupEntries[0].tags.slice(0, 3).join('-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!skillName) continue;

    const skillPath = path.join(skillsDir, `${skillName}.md`);
    if (fs.existsSync(skillPath)) continue; // Already exists

    const observations = groupEntries.map(e => e.observation);
    const avgConfidence = groupEntries.reduce((s, e) => s + e.confidence, 0) / groupEntries.length;

    const steps = observations.slice(0, 5).map((obs, i) => `${i + 1}. ${obs}`);
    const verification = `Confirm the pattern works by testing with: ${groupEntries[0].tags.join(', ')}`;

    const skillMd = [
      `# ${skillName}`,
      '',
      '## Description',
      observations[0] || 'Auto-extracted pattern from recurring observations.',
      '',
      '## Trigger',
      `Use when: ${groupEntries[0].tags.join(', ')}`,
      '',
      '## Steps',
      ...steps,
      '',
      '## Verification',
      verification,
      '',
      '## Source',
      `Auto-extracted from ${groupEntries.length} recurring observations on ${new Date().toISOString().split('T')[0]}`,
      '',
      '## Confidence',
      avgConfidence.toFixed(2)
    ].join('\n');

    writeText(skillPath, skillMd);
    newSkills.push({
      name: skillName,
      path: `skills/${skillName}.md`,
      tags: groupEntries[0].tags,
      confidence: avgConfidence,
      observationCount: groupEntries.length
    });
  }

  // Update skill index
  const existingIndex = readJson(skillIndexPath, { skills: [], lastUpdated: '' });
  for (const skill of newSkills) {
    // Don't add duplicate
    if (!existingIndex.skills.find(s => s.name === skill.name)) {
      existingIndex.skills.push(skill);
    }
  }
  existingIndex.lastUpdated = new Date().toISOString();
  writeJson(skillIndexPath, existingIndex);

  return newSkills.length;
}

// ---------------------------------------------------------------------------
// loadLearnedLessons(cwd, contextTags)
// Loads memory_summary.md and delegates to injectLearnedLessons from loop.js
// for relevance scoring. Returns formatted string.
// ---------------------------------------------------------------------------
function loadLearnedLessons(cwd, contextTags) {
  return injectLearnedLessons(cwd, contextTags || []);
}

// ---------------------------------------------------------------------------
// autoInit(cwd)
// 6-step flow:
// 1. initMemory — ensure .hakster/ structure
// 2. injectAgentsMd — load AGENTS.md steering
// 3. Load MEMORY.md content
// 4. Load skill index
// 5. Set trust escalation to 0
// 6. Return assembled prompt fragment
// ---------------------------------------------------------------------------
function autoInit(cwd) {
  // Step 1: Initialize memory structure
  initMemory(cwd);

  // Step 2: Load AGENTS.md steering content
  const agentsMd = injectAgentsMd(cwd) || '';

  // Step 3: Load MEMORY.md content
  const memoryMdPath = path.join(HAKSTER_DIR, 'MEMORY.md');
  const memoryContent = readText(memoryMdPath);

  // Step 4: Load skill index
  const skillIndexPath = path.join(HAKSTER_DIR, 'skills', 'index.json');
  const skillIndex = readJson(skillIndexPath, { skills: [], lastUpdated: '' });
  const skillNames = skillIndex.skills.map(s => s.name).join(', ');

  // Step 5: Reset trust escalation for new session
  trustEscalation.score = 0;
  trustEscalation.lastDecayTurn = 0;

  // Step 6: Assemble prompt fragment
  const parts = [];

  if (agentsMd) {
    parts.push('## Project Steering\n\n' + agentsMd);
  }

  if (memoryContent) {
    // Trim memory content to fit budget (2000 chars max for prompt injection)
    const trimmed = memoryContent.length > 2000
      ? memoryContent.substring(0, 2000) + '\n... (truncated)'
      : memoryContent;
    parts.push('## Learned Memory\n\n' + trimmed);
  }

  // Inject relevant learned lessons
  const contextTags = [];
  if (skillIndex.skills.length > 0) {
    for (const skill of skillIndex.skills) {
      contextTags.push(...skill.tags);
    }
  }
  const lessons = injectLearnedLessons(cwd, contextTags);
  if (lessons) {
    parts.push('## Relevant Lessons\n\n' + lessons);
  }

  if (skillNames) {
    parts.push('## Available Skills\n\n' + skillNames);
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  initMemory,
  addRawMemory,
  addMemoryToBank,
  getRawMemoryCount,
  consolidateMemories,
  extractSkill,
  loadLearnedLessons,
  autoInit,
  readBank,
  pullMemoryBanks,
  bankPath,
  BANK_CAP,
  MEMORY_SECTIONS,

  // Expose helpers for testing
  _jaccardSimilarity: jaccardSimilarity,
  _substringSimilarity: substringSimilarity,
  _generateId: generateId,
  getClaudeCodeCrossMemoryText
};