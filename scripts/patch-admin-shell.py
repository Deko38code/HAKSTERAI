import os, re, shutil, datetime
os.chdir('/home/ghost/haksterAi')

P = 'server/src/index.js'
ts = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
bak = 'backups/email-monitor-freebuff-%s-index.js' % ts
shutil.copy2(P, bak)
print("BACKUP: " + bak)

s = open(P, encoding='utf-8').read()

GUARD = ("<script>(function(){"
         "if(window.__fbGate)return;window.__fbGate=1;"
         "try{fetch('/api/auth/freebuff/me',{credentials:'same-origin'})"
         ".then(function(r){if(r.status===401){location.replace('/auth/freebuff');}})"
         ".catch(function(){});}catch(e){}})();</script>")

if '__fbGate' in s:
    print("ALREADY PATCHED")
else:
    # The admin shell template starts with this exact literal.
    anchor = 'res.send(`<!doctype html><html lang="en"><head>'
    i = s.find(anchor)
    if i == -1:
        print("ANCHOR NOT FOUND")
    else:
        j = i + len(anchor)
        s = s[:j] + GUARD + s[j:]
        open(P, 'w', encoding='utf-8').write(s)
        print("PATCHED admin shell at char %d" % j)

print("gate count in index.js:", open(P, encoding='utf-8').read().count('__fbGate'))
