'use strict';

const fs = require('fs');
const path = require('path');

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
  return path.join(cwd, '.hakster', 'memories', 'banks', `${bankSlug(section)}.json`);
}

function readBank(cwd, section) {
  return readJson(bankPath(cwd, section), []);
}

// Append deduped entries to a bank file, dedup by observation similarity, cap
// to BANK_CAP (drop oldest). Returns the bank size after write.
function persistBank(cwd, section, newEntries) {
  if (!newEntries || newEntries.length === 0) return readBank(cwd, section).length;
  ensureDir(path.join(cwd, '.hakster', 'memories', 'banks'));
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

function initMemory(cwd) {
  const haksterDir = path.join(cwd, '.hakster');
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

  const memoriesDir = path.join(cwd, '.hakster', 'memories');
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
function consolidateMemories(cwd) {
  const haksterDir = path.join(cwd, '.hakster');
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
    const headerMatch = existingMd.match(/^# haksterAi Memory\n(?:.*\n)*?## Project: haksterAi\n/s);
    const header = headerMatch ? headerMatch[0] : `# haksterAi Memory\n\n_Last consolidated: ${timestamp}_\n_Raw memories processed: ${memories.length}_\n_Skills extracted: 0_\n\n## Project: haksterAi\n`;

    // Rebuild with new section data appended
    let rebuilt = header.replace(
      /_Last consolidated:.*\n_Raw memories processed:.*\n_Skills extracted:.*\n/,
      `_Last consolidated: ${timestamp}\n_Raw memories processed: ${memories.length}\n_Skills extracted: 0\n`
    );

    // Append new observations to existing sections
    for (const section of MEMORY_SECTIONS) {
      const sectionRegex = new RegExp(`(### ${section}\\n)([\\s]*?)(?=###|##|$)`, 's');
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
  const skillsDir = path.join(cwd, '.hakster', 'skills');
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
  const memoryMdPath = path.join(cwd, '.hakster', 'MEMORY.md');
  const memoryContent = readText(memoryMdPath);

  // Step 4: Load skill index
  const skillIndexPath = path.join(cwd, '.hakster', 'skills', 'index.json');
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
  consolidateMemories,
  extractSkill,
  loadLearnedLessons,
  autoInit,
  readBank,
  bankPath,
  BANK_CAP,

  // Expose helpers for testing
  _jaccardSimilarity: jaccardSimilarity,
  _substringSimilarity: substringSimilarity,
  _generateId: generateId
};