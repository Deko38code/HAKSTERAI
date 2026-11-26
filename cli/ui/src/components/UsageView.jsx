import React from 'react';
import { TextAttributes } from '@opentui/core';
import { BrandLine } from './HeroLogo.jsx';
import { clip } from './LiveSidebar.jsx';

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
          never an invoice (§19, §24). An unmeasured key reads zero and says so. */}
      {data.keyLedger ? (() => {
        const keys = Array.isArray(data.keyLedger.keys) ? data.keyLedger.keys : [];
        const own = keys
          .filter((k) => k && k.client !== 'junkalot.co')
          // The key that actually carried the latest usage reads first; a key with
          // no recorded call still shows, at zero, rather than being hidden (§10).
          .sort((a, b) => (Number((b.month || {}).requests) || 0) - (Number((a.month || {}).requests) || 0));
        const jk = data.keyLedger.junkalotKey;
        const money = data.ownerMeter;
        return (
          <>
            {line('Billing · HAKSTERAI-FLASH · one id per model key', 'green')}
            {own.length ? own.slice(0, 3).map((k) => (
              <box key={k.id} style={{ width: inner, flexDirection: 'column', flexShrink: 0 }}>
                {line(`  ${k.id}${k.label ? ` · ${k.label}` : ''}  30d ${fmtNum(k.month && k.month.requests)} req · in ${fmtNum(k.month && k.month.inTokens)} · out ${fmtNum(k.month && k.month.outTokens)}`)}
                {line(`     all-time ${fmtNum(k.all && k.all.requests)} req · ${fmtNum((k.all && k.all.inTokens) || 0)} in / ${fmtNum((k.all && k.all.outTokens) || 0)} out${k.lanes && k.lanes.length ? ` · lanes ${k.lanes.map((l) => l.lane).slice(0, 2).join(', ')}` : ''}`, 'gray')}
              </box>
            )) : line('  no key has recorded a call yet', 'gray')}
            {line(`  key-junkalot-1 · Junkalot Coach · ${jk ? `${fmtNum(jk.month.requests)} turns 30d` : 'reading her rows…'} · wired to our admin profit meter`, 'white')}
            {money ? line(`  metered $${Number(money.monthMeterUsd || 0).toFixed(2)} 30d · $${Number(money.meterUsd || 0).toFixed(2)} all-time at $${Number(money.rateInPerMTok || 0).toFixed(2)} in / $${Number(money.rateOutPerMTok || 0).toFixed(2)} out per Mtok · meter, not an invoice`, 'gray') : null}
            <Row w={inner}><text> </text></Row>
          </>
        );
      })() : line('Billing · our key ledger is read by the server after its next restart — nothing is shown rather than her card in its place', 'gray')}

      {/* The last measured calls, so a figure can be traced to its row. */}
      {Array.isArray(data.tokenWiring && data.tokenWiring.recent) && data.tokenWiring.recent.length ? (
        <>
          {line('Recent calls', 'green')}
          {data.tokenWiring.recent.slice(0, Math.max(0, Math.min(5, height - 16))).map((r, i) => (
            <Row key={`recent:${i}`} w={inner}>
              <text fg="gray">{clip(`${new Date(Number(r.created_at) * 1000).toISOString().slice(5, 16).replace('T', ' ')}  ${String(r.endpoint || '').padEnd(16)} ${String(r.model || r.provider || '').slice(0, 18).padEnd(18)} in ${fmtNum(r.input_tokens)} out ${fmtNum(r.output_tokens)}`, inner)}</text>
            </Row>
          ))}
        </>
      ) : null}
      {line('r refresh · ] faster · [ slower · PgUp/PgDn scroll · esc back', 'gray')}
    </box>
  );
}

export { sparkline, until, fmtNum };
