import io

p = 'src/pages/admin/profit.astro'
s = io.open(p, encoding='utf-8').read()

old_start = "          if (kl && Array.isArray(kl.keys)) {\n            var klMid = ' · ';"
old_end_marker = "            klEl.innerHTML = out;\n          } else {"
i = s.index(old_start)
j = s.index(old_end_marker, i) + len("            klEl.innerHTML = out;\n")
old = s[i:j]

new = '''          if (kl && Array.isArray(kl.keys)) {
            var klMid = ' · ';
            // Per user, per key (owner 2026-11-26: "per user per key"). Each key is
            // filed under the user it belongs to — ours under Owner, a client's under
            // its own block — and no total is summed across users, even when two keys
            // sit on one account (§29.6). Junkalot's block is the key wired back to
            // this meter, folded from her own recorded turns, read only (§16, §19).
            var groupOrder = ['owner', 'junkalot'];
            var groups = {};
            kl.keys.forEach(function (k) {
              if (!k) return;
              var u = k.user || (k.client === 'junkalot.co' ? 'junkalot' : 'owner');
              if (!groups[u]) groups[u] = { user: u, label: k.userLabel || (u === 'junkalot' ? 'Junkalot · client' : 'Owner'), keys: [] };
              groups[u].keys.push(k);
            });
            var ordered = Object.keys(groups).sort(function (a, b) {
              var ai = groupOrder.indexOf(a), bi = groupOrder.indexOf(b);
              return (ai === -1 ? groupOrder.length : ai) - (bi === -1 ? groupOrder.length : bi);
            });
            // Same account, different name: our key and Junkalot's both sit on
            // OLLAMA_CLOUD_KEY_2, so the account is printed on every row that shares
            // it and the label is what tells their usage apart (owner, 2026-11-26).
            var acctCount = {};
            kl.keys.forEach(function (k) { if (k && k.account) acctCount[k.account] = (acctCount[k.account] || 0) + 1; });
            var acctTag = function (k) { return k && k.account && acctCount[k.account] > 1 ? klMid + k.account : ''; };
            var jkRows = kl.junkalotKey;
            var out = '<h3>Keys by user ' +
              '<span class="pl-badge ' + (Number(kl.rows) > 0 ? 'live' : 'off') + '">' +
              (Number(kl.rows) > 0 ? compact(kl.rows) + ' RECORDED CALLS' : 'NO ROWS YET') + '</span></h3>';
            ordered.forEach(function (u) {
              var g = groups[u];
              out += '<h3 style="margin-top:14px;">' + esc(g.label) + klMid + g.keys.length + ' key' + (g.keys.length === 1 ? '' : 's') + '</h3>';
              out += g.keys.map(function (k) {
                var m = k.month || {}, a = k.all || {};
                if (u === 'junkalot') {
                  return row(k.id + ' · ' + (k.label || '') + acctTag(k), jkRows
                    ? compact(jkRows.month.requests) + ' turns 30d' + klMid + compact(jkRows.month.inTokens) + ' in / ' + compact(jkRows.month.outTokens) + ' out' +
                      (jkRows.all && jkRows.all.lastAt ? klMid + 'last ' + String(jkRows.all.lastAt).slice(0, 16).replace('T', ' ') : '')
                    : 'her recorded rows have not been read yet — no figure is shown rather than a guess');
                }
                return row(k.id + ' · ' + (k.label || '') + acctTag(k),
                  (Number(m.requests) > 0 || Number(a.requests) > 0)
                    ? '30d ' + compact(m.requests) + ' req' + klMid + compact(m.inTokens) + ' in / ' + compact(m.outTokens) + ' out' +
                      klMid + 'all-time ' + compact(a.requests) + ' req' + (k.envVar ? klMid + k.envVar : '')
                    : 'no recorded call yet' + (k.envVar ? klMid + k.envVar : ''));
              }).join('');
            });
            out += '<p class="pl-empty" style="margin-top:10px;">One id per key, one block per user: our keys are counted from the calls this box recorded, and Junkalot&rsquo;s key is read back from her own recorded turns, read only. No figure is summed across users. Nothing is written into that project and nothing is billed. Her Junkalot admin never renders this card (CLAUDE.md §16, §19, §25, §29, §30, §36).</p>';
            klEl.innerHTML = out;
'''
s = s[:i] + new + s[j:]
io.open(p, 'w', encoding='utf-8').write(s)
print('patched admin key ledger')
