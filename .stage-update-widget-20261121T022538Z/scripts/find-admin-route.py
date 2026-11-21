import os, re
os.chdir('/home/ghost/haksterAi')

lines = open('server/src/index.js', encoding='utf-8').read().splitlines()

print("=== candidate file sizes ===")
cands = [
    'dist/admin/mail/index.html',
    'dist/admin/email/index.html',
    'public/admin/mail/index.html',
    'public/admin/email/index.html',
]
for c in cands:
    print("  %s  %s" % (os.path.getsize(c) if os.path.isfile(c) else 'absent', c))

print("\n=== routes matching /admin ===")
for i, ln in enumerate(lines):
    if re.search(r"""app\.(get|use)\(\s*['"`]/?admin""", ln) or "ADMIN_PAGES" in ln:
        print("%d: %s" % (i + 1, ln.strip()[:170]))
