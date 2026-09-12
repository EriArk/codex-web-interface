#!/usr/bin/env python3
"""Publish only verified public assets. The engine and gateway keep running."""
import argparse
import os
from pathlib import Path
import re
import subprocess

p = argparse.ArgumentParser()
p.add_argument('revision')
p.add_argument('--state', default=os.environ.get('CODEX_WEB_STATE'))
p.add_argument('--check-url', default='http://127.0.0.1:8780')
a = p.parse_args()
if not a.state or not re.fullmatch(r'[a-f0-9]{7,64}', a.revision):
    p.error('A state directory and verified image revision are required')
state = Path(a.state).resolve(strict=True)
root = state / 'web-releases'
root.mkdir(mode=0o700, exist_ok=True)
# The image supplies only its immutable /web build. No database, SSH, connector
# secret, Docker socket, or interactive session is mounted into the publisher.
subprocess.run([
    'docker', 'run', '--rm', '--network', 'host', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-v', str(state / 'engine') + ':/run/codex-engine:ro',
    '-v', str(root) + ':/releases', 'codex-web-hub:' + a.revision,
    'node', 'dist/publish-web.js', '/web', '/releases',
    '/run/codex-engine/engine.sock', a.revision, a.check_url,
], check=True)
