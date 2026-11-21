import os, re, shutil, datetime
os.chdir('/home/ghost/haksterAi')

P = 'server/src/index.js'
ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
bak = 'backups/freebuff-cli-%s-index.js' % ts
shutil.copy2(P, bak)
print("BACKUP: " + bak)

s = open(P, encoding='utf-8').read()

old = "try { require('./freebuff-auth').mountAuthRoutes(app); }"
new = "try { require('./freebuff-cli-auth').mountAuthRoutes(app); }"

if "freebuff-cli-auth" in s:
    print("ALREADY MOUNTING CLI AUTH")
elif old in s:
    s = s.replace(old, new)
    open(P, 'w', encoding='utf-8').write(s)
    print("SWAPPED mount -> freebuff-cli-auth")
else:
    # fall back: replace any require of freebuff-auth
    s2, n = re.subn(r"require\('\./freebuff-auth'\)", "require('./freebuff-cli-auth')", s)
    if n:
        open(P, 'w', encoding='utf-8').write(s2)
        print("SWAPPED via regex (%d)" % n)
    else:
        print("MOUNT NOT FOUND — inspect manually")

print("cli-auth refs:", open(P, encoding='utf-8').read().count('freebuff-cli-auth'))
