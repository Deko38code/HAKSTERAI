#!/usr/bin/env python3
"""HaksterAI: owner-only Junkalot client-value record on /admin/profit.

Owner (2026-11-21): "i rater u add to my admin in haksterai.com admin so client
dosent accidentally see it", "its just for our records and for to know if client
gets more then 249$ usage worth monthly test".
Read-only over SSH; nothing is written into Junkalot.
"""
import datetime, io, sys

SERVER = "/home/ghost/haksterAi/server/src/index.js"
STAMP = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

ANCHOR = "app.get('/api/admin/profit-live', requireOwner, async (_req, res) => {"

BLOCK = r"""
// --- Junkalot client value record - owner only ---------------------------------
// Owner (2026-11-21): "its just for our records and for to know if client gets
// more then 249$ usage worth monthly test", "never show junkalot what we make
// only what they save". The record lives here and not on junkalot.co, so the
// client can never load it. Read-only: it reads the coach usage file over SSH,
// prices the measured tokens at a published-rate benchmark and compares that
// with the plan price. Accounting only (§19): no charge, no plan change.
const JUNKALOT_USAGE_FILE = process.env.JUNKALOT_USAGE_FILE || '/home/ghost694/junkalot/data/mred-usage.jsonl';
const JUNKALOT_VALUE_TERMS_FILE = process.env.JUNKALOT_VALUE_TERMS_FILE || path.join(__dirname, '..', '..', 'data', 'value-terms.json');
const JUNKALOT_VALUE_TERMS_DEFAULT = {
  planUsdMonth: 249,
  benchmarkInPerM: 3.0,
  benchmarkOutPerM: 15.0,
  rateNote: 'Frontier list-price benchmark at $3.00 per million input tokens and $15.00 per million output tokens. A comparison figure, never a bill and never our cost.',
};
function readJunkalotValueTerms() {
  try {
    const raw = JSON.parse(fs.readFileSync(JUNKALOT_VALUE_TERMS_FILE, 'utf8'));
    const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
    return {
      planUsdMonth: num(raw.planUsdMonth, JUNKALOT_VALUE_TERMS_DEFAULT.planUsdMonth),
      benchmarkInPerM: num(raw.benchmarkInPerM, JUNKALOT_VALUE_TERMS_DEFAULT.benchmarkInPerM),
      benchmarkOutPerM: num(raw.benchmarkOutPerM, JUNKALOT_VALUE_TERMS_DEFAULT.benchmarkOutPerM),
      rateNote: typeof raw.rateNote === 'string' && raw.rateNote.trim() ? raw.rateNote : JUNKALOT_VALUE_TERMS_DEFAULT.rateNote,
    };
  } catch {
    return JUNKALOT_VALUE_TERMS_DEFAULT;
  }
}
let _junkalotUsageCache = { at: 0, text: '' };
function readJunkalotUsageText() {
  if (_junkalotUsageCache.text && Date.now() - _junkalotUsageCache.at < 300000) return Promise.resolve(_junkalotUsageCache.text);
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', process.env.PEER_SSH_ALIAS || 'parrot', 'cat ' + JUNKALOT_USAGE_FILE], { timeout: 12000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      _junkalotUsageCache = { at: Date.now(), text: String(stdout || '') };
      return resolve(_junkalotUsageCache.text);
    });
  });
}
function computeJunkalotValue(text, terms, now) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!row || typeof row.at !== 'string' || Number.isNaN(new Date(row.at).getTime())) continue;
      rows.push(row);
    } catch { /* a torn line is skipped, never repaired */ }
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const monthKey = now.toISOString().slice(0, 7);
  const prevKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const bucket = (key) => ({ month: key, turns: 0, inTokens: 0, outTokens: 0, days: new Set(), lanes: new Map() });
  const month = bucket(monthKey);
  const previous = bucket(prevKey);
  const dayMap = new Map();
  const all = { turns: 0, inTokens: 0, outTokens: 0, firstAt: null, lastAt: null };
  for (const row of rows) {
    const at = String(row.at);
    const day = at.slice(0, 10);
    const inTokens = Number(row.inTokens) || 0;
    const outTokens = Number(row.outTokens) || 0;
    all.turns += 1;
    all.inTokens += inTokens;
    all.outTokens += outTokens;
    if (!all.firstAt || at < all.firstAt) all.firstAt = at;
    if (!all.lastAt || at > all.lastAt) all.lastAt = at;
    const rowMonth = day.slice(0, 7);
    const target = rowMonth === monthKey ? month : rowMonth === prevKey ? previous : null;
    if (!target) continue;
    target.turns += 1;
    target.inTokens += inTokens;
    target.outTokens += outTokens;
    target.days.add(day);
    const laneKey = String(row.provider || 'unknown');
    const lane = target.lanes.get(laneKey) || { provider: laneKey, turns: 0, tokens: 0 };
    lane.turns += 1;
    lane.tokens += inTokens + outTokens;
    target.lanes.set(laneKey, lane);
    if (rowMonth === monthKey) {
      const entry = dayMap.get(day) || { day, turns: 0, inTokens: 0, outTokens: 0 };
      entry.turns += 1;
      entry.inTokens += inTokens;
      entry.outTokens += outTokens;
      dayMap.set(day, entry);
    }
  }
  const value = (inTokens, outTokens) => Math.round(((inTokens / 1e6) * terms.benchmarkInPerM + (outTokens / 1e6) * terms.benchmarkOutPerM) * 100) / 100;
  const finish = (b) => ({
    month: b.month,
    turns: b.turns,
    inTokens: b.inTokens,
    outTokens: b.outTokens,
    valueUsd: value(b.inTokens, b.outTokens),
    activeDays: b.days.size,
    lanes: [...b.lanes.values()].sort((x, y) => y.tokens - x.tokens),
  });
  const monthOut = finish(month);
  const previousOut = finish(previous);
  const elapsedDays = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const plan = terms.planUsdMonth;
  const utilisationPct = plan > 0 ? Math.round((monthOut.valueUsd / plan) * 10000) / 100 : 0;
  const projectedValueUsd = elapsedDays > 0 ? Math.round((monthOut.valueUsd / elapsedDays) * daysInMonth * 100) / 100 : 0;
  const patterns = [];
  patterns.push({ label: 'Active days', value: monthOut.activeDays + ' of ' + elapsedDays, note: monthOut.activeDays ? 'Coach used on ' + monthOut.activeDays + ' day(s) this month.' : 'No coach turns recorded this month yet.' });
  if (monthOut.activeDays > 0) patterns.push({ label: 'Turns per active day', value: (monthOut.turns / monthOut.activeDays).toFixed(2), note: monthOut.turns + ' turn(s) across ' + monthOut.activeDays + ' day(s).' });
  if (monthOut.lanes.length) {
    const top = monthOut.lanes[0];
    const share = monthOut.turns ? Math.round((top.turns / monthOut.turns) * 100) : 0;
    patterns.push({ label: 'Dominant lane', value: top.provider + ' · ' + share + '%', note: top.turns + ' of ' + monthOut.turns + ' turn(s) via ' + top.provider + '; ' + top.tokens.toLocaleString('en-US') + ' tokens.' });
  }
  if (previousOut.turns > 0) {
    const delta = Math.round((monthOut.valueUsd - previousOut.valueUsd) * 100) / 100;
    const pct = previousOut.valueUsd > 0 ? Math.round((delta / previousOut.valueUsd) * 100) : null;
    patterns.push({ label: 'Month over month', value: pct === null ? (delta >= 0 ? '+' : '') + '$' + delta : (pct >= 0 ? '+' : '') + pct + '%', note: 'Last month $' + previousOut.valueUsd + ' benchmark value over ' + previousOut.turns + ' turn(s).' });
  } else {
    patterns.push({ label: 'Month over month', value: 'no prior month', note: 'No coach usage recorded last month, so there is nothing to compare yet.' });
  }
  return {
    monthKey,
    month: monthOut,
    previousMonth: previousOut.turns ? previousOut : null,
    monthToDate: [...dayMap.values()].map((d) => ({ ...d, valueUsd: value(d.inTokens, d.outTokens) })).sort((a, b) => a.day.localeCompare(b.day)),
    plan: {
      priceUsd: plan,
      utilisationPct,
      surplusUsd: Math.round(Math.max(0, monthOut.valueUsd - plan) * 100) / 100,
      shortfallUsd: Math.round(Math.max(0, plan - monthOut.valueUsd) * 100) / 100,
      verdict: monthOut.valueUsd >= plan ? 'over plan - client is receiving more value than the plan price' : monthOut.valueUsd >= plan * 0.75 ? 'near plan - within 25% of the plan price' : monthOut.valueUsd >= plan * 0.25 ? 'within plan' : 'well under plan - usage is a small share of what the plan includes',
    },
    projection: { elapsedDays, daysInMonth, projectedValueUsd, projectedTurns: elapsedDays > 0 ? Math.round((monthOut.turns / elapsedDays) * daysInMonth) : 0 },
    patterns,
    allTime: { turns: all.turns, tokens: all.inTokens + all.outTokens, valueUsd: value(all.inTokens, all.outTokens), firstAt: all.firstAt, lastAt: all.lastAt },
    terms,
    rows: rows.length,
    source: 'junkalot data/mred-usage.jsonl (read only, over ssh)',
  };
}

"""

INCLUDE_OLD = "      phantom,\n      junkalot,\n      bridge: bridgeState,"
INCLUDE_NEW = "      phantom,\n      junkalot,\n      junkalotValue,\n      bridge: bridgeState,"

FETCH_OLD = "    } catch { bridgeState = 'unavailable'; }\n"
FETCH_NEW = ("    } catch { bridgeState = 'unavailable'; }\n"
             "\n"
             "    // Junkalot's client value record: read over SSH, computed here, never written back.\n"
             "    let junkalotValue = null;\n"
             "    try {\n"
             "      const terms = readJunkalotValueTerms();\n"
             "      const usageText = await readJunkalotUsageText();\n"
             "      junkalotValue = computeJunkalotValue(usageText, terms, new Date());\n"
             "    } catch { junkalotValue = null; }\n")


def patch(path, pairs):
    text = io.open(path, encoding="utf-8").read()
    for old, new, label in pairs:
        n = text.count(old)
        if n != 1:
            print("ABORT: %s anchor found %d times" % (label, n))
            sys.exit(1)
        text = text.replace(old, new)
    backup = path + ".bak-valuecard-" + STAMP
    io.open(backup, "w", encoding="utf-8").write(io.open(path, encoding="utf-8").read())
    io.open(path, "w", encoding="utf-8").write(text)
    print("PATCHED", path)
    print("BACKUP ", backup)
    print("CHECK", {n: io.open(path, encoding="utf-8").read().count(n) for n in ("computeJunkalotValue", "junkalotValue", "JUNKALOT_USAGE_FILE")})


patch(SERVER, [
    (ANCHOR, BLOCK + ANCHOR, "profit-live route anchor"),
    (FETCH_OLD, FETCH_NEW, "value read after bridge"),
    (INCLUDE_OLD, INCLUDE_NEW, "payload include"),
])
