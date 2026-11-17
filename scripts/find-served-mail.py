import os, re, subprocess

os.chdir('/home/ghost/haksterAi')

# 1) Show the route handler that serves admin/mail
src = open('server/src/index.js', encoding='utf-8').read().splitlines()
for i in range(10255, 10300):
    if i < len(src):
        print("%d: %s" % (i + 1, src[i]))
