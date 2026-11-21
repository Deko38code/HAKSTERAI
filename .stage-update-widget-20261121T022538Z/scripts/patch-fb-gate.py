import os, re, glob

GUARD = """<script is:inline>(function(){
/* Freebuff auth gate for Email Monitor (additive; owner sessions pass through) */
if (window.__fbGate) return; window.__fbGate = 1;
try {
  fetch('/api/auth/freebuff/me', { credentials: 'same-origin' })
    .then(function (r) { if (r.status === 401) { location.replace('/auth/freebuff'); } })
    .catch(function () { /* offline: let the page load normally */ });
} catch (e) {}
})();</script>
"""

os.chdir('/home/ghost/haksterAi')

for p in ['src/pages/admin/mail.astro', 'src/pages/admin/email.astro']:
    if not os.path.isfile(p):
        print("absent   " + p)
        continue
    s = open(p, encoding='utf-8').read()
    if '__fbGate' in s:
        print("already  " + p)
        continue

    # Find the first opening <Layout ...> tag (may span lines) and inject after it.
    m = re.search(r'<Layout\b[^>]*>', s, re.S)
    if m:
        j = m.end()
        s2 = s[:j] + "\n" + GUARD + s[j:]
        open(p, 'w', encoding='utf-8').write(s2)
        print("injected after <Layout>  " + p)
        continue

    # Fallback: inject right after the closing frontmatter fence.
    m2 = re.search(r'^---\s*$.*?^---\s*$', s, re.S | re.M)
    if m2:
        j = m2.end()
        s2 = s[:j] + "\n" + GUARD + s[j:]
        open(p, 'w', encoding='utf-8').write(s2)
        print("injected after frontmatter  " + p)
        continue

    print("NO ANCHOR  " + p)

print("=== PRESENCE ===")
for p in ['src/pages/admin/mail.astro', 'src/pages/admin/email.astro']:
    if os.path.isfile(p):
        n = open(p, encoding='utf-8', errors='replace').read().count('__fbGate')
        print("  %d  %s" % (n, p))
