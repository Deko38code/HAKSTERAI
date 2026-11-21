import os, re
os.chdir('/home/ghost/haksterAi')

src = open('server/src/index.js', encoding='utf-8').read()
lines = src.splitlines()

# Find the map variable name and where it is consumed in a route handler.
for i, ln in enumerate(lines):
    if "mail: 'admin/mail/index.html'" in ln:
        print("MAP ENTRY line %d: %s" % (i + 1, ln.strip()))
        map_start = i

# Find route handlers referencing the map / serving admin pages
print("\n=== route handlers mentioning admin page serving ===")
for i, ln in enumerate(lines):
    if re.search(r"app\.get\(\s*\[?\s*['\"]/(admin|dashboard)", ln):
        print("%d: %s" % (i + 1, ln.strip()[:160]))

print("\n=== sendFile / res.send of mapped page ===")
for i, ln in enumerate(lines):
    if ('sendFile' in ln or 'PAGE_MAP' in ln or 'OWNER_PAGES' in ln) and i > 10000:
        print("%d: %s" % (i + 1, ln.strip()[:160]))
