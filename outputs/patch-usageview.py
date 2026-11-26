import io

p = 'cli/ui/src/components/UsageView.jsx'
s = io.open(p, encoding='utf-8').read()

start = s.index("      {(() => {\n        const keys = Array.isArray(data.keyLedger && data.keyLedger.keys)")
end_marker = "      })()}\n"
end = s.index(end_marker, start) + len(end_marker)

new = '''      {(() => {
        const keys = Array.isArray(data.keyLedger && data.keyLedger.keys) ? data.keyLedger.keys : [];
        const jk = (data.keyLedger && data.keyLedger.junkalotKey) || null;
        const money = data.ownerMeter;
        const stale = !data.keyLedger; // server has not served the ledger yet
        const liveById = new Map(keys.map((k) => [k && k.id, k]));
        // Locked ids first (always present), then any registry id the server knows
        // about that this config did not already carry. Per user, per key: a client
        // key is not filtered out of the list — it is filed under its own user
        // block below, so one screen reads each user's usage against its own keys
        // without ever summing them together (S29.6). An id that measures nothing
        // still shows, at zero, rather than being hidden (S10).
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
                    // count, never a figure (S10, S13).
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
'''

s = s[:start] + new + s[end:]
s = s.replace(
    "import { ownUsageIds, accountTags, usageIdFor } from '../../../src/usage-ids.js';",
    "import { listUsageIds, groupByUser, accountTags, usageIdFor } from '../../../src/usage-ids.js';",
    1,
)
io.open(p, 'w', encoding='utf-8').write(s)
print('patched UsageView')
