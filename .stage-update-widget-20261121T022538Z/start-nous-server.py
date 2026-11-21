#!/usr/bin/env python3
"""Start HaksterAI server with Nous Portal API key injected."""
import json, os, subprocess, sys

# Read Nous auth
with open('/home/ghost/.hermes/shared/nous_auth.json') as f:
    auth = json.load(f)
tok = auth['access_token']

# Set env
env = os.environ.copy()
env['NOUS_API_KEY'] = tok
env['NOUS_BASE_URL'] = 'https://inference-api.nousresearch.com/v1'
env['NOUS_MODEL'] = 'deepseek/deepseek-v4-flash'
env['OPENAI_API_KEY'] = tok  # SDK fallback

print(f'Starting server with NOUS_API_KEY ({len(tok)} chars)...', flush=True)
p = subprocess.Popen(
    ['node', 'server/src/index.js'],
    cwd='/home/ghost/haksterAi',
    env=env,
    stdout=sys.stdout,
    stderr=sys.stderr,
)
with open('/tmp/nous_server.pid', 'w') as f:
    f.write(str(p.pid))
print(f'Server PID: {p.pid}', flush=True)
