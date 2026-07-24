'use strict';

/**
 * haksterAi Memory Engine v2
 * 
 * Upgrades over the old autolearn memory system:
 * - Importance scoring (0-1) per memory based on type, recency, frequency
 * - Time-based decay: old memories fade unless reinforced
 * - Semantic recall: token-based cosine similarity, not just tag overlap
 * - Entity extraction: file paths, services, tools, errors auto-tagged
 * - Structured MEMORY.md: Task Groups, User Preferences, Reusable Knowledge, Failure Shields
 * - Memory summary with user profile auto-generation
 * - 500-entry capacity with score-based eviction (was 100, FIFO)
 * - Cross-session persistence via JSON store with inverted index
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MEMORY_VERSION = 2;
const MAX_MEMORIES = 500;
const DECAY_HALF_LIFE_DAYS = 14;     // Memories lose half importance every 14 days unless reinforced
const RECALL_LIMIT = 15;             // Max memories to recall per query
const MIN_RECALL_SCORE = 0.15;       // Minimum similarity score to include in recall
const REINFORCEMENT_BOOST = 0.15;     // Score boost when a memory is recalled/reinforced
const MAX_SCORE = 1.0;
const CONSOLIDATION_THRESHOLD = 10;  // Tool calls before consolidation runs

// Memory types ranked by base importance
const TYPE_WEIGHTS = {
  preference: 0.95,     // User explicitly stated a preference
  decision: 0.90,        // An architectural or design decision was made
  fact: 0.85,           // A durable fact about the project/user/system
  failure_shield: 0.80, // A debugging pattern that worked
  skill: 0.70,           // A reusable procedure was identified
  task: 0.60,            // Task state (active/completed/blocked)
  observation: 0.40,    // A routine tool observation
  context: 0.30,         // Session context (time, mood, transient state)
  relationship: 0.50    // User identity / role / relationship data
};

// ---------------------------------------------------------------------------
// File paths helper
// ---------------------------------------------------------------------------
function haksterDir(cwd) {
 // Always use /home/ghost/.hakster regardless of who runs the process (root vs ghost)
 // This ensures memory data is consistent across PM2 (root) and manual runs (ghost)
 const home = '/home/ghost';
 return path.join(home, '.hakster');
}

function memoriesFilePath(cwd) {
  return path.join(haksterDir(cwd), 'memories', 'memory_store.json');
}

function indexPath(cwd) {
  return path.join(haksterDir(cwd), 'memories', 'memory_index.json');
}

function memoryMdPath(cwd) {
  return path.join(haksterDir(cwd), 'MEMORY.md');
}

function memorySummaryPath(cwd) {
  return path.join(haksterDir(cwd), 'memory_summary.md');
}

function archiveDir(cwd) {
  return path.join(haksterDir(cwd), 'memories');
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readText(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text);
}

// ---------------------------------------------------------------------------
// Tokenizer for semantic similarity
// ---------------------------------------------------------------------------
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s/.@-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function termFrequency(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  // Normalize
  const total = tokens.length || 1;
  for (const k in tf) tf[k] = tf[k] / total;
  return tf;
}

/**
 * Cosine similarity between two text strings using term frequency vectors.
 * Returns 0-1.
 */
function cosineSimilarity(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const tfA = termFrequency(tokensA);
  const tfB = termFrequency(tokensB);

  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (const t in tfA) {
    if (tfB[t]) dotProduct += tfA[t] * tfB[t];
    magA += tfA[t] * tfA[t];
  }
  for (const t in tfB) {
    magB += tfB[t] * tfB[t];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Longest common prefix, as a fraction of the shorter string's length.
 * Raw tool-output observations (search_files/shell dumps) often share long
 * literal prefixes — same paths, same grep hits — while cosine similarity
 * alone can dip just under threshold on the tail where they diverge.
 */
function prefixSimilarity(a, b) {
  if (!a || !b) return 0;
  const sa = a.toLowerCase();
  const sb = b.toLowerCase();
  const max = Math.min(sa.length, sb.length);
  let i = 0;
  while (i < max && sa[i] === sb[i]) i++;
  return max === 0 ? 0 : i / max;
}

/**
 * Two observations count as duplicates if they're near-identical overall
 * (cosine) OR share enough of a literal prefix that they're clearly the same
 * underlying tool output with a different tail (cosine alone misses these).
 */
function isNearDuplicate(a, b) {
  const sim = cosineSimilarity(a, b);
  if (sim > 0.75) return true;
  if (prefixSimilarity(a, b) > 0.6 && sim > 0.5) return true;
  // Same tool call ("[search_files] ...") re-run against the same files —
  // repeated recon on identical targets, even when the tail (grep hits) shifts
  // enough that cosine/prefix alone don't catch it.
  const tagA = /^\[(\w+)\]/.exec(a || '');
  const tagB = /^\[(\w+)\]/.exec(b || '');
  if (tagA && tagB && tagA[1] === tagB[1] && sim > 0.5) {
    const entA = new Set(extractEntities(a));
    const entB = new Set(extractEntities(b));
    if (entA.size > 0 && entB.size > 0) {
      let shared = 0;
      for (const e of entA) if (entB.has(e)) shared++;
      if (shared / Math.min(entA.size, entB.size) >= 1) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------
function extractEntities(text) {
  if (!text || typeof text !== 'string') return [];
  const entities = [];

  // File paths: /path/to/file or ./relative/path
  const paths = text.match(/(?:\.\/|\/)[\w\-./]+\.\w{1,5}/g);
  if (paths) entities.push(...paths.slice(0, 10));

  // PM2 process names: "PM2 process X" or "process X"
  const pm2Match = text.match(/PM2\s+process\s+(\S+)/gi);
  if (pm2Match) {
    for (const m of pm2Match) {
      entities.push(m.split(/\s+/).pop().replace(/[.,]/g, ''));
    }
  }

  // Ports: port XXXX
  const portMatch = text.match(/port\s+(\d{2,5})/gi);
  if (portMatch) {
    for (const m of portMatch) entities.push(m);
  }

  // Error patterns: "Error: X" or "failed: X"
  const errMatch = text.match(/(?:Error|error|ERROR|failed|FAILED):\s*(.{5,60})/g);
  if (errMatch) {
    for (const m of errMatch.slice(0, 5)) entities.push(m);
  }

  // URLs (sanitized — no full URLs with creds)
  const urlMatch = text.match(/https?:\/\/[\w.-]+\/[\w.-]+/g);
  if (urlMatch) entities.push(...urlMatch.slice(0, 5));

  // Dedupe
  return [...new Set(entities)];
}

// ---------------------------------------------------------------------------
// Importance scoring
// ---------------------------------------------------------------------------
function computeBaseScore(type) {
  return TYPE_WEIGHTS[type] || TYPE_WEIGHTS.observation;
}

function computeRecencyBoost(timestamp) {
  if (!timestamp) return 0;
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return 0.20;
  if (ageDays < 7) return 0.10;
  return 0;
}

function computeDecayFactor(timestamp, lastRecalledAt) {
  // Decay based on time since last reinforcement (recall or creation)
  const refTime = lastRecalledAt ? new Date(lastRecalledAt).getTime() : (timestamp ? new Date(timestamp).getTime() : Date.now());
  const ageDays = (Date.now() - refTime) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

function computeScore(entry) {
  const base = computeBaseScore(entry.type);
  const recencyBoost = computeRecencyBoost(entry.timestamp);
  const decay = computeDecayFactor(entry.timestamp, entry.lastRecalledAt);
  const frequencyBoost = Math.min(0.20, (entry.recallCount || 0) * 0.02);
  const rawScore = (base + recencyBoost + frequencyBoost) * decay;
  return Math.max(0.05, Math.min(MAX_SCORE, rawScore));
}

// ---------------------------------------------------------------------------
// Memory store operations
// ---------------------------------------------------------------------------
function loadStore(cwd) {
  const storePath = memoriesFilePath(cwd);
  let store = readJson(storePath, null);
  if (!store || !store.memories) {
    store = {
      version: MEMORY_VERSION,
      createdAt: new Date().toISOString(),
      memories: [],
      index: {}
    };
  }
  // Ensure each memory has a score and entities
  for (const m of store.memories) {
    if (!m.entities) m.entities = extractEntities(m.observation);
    if (m.score === undefined) m.score = computeScore(m);
  }
  return store;
}

function saveStore(cwd, store) {
  // Re-score all memories before saving (decay over time)
  for (const m of store.memories) {
    m.score = computeScore(m);
  }
  writeJson(memoriesFilePath(cwd), store);
  // Update inverted index
  rebuildIndex(cwd, store);
}

function rebuildIndex(cwd, store) {
  const index = {};
  for (const m of store.memories) {
    const tokens = new Set([...tokenize(m.observation), ...(m.tags || []), ...(m.entities || [])]);
    for (const t of tokens) {
      if (!index[t]) index[t] = [];
      index[t].push(m.id);
    }
  }
  writeJson(indexPath(cwd), { index, lastUpdated: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Add a memory
// ---------------------------------------------------------------------------
function addMemory(entry, cwd) {
  const store = loadStore(cwd);
  
  const id = entry.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const observation = entry.observation || '';
  const entities = extractEntities(observation);
  
  const newMem = {
    id,
    timestamp: entry.timestamp || new Date().toISOString(),
    type: entry.type || 'observation',
    tags: entry.tags || [],
    observation,
    context: entry.context || {},
    entities,
    score: 0,
    recallCount: 0,
    lastRecalledAt: null,
    reinforced: 0,
    createdAt: new Date().toISOString()
  };
  newMem.score = computeScore(newMem);

  // Check for duplicates using semantic similarity
  let isDuplicate = false;
  for (const existing of store.memories) {
    if (isNearDuplicate(existing.observation, newMem.observation)) {
      // Merge: boost the existing one, combine tags
      existing.reinforced = (existing.reinforced || 0) + 1;
      existing.recallCount = (existing.recallCount || 0) + 1;
      existing.lastRecalledAt = new Date().toISOString();
      for (const tag of newMem.tags) {
        if (!existing.tags.includes(tag)) existing.tags.push(tag);
      }
      for (const ent of entities) {
        if (!existing.entities.includes(ent)) existing.entities.push(ent);
      }
      // Upgrade type if new entry has higher weight
      if ((TYPE_WEIGHTS[newMem.type] || 0) > (TYPE_WEIGHTS[existing.type] || 0)) {
        existing.type = newMem.type;
      }
      isDuplicate = true;
      break;
    }
  }

  if (!isDuplicate) {
    store.memories.push(newMem);

    // Evict lowest-scoring memories if over capacity
    if (store.memories.length > MAX_MEMORIES) {
      store.memories.sort((a, b) => b.score - a.score);
      const evicted = store.memories.slice(MAX_MEMORIES);
      store.memories = store.memories.slice(0, MAX_MEMORIES);
      // Archive evicted memories
      archiveMemories(cwd, evicted);
    }
  }

  saveStore(cwd, store);
  return { id, isDuplicate, storeSize: store.memories.length };
}

// ---------------------------------------------------------------------------
// Archive evicted memories
// ---------------------------------------------------------------------------
function archiveMemories(cwd, memories) {
  if (memories.length === 0) return;
  const dir = archiveDir(cwd);
  ensureDir(dir);
  const archiveName = `evicted_${Date.now()}.json`;
  writeJson(path.join(dir, archiveName), {
    archivedAt: new Date().toISOString(),
    count: memories.length,
    memories
  });
}

// ---------------------------------------------------------------------------
// Recall: find relevant memories using semantic search + inverted index
// ---------------------------------------------------------------------------
function recall(query, cwd, opts = {}) {
  const limit = opts.limit || RECALL_LIMIT;
  const minScore = opts.minScore || MIN_RECALL_SCORE;
  const types = opts.types || null; // filter by types
  const store = loadStore(cwd);
  if (store.memories.length === 0) return [];

  const queryTokens = new Set(tokenize(query));
  const queryEntities = extractEntities(query);
  const queryTags = opts.tags || [];

  // First pass: index lookup to find candidate memories quickly
  const indexData = readJson(indexPath(cwd), { index: {} });
  const index = indexData.index || indexData;
  
  let candidates = new Set();
  for (const t of [...queryTokens, ...queryEntities, ...queryTags]) {
    if (index[t]) {
      for (const id of index[t]) candidates.add(id);
    }
  }

  // If no candidates from index, fall back to scanning all
  let scanList;
  if (candidates.size > 0) {
    scanList = store.memories.filter(m => candidates.has(m.id));
  } else {
    scanList = store.memories;
  }

  // Score each candidate by semantic similarity + tag overlap + entity overlap
  const scored = scanList.map(m => {
    const semSim = cosineSimilarity(m.observation, query);
    const tagOverlap = m.tags.filter(t => queryTags.includes(t)).length;
    const entityOverlap = (m.entities || []).filter(e => queryEntities.includes(e)).length;
    
    // Combined score: semantic similarity weighted highest
    const relevance = (semSim * 0.6) + Math.min(0.3, tagOverlap * 0.1) + Math.min(0.1, entityOverlap * 0.05);
    const finalScore = relevance * m.score; // Multiply by importance
    
    return { memory: m, relevance, finalScore };
  });

  // Filter by minimum score and sort
  const results = scored
    .filter(s => s.finalScore > minScore)
    .filter(s => !types || types.includes(s.memory.type))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit);

  // Reinforce recalled memories (boost their recall count)
  if (results.length > 0) {
    let changed = false;
    for (const r of results) {
      const mem = store.memories.find(m => m.id === r.memory.id);
      if (mem) {
        mem.recallCount = (mem.recallCount || 0) + 1;
        mem.lastRecalledAt = new Date().toISOString();
        mem.reinforced = (mem.reinforced || 0) + 1;
        changed = true;
      }
    }
    if (changed) saveStore(cwd, store);
  }

  return results.map(r => ({
    id: r.memory.id,
    type: r.memory.type,
    observation: r.memory.observation,
    tags: r.memory.tags,
    entities: r.memory.entities,
    score: r.memory.score,
    relevance: r.relevance,
    finalScore: r.finalScore,
    timestamp: r.memory.timestamp
  }));
}

// ---------------------------------------------------------------------------
// Consolidate memories into structured MEMORY.md and memory_summary.md
// ---------------------------------------------------------------------------
function consolidate(cwd) {
  const store = loadStore(cwd);
  const memories = store.memories;
  const timestamp = new Date().toISOString();

  // Group by type
  const byType = {};
  for (const t of Object.keys(TYPE_WEIGHTS)) byType[t] = [];
  for (const m of memories) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push(m);
  }

  // Sort each group by score descending
  for (const t in byType) {
    byType[t].sort((a, b) => b.score - a.score);
  }

  // Build MEMORY.md (structured, Codex-style schema)
  const lines = [
    '# haksterAi Memory',
    '',
    `_Last consolidated: ${timestamp}`,
    `_Memory engine: v${MEMORY_VERSION}`,
    `_Total memories: ${memories.length}`,
    `_Skills extracted: ${countSkills(cwd)}`,
    '',
    '## User Preferences',
  ];

  for (const m of byType.preference.slice(0, 20)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)}, recalled: ${m.recallCount || 0}x)_`);
  }
  if (byType.preference.length === 0) lines.push('_No preferences recorded yet._');

  lines.push('', '## Decisions');
  for (const m of byType.decision.slice(0, 15)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (byType.decision.length === 0) lines.push('_No decisions recorded yet._');

  lines.push('', '## Reusable Knowledge');
  for (const m of byType.fact.slice(0, 25)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (byType.fact.length === 0) lines.push('_No facts recorded yet._');

  lines.push('', '## Failure Shields');
  for (const m of byType.failure_shield.slice(0, 15)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (byType.failure_shield.length === 0) lines.push('_No failure shields recorded yet._');

  lines.push('', '## Active Task Groups');
  for (const m of byType.task.slice(0, 10)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (byType.task.length === 0) lines.push('_No active tasks._');

  lines.push('', '## Relationships');
  for (const m of byType.relationship.slice(0, 10)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (byType.relationship.length === 0) lines.push('_No relationship data._');

  lines.push('', '## Recent Observations');
  for (const m of byType.observation.slice(0, 10)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (byType.observation.length === 0) lines.push('_No observations._');

  lines.push('', '## Cross-Project Patterns');
  // Find memories that reference multiple project paths
  const crossProject = memories.filter(m => {
    const paths = (m.entities || []).filter(e => e.startsWith('/home/ghost/'));
    return new Set(paths).size >= 2;
  });
  for (const m of crossProject.slice(0, 10)) {
    lines.push(`- ${m.observation} _(score: ${m.score.toFixed(2)})_`);
  }
  if (crossProject.length === 0) lines.push('_No cross-project patterns yet._');

  lines.push('');
  writeText(memoryMdPath(cwd), lines.join('\n'));

  // Build memory_summary.md (user profile + index)
  const summaryLines = [
    '# Memory Summary',
    '',
    `_Consolidated: ${timestamp}_`,
    `_Memory engine: v${MEMORY_VERSION}_`,
    '',
    '## User Profile',
    `- Operator: ${extractUserProfile(memories)}`,
    `- Sessions tracked: ${countUniqueDays(memories)}`,
    `- Most active areas: ${extractTopAreas(memories)}`,
    '',
    '## Memory Stats',
    `- Total memories: ${memories.length}`,
    `- Preferences: ${byType.preference.length}`,
    `- Decisions: ${byType.decision.length}`,
    `- Facts: ${byType.fact.length}`,
    `- Failure shields: ${byType.failure_shield.length}`,
    `- Active tasks: ${byType.task.length}`,
    `- Skills extracted: ${countSkills(cwd)}`,
    `- Avg recall count: ${avgRecallCount(memories).toFixed(1)}`,
    `- Top memory score: ${memories.length > 0 ? Math.max(...memories.map(m => m.score)).toFixed(2) : '0'}`,
    '',
    '## What\'s in Memory',
    extractMemoryIndex(memories),
    ''
  ];
  writeText(memorySummaryPath(cwd), summaryLines.join('\n'));

  // Archive raw memories (old format compatibility)
  if (process.env.HAKSTER_RAW_ARCHIVE !== 'false') {
    const archiveName = `raw_memories_archive_${Date.now()}.json`;
    writeJson(path.join(archiveDir(cwd), archiveName), memories);
  }

  return {
    consolidated: memories.length,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
    skillsExtracted: 0
  };
}

// ---------------------------------------------------------------------------
// Helper functions for summary generation
// ---------------------------------------------------------------------------
function countSkills(cwd) {
  const skillIndex = path.join(haksterDir(cwd), 'skills', 'index.json');
  const data = readJson(skillIndex, { skills: [] });
  return data.skills ? data.skills.length : 0;
}

function extractUserProfile(memories) {
  // Try to find user name from relationship memories
  const relMems = memories.filter(m => m.type === 'relationship' || m.type === 'fact');
  for (const m of relMems) {
    const nameMatch = m.observation.match(/(?:User is|Operator:?)\s+([A-Za-z\s]+)/i);
    if (nameMatch) return nameMatch[1].trim();
  }
  return 'Ghost';
}

function countUniqueDays(memories) {
  const days = new Set();
  for (const m of memories) {
    if (m.timestamp) days.add(m.timestamp.split('T')[0]);
  }
  return days.size;
}

function extractTopAreas(memories) {
  const areas = {};
  for (const m of memories) {
    for (const e of (m.entities || [])) {
      if (e.startsWith('/home/ghost/')) {
        const project = e.split('/')[3] || 'unknown';
        areas[project] = (areas[project] || 0) + 1;
      }
    }
  }
  const sorted = Object.entries(areas).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return sorted.map(([k, v]) => `${k}(${v})`).join(', ') || 'none';
}

function avgRecallCount(memories) {
  if (memories.length === 0) return 0;
  return memories.reduce((sum, m) => sum + (m.recallCount || 0), 0) / memories.length;
}

function extractMemoryIndex(memories) {
  const types = {};
  for (const m of memories) {
    types[m.type] = (types[m.type] || 0) + 1;
  }
  return Object.entries(types).map(([k, v]) => `- ${k}: ${v}`).join('\n');
}

// ---------------------------------------------------------------------------
// Init: ensure directory structure and migrate old data
// ---------------------------------------------------------------------------
function init(cwd) {
  const hDir = haksterDir(cwd);
  ensureDir(hDir);
  ensureDir(path.join(hDir, 'memories'));
  ensureDir(path.join(hDir, 'memory'));
  ensureDir(path.join(hDir, 'skills'));

  // Initialize store if not exists
  const storePath = memoriesFilePath(cwd);
  if (!fs.existsSync(storePath)) {
    writeJson(storePath, {
      version: MEMORY_VERSION,
      createdAt: new Date().toISOString(),
      memories: [],
      index: {}
    });
  }

  // Initialize MEMORY.md if not exists
  const mdPath = memoryMdPath(cwd);
  if (!fs.existsSync(mdPath)) {
    writeText(mdPath, `# haksterAi Memory\n\n_Created: ${new Date().toISOString()}_\n\n_No memories yet._\n`);
  }

  // Initialize memory_summary.md if not exists
  const summaryPath = memorySummaryPath(cwd);
  if (!fs.existsSync(summaryPath)) {
    writeText(summaryPath, `# Memory Summary\n\n_Created: ${new Date().toISOString()}_\n\n_No memories yet._\n`);
  }

  // Initialize skills index if not exists
  const skillIndexPath = path.join(hDir, 'skills', 'index.json');
  if (!fs.existsSync(skillIndexPath)) {
    writeJson(skillIndexPath, { skills: [], lastUpdated: new Date().toISOString() });
  }

  // Migrate old raw_memories_archive files if present
  migrateOldArchives(cwd);

  return hDir;
}

// ---------------------------------------------------------------------------
// Migrate old raw_memories_archive_*.json files into the new store
// ---------------------------------------------------------------------------
function migrateOldArchives(cwd) {
  const dir = archiveDir(cwd);
  if (!fs.existsSync(dir)) return;
  
  const files = fs.readdirSync(dir).filter(f => f.startsWith('raw_memories_archive_') && f.endsWith('.json'));
  if (files.length === 0) return;

  const store = loadStore(cwd);
  let migrated = 0;

  for (const file of files) {
    const data = readJson(path.join(dir, file), []);
    const entries = Array.isArray(data) ? data : (data.memories || []);
    for (const entry of entries) {
      // Skip if already exists (check by observation similarity)
      const exists = store.memories.some(m => isNearDuplicate(m.observation, entry.observation || ''));
      if (!exists && entry.observation) {
        store.memories.push({
          id: entry.id || `migrated_${Date.now()}_${migrated}`,
          timestamp: entry.timestamp || new Date().toISOString(),
          type: entry.type || 'observation',
          tags: entry.tags || [],
          observation: entry.observation,
          context: entry.context || {},
          entities: extractEntities(entry.observation),
          score: 0,
          recallCount: 0,
          lastRecalledAt: null,
          reinforced: 0,
          createdAt: new Date().toISOString()
        });
        migrated++;
      }
    }
    // Rename old archive to .migrated
    try {
      fs.renameSync(path.join(dir, file), path.join(dir, file + '.migrated'));
    } catch {}
  }

  if (migrated > 0) {
    saveStore(cwd, store);
    console.log(`[memory-engine] Migrated ${migrated} old memories into new store`);
  }
}

// ---------------------------------------------------------------------------
// Get a prompt fragment for injection into agent system prompt
// ---------------------------------------------------------------------------
function getPromptFragment(cwd, opts = {}) {
  const maxChars = opts.maxChars || 2500;
  const store = loadStore(cwd);
  
  if (store.memories.length === 0) return '';

  // Get top-scoring memories across all types
  const sorted = [...store.memories].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 20);

  const lines = ['## Learned Memory (v2)', ''];
  
  // Group by type for readability
  const byType = {};
  for (const m of top) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push(m);
  }

  const typeLabels = {
    preference: 'User Preferences',
    decision: 'Decisions',
    fact: 'Knowledge',
    failure_shield: 'Failure Shields',
    task: 'Active Tasks',
    relationship: 'Relationship',
    context: 'Context',
    observation: 'Observations',
    skill: 'Skills'
  };

  for (const [type, label] of Object.entries(typeLabels)) {
    if (byType[type] && byType[type].length > 0) {
      lines.push(`### ${label}`);
      for (const m of byType[type].slice(0, 5)) {
        const obs = m.observation.length > 120 ? m.observation.substring(0, 117) + '...' : m.observation;
        lines.push(`- ${obs}`);
      }
      lines.push('');
    }
  }

  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = result.substring(0, maxChars) + '\n... (truncated)';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recall and format for agent prompt injection
// ---------------------------------------------------------------------------
function recallForPrompt(query, cwd, opts = {}) {
  const results = recall(query, cwd, opts);
  if (results.length === 0) return '';

  const lines = ['## Relevant Memories', ''];
  for (const r of results.slice(0, 8)) {
    const obs = r.observation.length > 150 ? r.observation.substring(0, 147) + '...' : r.observation;
    lines.push(`- [${r.type}] ${obs} _(relevance: ${r.finalScore.toFixed(2)})_`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Core operations
  init,
  addMemory,
  recall,
  consolidate,
  
  // Prompt injection
  getPromptFragment,
  recallForPrompt,
  
  // Helpers
  loadStore,
  saveStore,
  extractEntities,
  computeScore,
  cosineSimilarity,
  prefixSimilarity,
  isNearDuplicate,
  tokenize,
  
  // Constants
  MEMORY_VERSION,
  MAX_MEMORIES,
  CONSOLIDATION_THRESHOLD,
  TYPE_WEIGHTS,
  
  // For testing
  _haksterDir: haksterDir,
  _memoriesFilePath: memoriesFilePath,
  _indexPath: indexPath
};