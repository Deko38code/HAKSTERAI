import React from 'react';
import { TextAttributes } from '@opentui/core';
import { BrandLine } from './HeroLogo.jsx';
import { clip } from './LiveSidebar.jsx';
// The usage ids are locked in our CLI config (§22.4 shape): one id per model key,
// bundled here so /usage shows them even when the server has not restarted onto
// the code that serves the key ledger (§45).
import { listUsageIds, groupByUser, accountTags, usageIdFor } from '../../../src/usage-ids.js';

/* UsageView — this account's usage, the way Claude's /usage page reads.
 *
 * Owner 2026-11-23: "we need the cli to have usage page per user like claude
 * uses just exact", "for daily weekly usage", "live graphs refresh rate etc
 * scrape usage page".
 *
 * Everything here comes from GET /api/usage for the signed-in account: the
 * plan window (used / limit / resets in), today, this week, this month, the
 * 14-day series, web research and the last measured calls. A percentage is
 * only drawn where the server gave a limit — otherwise the bar is the window's
 * own share of the plan window's calls, labelled as calls, never as "N% of
 * something" we cannot measure (§10).
 */

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function until(tsSec) {
  const ms = Number(tsSec) * 1000 - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function since(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A bar of exactly `w` cells; `pct` may be null (unmeasured → all dim). */
function Bar({ w, pct, color = 'green' }) {
  const width = Math.max(4, w);
  if (pct == null) {
    return <text fg="gray">{'░'.repeat(width)}</text>;
  }
  const filled = Math.max(0, Math.min(width, Math.round((width * pct) / 100)));
  return (
    <box style={{ width, flexDirection: 'row', flexShrink: 0 }}>
      <text fg={color}>{'█'.repeat(filled)}</text>
      <text fg="gray">{'░'.repeat(width - filled)}</text>
    </box>
  );
}

function sparkline(series, width) {
  const byDay = new Map();
  for (const row of Array.isArray(series) ? series : []) {
    if (row && row.day) byDay.set(String(row.day), Number(row.calls) || 0);
  }
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, calls: byDay.get(key) || 0 });
  }
  const shown = days.slice(Math.max(0, days.length - Math.max(4, width)));
  const max = shown.reduce((m, d) => Math.max(m, d.calls), 0);
  const text = shown.map((d) => (max === 0 ? BLOCKS[0] : BLOCKS[Math.min(BLOCKS.length - 1, Math.round((d.calls / max) * (BLOCKS.length - 1)))])).join('');
  return { text, max, shown };
}

const Row = ({ children, w }) => (
  <box style={{ width: w, flexShrink: 0 }}>{children}</box>
);

export default function UsageView({ width = 80, height = 24, usage = null, refreshSeconds = 15, account = '' }) {
  const w = Math.max(30, Number(width) || 80);
  const inner = w - 2;
  const data = usage && usage.data ? usage.data : null;
  const err = usage && usage.error ? usage.error : '';
  const updated = usage && usage.updatedAt ? since(usage.updatedAt) : '—';
  const rate = refreshSeconds > 0 ? `every ${refreshSeconds}s` : 'paused';

  const line = (text, fg = 'white', bold = false) => (
    <Row w={inner}>
      <text fg={fg} attributes={bold ? TextAttributes.BOLD : 0}>{clip(text, inner)}</text>
    </Row>
  );

  if (!data) {
    return (
      <box style={{ width: w, border: true, borderStyle: 'rounded', borderColor: 'green', flexDirection: 'column', flexShrink: 0 }}>
        <BrandLine width={inner} subtitle="usage" />
        {line('◔ Usage', 'green', true)}
        <Row w={inner}><text> </text></Row>
        {line(err || (usage && usage.loading ? 'loading usage…' : 'no usage data yet'), err ? 'yellow' : 'gray')}
        {line(err ? 'fix: hakster login · then r to retry · esc to go back' : 'r refresh · esc back', 'gray')}
      </box>
    );
  }

  const plan = String(data.plan || 'free');
  const limit = Number(data.limit);
  const used = Number(data.used) || 0;
  const capped = Number.isFinite(limit) && limit > 0;
  const pct = capped ? Math.min(100, Math.round((used / limit) * 100)) : null;
  const resets = data.resets || {};
  const windows = data.windows || {};
  const day = windows.day || {};
  const week = windows.week || {};
  const month = windows.month || {};
  const spark = sparkline(data.dailySeries, Math.max(10, inner - 2));
  const webLimit = Number(data.webResearchLimit);
  const webUsed = Number(data.webResearchUsed) || 0;
  const webPct = Number.isFinite(webLimit) && webLimit > 0 ? Math.min(100, Math.round((webUsed / webLimit) * 100)) : null;

  const windowRows = [
    { label: 'Today', w: day, until: resets.dailyAt },
    { label: 'This week', w: week, until: resets.weeklyAt },
    { label: 'This month', w: month, until: resets.monthlyAt },
  ];
  // Each window's bar is its share of the plan window's calls — a measured
  // comparison between real counts, labelled in calls (never a fake limit).
  const biggest = Math.max(used, 1);

  return (
    <box style={{ width: w, border: true, borderStyle: 'rounded', borderColor: 'green', flexDirection: 'column', flexShrink: 0 }}>
      <BrandLine width={inner} subtitle="usage" />
      {line(`◔ Usage · ${account || 'this account'} · plan ${plan}`, 'green', true)}
      {line(capped
        ? `Plan allowance ${fmtNum(used)} / ${fmtNum(limit)} calls · ${pct}% · resets in ${until(resets.planResetAt)}`
        : `Plan allowance ${fmtNum(used)} calls · no call cap on this plan${resets.planWindow ? ` · window ${resets.planWindow}` : ''}`,
        capped ? 'white' : 'gray')}
      <Row w={inner}><Bar w={Math.max(10, Math.min(inner, 48))} pct={pct} color={pct != null && pct >= 90 ? 'red' : pct != null && pct >= 70 ? 'yellow' : 'green'} /></Row>
      <Row w={inner}><text> </text></Row>

      {windowRows.map(({ label, w: win, until: resetAt }) => {
        const calls = Number(win.calls) || 0;
        const share = biggest > 0 ? Math.min(100, Math.round((calls / biggest) * 100)) : 0;
        const tokens = `in ${fmtNum(win.inputTokens)} · out ${fmtNum(win.outputTokens)}`;
        return (
          <box key={label} style={{ width: inner, flexDirection: 'column', flexShrink: 0 }}>
            {line(`${label.padEnd(10)} ${fmtNum(calls).padStart(6)} calls · ${tokens} · ${win.agentCalls || 0} agent / ${win.chatCalls || 0} chat`, 'white')}
            <box style={{ width: inner, flexDirection: 'row', flexShrink: 0 }}>
              <text fg="gray">{' '.repeat(11)}</text>
              <Bar w={Math.max(8, Math.min(40, inner - 26))} pct={share} color="cyan" />
              <text fg="gray">{` resets in ${until(resetAt)}`}</text>
            </box>
          </box>
        );
      })}
      <Row w={inner}><text> </text></Row>

      {/* 14-day calls, each glyph one measured day */}
      {line(`14-day calls  ${spark.text}  peak ${fmtNum(spark.max)}/day`, 'white')}
      {line(`   ${spark.shown.length ? `${spark.shown[0].key.slice(5)} → ${spark.shown[spark.shown.length - 1].key.slice(5)}` : ''}`, 'gray')}

      <Row w={inner}><text> </text></Row>
      {line(webPct != null
        ? `Web research ${webUsed} / ${webLimit} · ${webPct}%`
        : `Web research ${data.webResearchLimit === -1 ? 'unlimited on this plan' : `${webUsed} used`}`, 'white')}
      {line(`Tokens all time  in ${fmtNum(data.tokenUsage && data.tokenUsage.inputTokens)} · out ${fmtNum(data.tokenUsage && data.tokenUsage.outputTokens)} · tool calls ${fmtNum(data.tokenUsage && data.tokenUsage.toolCalls)} · last ${since(data.tokenUsage && data.tokenUsage.lastUsedAt)}`, 'gray')}
      {line(`Token balance ${fmtNum(data.tokenBalance)} · live: ${rate} · updated ${updated}`, 'gray')}
      <Row w={inner}><text> </text></Row>

      {/* Billing · ours (owner 2026-11-26: "swap data for our in my cli").
          One id per model key: our own key's requests and tokens are counted on
          this box from recorded calls, and Junkalot's key is read back from her
          own recorded turns and wired to the admin profit meter — never rendered
          on junkalot.co (§16, §25, §30, §36). The dollar figure, when the server
          supplies one, is our account metered at the locked rate card: a meter,
          never an invoice (§19, §24). An unmeasured key reads zero and says so.

          The ids are LOCKED in our CLI config (`cli/src/usage-ids.js`), so this
          list is the floor: it renders even when the server has not restarted
          onto the code that serves `keyLedger` (§45), and an id added later from
          admin is merged on top rather than being dropped (§26.5). A locked id
          with no measured call says exactly that — it never borrows a figure. */}
      {(() => {
        const keys = Array.isArray(data.keyLedger && data.keyLedger.keys) ? data.keyLedger.keys : [];
        const jk = (data.keyLedger && data.keyLedger.junkalotKey) || null;
        const money = data.ownerMeter;
        const stale = !data.keyLedger; // server has not served the ledger yet
        const liveById = new Map(keys.map((k) => [k && k.id, k]));
        // Locked ids first (always present), then any registry id the server knows
        // about that this config did not already carry. Per user, per key: a client
        // key is not filtered out of the list — it is filed under its own user
        // block below, so one screen reads each user's usage against its own keys
        // without ever summing them together (§29.6). An id that measures nothing
        // still shows, at zero, rather than being hidden (§10).
        const ids = listUsageIds();
        for (const k of keys) {
          if (k && !ids.some((i) => i.id === k.id)) {
            ids.push({
              id: k.id,
              label: k.label || '',
              user: k.user || (k.client === 'junkalot.co' ? 'junkalot' : 'owner'),
              userLabel: k.userLabel || '',
              client: k.client || '',
              account: k.account || '',
              envVar: k.envVar || '',
              lanes: Array.isArray(k.lanes) ? k.lanes.map(String) : [],
            });
          }
        }
        // Same account, different name: when two ids share an account (ours and
        // Junkalot's both live on OLLAMA_CLOUD_KEY_2), the account is printed on
        // every row that shares it, so the label is what tells usage apart.
        const tags = accountTags(ids.map((k) => ({ id: k.id, account: k.account || (liveById.get(k.id) || {}).account || '' })));
        const groups = groupByUser(ids);
        return (
          <>
            {line('Billing · HAKSTERAI-FLASH · per user, per key · ids locked in CLI config', 'green')}
            {groups.length ? groups.map((g) => (
              <box key={`u:${g.user}`} style={{ width: inner, flexDirection: 'column', flexShrink: 0 }}>
                {line(`  ${String(g.label).toUpperCase()} · ${g.keys.length} key${g.keys.length === 1 ? '' : 's'}`, 'green')}
                {g.keys.map((k) => {
                  const l = liveById.get(k.id) || null;
                  const tag = tags.get(k.id) ? ` · ${tags.get(k.id)}` : '';
                  const name = `${k.id}${k.label ? ` · ${k.label}` : ''}${tag}`;
                  const isClient = k.client === 'junkalot.co';
                  if (isClient) {
                    // her key: folded from her own recorded turns, wired to the meter,
                    // and filed under her user block — never merged into our totals.
                    const fig = jk ? `${fmtNum(jk.month && jk.month.requests)} turns 30d · in ${fmtNum(jk.month && jk.month.inTokens)} · out ${fmtNum(jk.month && jk.month.outTokens)}` : stale ? 'her rows read after the server restart' : 'reading her rows…';
                    return (
                      <box key={k.id} style={{ width: inner, flexDirection: 'column', flexShrink: 0 }}>
                        {line(`    ${name}   ${fig}`, stale && !jk ? 'gray' : 'white')}
                        {line('       wired to our admin profit meter · never rendered on junkalot.co', 'gray')}
                      </box>
                    );
                  }
                  if (!l) {
                    // No measured call for this id: state the lock and the lane it will
                    // count, never a figure (§10, §13).
                    const lane = k.lanes && k.lanes.length ? `lane ${k.lanes.join('/')}` : 'no lane bound yet';
                    return (
                      <Row key={k.id} w={inner}>
                        <text fg="gray">{clip(`    ${name}  ${stale ? 'locked · ledger reads after the server restart' : 'locked · no call recorded yet'} · ${lane}${k.envVar ? ` · ${k.envVar}` : ''}`, inner)}</text>
                      </Row>
                    );
                  }
                  return (
                    <box key={k.id} style={{ width: inner, flexDirection: 'column', flexShrink: 0 }}>
                      {line(`    ${name}  30d ${fmtNum(l.month && l.month.requests)} req · in ${fmtNum(l.month && l.month.inTokens)} · out ${fmtNum(l.month && l.month.outTokens)}`)}
                      {line(`       all-time ${fmtNum(l.all && l.all.requests)} req · ${fmtNum((l.all && l.all.inTokens) || 0)} in / ${fmtNum((l.all && l.all.outTokens) || 0)} out${l.usedLanes && l.usedLanes.length ? ` · lanes ${l.usedLanes.map((x) => x.lane).slice(0, 2).join(', ')}` : ''}`, 'gray')}
                    </box>
                  );
                })}
              </box>
            )) : line('  no usage ids in the CLI config', 'gray')}
            {money ? line(`  metered $${Number(money.monthMeterUsd || 0).toFixed(2)} 30d · $${Number(money.meterUsd || 0).toFixed(2)} all-time at $${Number(money.rateInPerMTok || 0).toFixed(2)} in / $${Number(money.rateOutPerMTok || 0).toFixed(2)} out per Mtok · meter, not an invoice`, 'gray') : null}
            <Row w={inner}><text> </text></Row>
          </>
        );
      })()}

      {/* The last measured calls, so a figure can be traced to its row. */}
      {Array.isArray(data.tokenWiring && data.tokenWiring.recent) && data.tokenWiring.recent.length ? (
        <>
          {line('Recent calls', 'green')}
          {data.tokenWiring.recent.slice(0, Math.max(0, Math.min(5, height - 16))).map((r, i) => {
            // Attribute each measured call to the usage id its lane counts against,
            // so a figure can be traced to the key that ran it (§51.6). A lane with
            // no id is stated as unattributed, never guessed onto a neighbour.
            const id = usageIdFor(r.provider || r.lane) || 'unattributed';
            return (
              <Row key={`recent:${i}`} w={inner}>
                <text fg="gray">{clip(`${new Date(Number(r.created_at) * 1000).toISOString().slice(5, 16).replace('T', ' ')}  ${String(id).padEnd(20)} ${String(r.model || r.provider || '').slice(0, 16).padEnd(16)} in ${fmtNum(r.input_tokens)} out ${fmtNum(r.output_tokens)}`, inner)}</text>
              </Row>
            );
          })}
        </>
      ) : null}
      {line('r refresh · ] faster · [ slower · PgUp/PgDn scroll · esc back', 'gray')}
    </box>
  );
}

export { sparkline, until, fmtNum };
