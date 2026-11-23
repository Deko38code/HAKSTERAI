import { useEffect, useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* useMemoryBank — the memory banks the server's autolearn writes, read
 * in-process.
 *
 * "and add the memory bank / wired to haksterai clusters" (owner, 2026-11-23).
 * The server keeps its banks at ~/.hakster/memories/banks/<section-slug>.json
 * (autolearn.js: bankPath / readBank / addMemoryToBank), and pullMemoryBanks
 * turns them into the clustered digest an agent starts a task with. The TUI
 * shows the same files, so what the sidebar says and what the next run recalls
 * cannot tell two different stories.
 *
 * Read-only and shell-free: one readdir and one read per bank, every 10 s. Only
 * counts, slugs, tags and the newest bankedAt leave this module — never an
 * observation's text — so nothing from a bank is echoed into the transcript.
 * If the directory or a bank is missing the fields stay null and the panel
 * shows '—'; nothing is guessed and nothing throws into the render path.
 */
const BANK_DIR = path.join(os.homedir(), '.hakster', 'memories', 'banks');

export function readMemoryBanks(dir = BANK_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const banks = [];
  const tagCounts = new Map();
  let total = 0;
  let newest = null;
  for (const file of files) {
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // a half-written bank is skipped, not counted as empty
    }
    if (!Array.isArray(entries)) continue;
    let last = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
        const key = String(tag).trim().toLowerCase();
        if (!key) continue;
        tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
      }
      const ts = Date.parse(entry.bankedAt || entry.timestamp || '') || 0;
      if (ts > last) last = ts;
    }
    const slug = file.replace(/\.json$/, '');
    banks.push({ slug, entries: entries.length, last });
    total += entries.length;
    if (last && (!newest || last > newest.last)) newest = { slug, last };
  }
  banks.sort((a, b) => b.entries - a.entries || a.slug.localeCompare(b.slug));
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { banks, total, clusters: tagCounts.size, topTags, newest, sampledAt: Date.now() };
}

export default function useMemoryBank(intervalMs = 10000) {
  const [state, setState] = useState(() => readMemoryBanks());
  useEffect(() => {
    const tick = () => setState((prev) => readMemoryBanks() || prev);
    const id = setInterval(tick, intervalMs);
    try {
      if (typeof id.unref === 'function') id.unref();
    } catch {
      /* Bun timers always have unref; never let that break the tick */
    }
    return () => clearInterval(id);
  }, [intervalMs]);
  return state;
}
