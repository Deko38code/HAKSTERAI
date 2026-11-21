import os, glob

GUARD = """<script>(function(){
/* Freebuff auth gate for Email Monitor (additive; owner sessions pass through) */
if (window.__fbGate) return; window.__fbGate = 1;
try {
  fetch('/api/auth/freebuff/me', { credentials: 'same-origin' })
    .then(function (r) { if (r.status === 401) { location.replace('/auth/freebuff'); } })
    .catch(function () { /* offline: let the page load normally */ });
} catch (e) {}
})();</script>"""

ROOT = '/home/ghost/haksterAi'
os.chdir(ROOT)

TARGET_SIZE = 4051
hits = []

for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in ('node_modules', '.git', 'backups')]
    for fn in filenames:
        if not fn.endswith('.html'):
            continue
        p = os.path.join(dirpath, fn)
        try:
            if os.path.getsize(p) != TARGET_SIZE:
                continue
        except OSError:
            continue
        hits.append(p)

print("=== files of exactly %d bytes ===" % TARGET_SIZE)
for p in hits:
    print("  " + os.path.relpath(p, ROOT))

patched = 0
for p in hits:
    s = open(p, encoding='utf-8', errors='replace').read()
    if '__fbGate' in s:
        print("already  " + os.path.relpath(p, ROOT))
        continue
    low = s.lower()
    i = low.index('<head>') if '<head>' in low else -1
    if i == -1:
        print("no head  " + os.path.relpath(p, ROOT))
        continue
    j = i + len('<head>')
    open(p, 'w', encoding='utf-8').write(s[:j] + GUARD + s[j:])
    patched += 1
    print("PATCHED  " + os.path.relpath(p, ROOT))

print("patched count: %d" % patched)
