'use strict';

/**
 * Peer memory — another box's agent memory, read read-only over ssh and shown
 * beside ours, never merged into ours.
 *
 * Owner (2026-11-26): "add parrot to clusters will help". The dashboard's
 * Memory Clusters panel counted only the banks on this box, so every memory the
 * agent banked while working on Parrot (junkalot / phantomide work) was absent
 * from the one screen that is supposed to show all top memories.
 *
 * What this module is:
 *   1. a READER — one bounded `ssh <alias> 'cat …'` that returns the peer's
 *      memory store, its word index and any bank files it has, in one round
 *      trip, cached so a page load does not pay for it twice;
 *   2. a SUMMARISER — the same shape the local banks endpoint returns, so the
 *      panel renders a peer with no special case. Two shapes are understood:
 *      the newer per-section banks (`memories/banks/*.json`) and the older
 *      single store (`memories/memory_store.json` + `memory_index.json`), which
 *      is what Parrot runs today.
 *
 * Rules it follows:
 *   - READ ONLY. It cats files and nothing else: no write, no mkdir, no fix-up,
 *     no import of the peer's entries into this box's banks (§16, §19.6).
 *   - NEVER MERGED. A peer's count is reported as the peer's, under its own
 *     host card, and is never added to this box's `total` — the same reason
 *     usage is read per user and per key rather than summed (§29.6, §52.3).
 *   - NEVER INVENTED. An unreachable peer says unreachable; a peer that
 *     answers with no entries says zero. Nothing is estimated (§10, §13).
 *   - BOUNDED. Every read has a hard timeout, and a timeout returns "pending"
 *     instead of hanging an admin page; the read keeps warming in the
 *     background so the next poll carries it (§51.7).
 */

const { execFile } = require('child_process');

// Peers whose memory we show. One entry today; adding another box is data, not
// a code change. `sshAlias` must exist in ~/.ssh/config (Host parrot → 10.0.0.251).
const PEER_HOSTS = [
  {
    host: 'parrot',
    sshAlias: 'parrot',
    label: 'Parrot',
    address: '10.0.0.251',
    role: 'junkalot + phantomide',
  },
];

const CACHE_MS = 5 * 60 * 1000;      // a good read stays fresh for 5 minutes
const FAIL_CACHE_MS = 60 * 1000;     // a failed read is not retried on every poll
const SPLIT = '__HAKSTER_SPLIT__';

// Same mapping autolearn uses, so a peer's entry lands in the same-named card
// the local panel already draws (autolearn.MEMORY_SECTION_KEYS).
const TYPE_TO_SECTION = {
  pattern: 'Patterns',
  error: 'Errors Encountered',
  preference: 'User Preferences',
  convention: 'Conventions',
  fact: 'Project Facts',
  tool: 'Tools & Commands',
  recon: 'Recon & Targets',
  vuln: 'Vulnerabilities & Findings',
  infra: 'Infrastructure & Network',
  lesson: 'Lessons & Anti-patterns',
  playbook: 'Playbooks & Workflows',
};

// One remote command, no interpolation of anything untrusted: the two legacy
// files, then every bank file the peer happens to have, each segment closed by
// the split marker so the parser never has to guess where a file ends.
const REMOTE_CMD = [
  // Reads only: two legacy files, then every bank file the peer has. Each
  // segment is closed by the split marker so the parser never guesses where a
  // file ends. No redirect and no write of any kind appears here.
  'cat $HOME/.hakster/memories/memory_store.json',
  `echo "${SPLIT}"`,
  'cat $HOME/.hakster/memories/memory_index.json',
  `echo "${SPLIT}"`,
  'for f in $HOME/.hakster/memories/banks/*.json; do [ -f "$f" ] && { echo "__BANK__ $(basename "$f")"; cat "$f"; echo "' + SPLIT + '"; }; done',
  // A peer with no bank files leaves that loop at status 1 (its last test
  // failed). That is a successful read of a peer with nothing banked, not a
  // failed one, so the command ends true — non-zero stays a real failure.
  'true',
].join('; ');

const _cache = new Map();     // host -> { at, ttl, summary }
const _inflight = new Map();  // host -> Promise<text>

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function sectionForType(type) {
  return TYPE_TO_SECTION[String(type || '').toLowerCase()] || 'Patterns';
}

function topEntry(entry) {
  return {
    observation: String(entry.observation || entry.value || '').slice(0, 320),
    type: entry.type || 'pattern',
    timestamp: entry.timestamp || null,
  };
}

function newestFirst(entries) {
  return entries.slice().sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

/**
 * Turn one peer's raw `cat` output into the shape the clusters panel renders.
 * Pure — no I/O — so the probe can exercise every shape against a fixture.
 *
 * @param {object} peer  a PEER_HOSTS entry
 * @param {string} text  raw remote output (may be '')
 * @param {object} opts  { topN, readAt, error }
 */
function summarizePeerMemory(peer, text, opts = {}) {
  const topN = Math.max(1, Math.min(Number(opts.topN) || 4, 20));
  const readAt = opts.readAt || new Date().toISOString();
  const base = {
    host: peer.host,
    label: peer.label,
    address: peer.address,
    role: peer.role || null,
    source: `~/.hakster/memories on ${peer.host} (read only, over ssh)`,
    readAt,
    note: 'Shown beside this box\'s banks, never added to them. Nothing is written back.',
  };
  if (opts.error) {
    return {
      ...base,
      reachable: false,
      shape: null,
      memories: 0,
      indexKeys: 0,
      banks: [],
      error: String(opts.error).slice(0, 160),
    };
  }

  const segments = String(text || '').split(SPLIT);
  const storeSeg = segments[0] || '';
  const indexSeg = segments[1] || '';
  const banksBySection = new Map();
  const addToBank = (section, entry) => {
    const key = section;
    if (!banksBySection.has(key)) banksBySection.set(key, []);
    banksBySection.get(key).push(entry);
  };

  // Newer shape: per-section bank files.
  let bankEntries = 0;
  for (const seg of segments.slice(2)) {
    const trimmed = seg.replace(/^\s+/, '');
    const marker = /^__BANK__\s+(\S+)\s*\n/.exec(trimmed);
    if (!marker) continue;
    const file = marker[1];
    const entries = parseJson(trimmed.slice(marker[0].length), []);
    if (!Array.isArray(entries)) continue;
    const section = file.replace(/\.json$/i, '').replace(/-+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    for (const entry of entries) {
      addToBank(section || sectionForType(entry && entry.type), topEntry(entry));
      bankEntries += 1;
    }
  }

  // Older shape: one store with a flat memories array (Parrot today).
  let storeMemories = 0;
  const store = parseJson(storeSeg, null);
  if (store && Array.isArray(store.memories)) {
    storeMemories = store.memories.length;
    for (const entry of store.memories) {
      addToBank(sectionForType(entry && entry.type), topEntry(entry));
    }
  }

  // The word index is keywords, not memories — counted separately so it can
  // never be read as a memory total.
  const index = parseJson(indexSeg, null);
  const indexKeys = index && index.index && typeof index.index === 'object'
    ? Object.keys(index.index).length
    : 0;

  const banks = [...banksBySection.entries()]
    .map(([section, entries]) => ({
      section,
      count: entries.length,
      top: newestFirst(entries).slice(0, topN),
    }))
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);

  const memories = bankEntries + storeMemories;

  return {
    ...base,
    reachable: true,
    shape: bankEntries > 0 ? 'banks' : storeMemories > 0 ? 'legacy-store' : 'empty',
    memories,
    indexKeys,
    lastUpdated: (index && index.lastUpdated) || (store && store.createdAt) || null,
    banks,
  };
}

function readPeerRaw(peer) {
  if (_inflight.has(peer.host)) return _inflight.get(peer.host);
  const p = new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', peer.sshAlias, REMOTE_CMD],
      { timeout: 12000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        _inflight.delete(peer.host);
        if (err) return reject(err);
        return resolve(String(stdout || ''));
      },
    );
  });
  _inflight.set(peer.host, p);
  return p;
}

/**
 * Read one peer, honouring the cache. `budgetMs` bounds how long a caller
 * waits: past it the promise resolves with `pending: true` and the read keeps
 * running in the background so the next poll carries the real figures.
 */
async function readPeer(peer, opts = {}) {
  const budgetMs = Math.max(200, Number(opts.budgetMs) || 6000);
  const topN = opts.topN;
  const hit = _cache.get(peer.host);
  if (hit && Date.now() - hit.at < hit.ttl) {
    return { ...hit.summary, cached: true };
  }
  let timer;
  const work = readPeerRaw(peer)
    .then((text) => {
      const summary = summarizePeerMemory(peer, text, { topN });
      _cache.set(peer.host, { at: Date.now(), ttl: CACHE_MS, summary });
      return summary;
    })
    .catch((err) => {
      const summary = summarizePeerMemory(peer, '', {
        topN,
        error: (err && err.message) || 'unreachable',
      });
      _cache.set(peer.host, { at: Date.now(), ttl: FAIL_CACHE_MS, summary });
      return summary;
    });
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ pending: true }), budgetMs);
  });
  const raced = await Promise.race([work, timeout]);
  clearTimeout(timer);
  if (raced && raced.pending) {
    return {
      host: peer.host,
      label: peer.label,
      address: peer.address,
      role: peer.role || null,
      reachable: null,
      pending: true,
      memories: 0,
      indexKeys: 0,
      banks: [],
      note: 'read still warming; the next poll carries it',
    };
  }
  return raced;
}

/** Every peer, in parallel, each bounded by the same budget. */
async function peerMemorySnapshot(opts = {}) {
  try {
    return await Promise.all(PEER_HOSTS.map((peer) => readPeer(peer, opts)));
  } catch {
    return [];
  }
}

module.exports = {
  PEER_HOSTS,
  REMOTE_CMD,
  summarizePeerMemory,
  peerMemorySnapshot,
  readPeer,
};
