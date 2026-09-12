#!/usr/bin/env python3
"""Guarded first split / engine upgrade. UI-only releases use publish-web.py."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def inspect(name):
    result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def atomic(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def update_env(path, values):
    old = path.read_text() if path.exists() else ''
    lines = [line for line in old.splitlines() if line.split('=', 1)[0] not in values]
    path.write_text('\n'.join(lines + [k + '=' + v for k, v in values.items()]) + '\n')
    path.chmod(0o600)
    return old


def main():
    p = argparse.ArgumentParser()
    p.add_argument('revision')
    p.add_argument('--expected', required=True)
    p.add_argument('--state', default=os.environ.get('CODEX_WEB_STATE'))
    p.add_argument('--release', required=True)
    p.add_argument('--verification', required=True)
    p.add_argument('--check', action='store_true')
    a = p.parse_args()
    if not a.state or not all(re.fullmatch(r'[a-f0-9]{7,64}', x) for x in [a.revision, a.expected]):
        p.error('Explicit state and image revisions required')
    state, release = Path(a.state).resolve(strict=True), Path(a.release).resolve(strict=True)
    proof = json.loads(Path(a.verification).read_text())
    assert proof['revision'] == a.revision and all(proof[k] for k in ['build', 'typecheck', 'repositoryChecks', 'tests', 'browsers', 'imageSmoke'])
    image = inspect('codex-web-hub:' + a.revision)
    assert image and image['Config']['Labels']['org.opencontainers.image.revision'] == a.revision
    assert subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=release, text=True).strip() == a.revision
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=release, text=True).strip()
    old_engine = inspect('codex-web-engine')
    container = 'codex-web-engine' if old_engine else 'codex-web-hub'
    old = old_engine or inspect(container)
    assert old and old['Config']['Labels']['org.opencontainers.image.revision'] == a.expected
    config = json.loads((state / 'config.json').read_text())
    database = Path(config['hub']['databasePath']).resolve(strict=True)
    assert database.is_relative_to(state / 'data')
    web = state / 'web-releases'
    for directory in [web, state / 'engine']:
        directory.mkdir(mode=0o700, exist_ok=True)
    started = int(time.time() * 1000)

    def status(value, **extra):
        atomic(web / 'maintenance.json', dict(kind='engine', revision=a.revision, state=value, startedAt=started, updatedAt=int(time.time()*1000), **extra))

    def idle(reserve_terminals=False):
        try:
            if old_engine:
                return subprocess.run(['docker', 'exec', container, 'node', 'dist/maintenance-check.js'] + (['--reserve-terminals'] if reserve_terminals else []), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=40).returncode == 0
            # Compatibility with the pre-split production service. These guards
            # were already installed/verified by its maintenance releases.
            for name in ['send-handoff-idle.mjs', 'reliability-gpt-idle.mjs', 'workflow-deploy-guard.mjs']:
                with (state / name).open() as stream:
                    if subprocess.run(['docker', 'exec', '-i', container, 'node', '--input-type=module', '-'], stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25).returncode:
                        return False
            return True
        except (OSError, subprocess.TimeoutExpired):
            return False

    if a.check:
        print(json.dumps(dict(verified=True, idle=idle(), previous=a.expected)))
        return
    with (state / 'send-handoff-deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        assert inspect(container)['Config']['Labels']['org.opencontainers.image.revision'] == a.expected
        # Keep chunks loaded lazily by clients already running the monolithic UI.
        # This is public build output only, never the old container's data/profile.
        if not old_engine:
            with tempfile.TemporaryDirectory(prefix='retain-ui-', dir=state) as temp:
                run(['docker', 'cp', 'codex-web-hub:/web/.', temp])
                for source in (Path(temp) / 'assets').rglob('*'):
                    assert not source.is_symlink()
                    if not source.is_file():
                        continue
                    target = web / 'retained' / source.relative_to(temp)
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if target.exists():
                        assert hashlib.sha256(source.read_bytes()).digest() == hashlib.sha256(target.read_bytes()).digest()
                    else:
                        shutil.copyfile(source, target)
        status('waiting')
        while True:
            if not idle():
                time.sleep(5)
                continue
            db = sqlite3.connect(database, timeout=5)
            try:
                db.execute('BEGIN IMMEDIATE')
                if not idle(reserve_terminals=True):
                    continue
                assert inspect(container)['Config']['Labels']['org.opencontainers.image.revision'] == a.expected
                status('installing')
                # No public admission after the final database-locked recheck.
                run(['docker', 'stop', '--time', '30', 'codex-web-hub'])
                if old_engine:
                    run(['docker', 'stop', '--time', '45', container])
                break
            finally:
                if db.in_transaction:
                    db.rollback()
                db.close()
        backup = state / ('before-engine-' + a.revision + '.sqlite')
        try:
            with sqlite3.connect(database) as source, sqlite3.connect(backup) as destination:
                source.backup(destination)
        except Exception:
            if old_engine:
                run(['docker', 'start', container])
            run(['docker', 'start', 'codex-web-hub'])
            status('failed', code='BACKUP_FAILED')
            raise
        backup.chmod(0o600)
        env = state / 'deploy.env'
        previous_env = update_env(env, dict(WEB_REVISION=a.revision, ENGINE_REVISION=a.revision))
        previous_pointer = (web / 'current.json').read_text() if (web / 'current.json').exists() else None
        compose = ['docker', 'compose', '--env-file', str(env), '-f', str(release / 'ops/linux/compose.yaml')]
        exposed = False
        try:
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--wait', 'engine'])
            run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
                 '-v', str(state / 'engine') + ':/run/codex-engine:ro', '-v', str(web) + ':/releases',
                 'codex-web-hub:' + a.revision, 'node', 'dist/publish-web.js', '/web', '/releases', '/run/codex-engine/engine.sock', a.revision])
            # After admission, failures require forward repair; never restore an
            # old database over newly accepted owner work.
            exposed = True
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--wait', 'hub'])
            run(['python3', str(release / 'ops/linux/publish-web.py'), a.revision, '--state', str(state)])
            run(['docker', 'exec', 'codex-web-engine', 'node', 'dist/doctor.js', '--config', '/config/config.json', '--json', '--public'], stdout=subprocess.DEVNULL)
            backup_env = Path.home() / '.config/codex-web/backup.env'
            if backup_env.exists():
                update_env(backup_env, dict(CODEX_WEB_IMAGE='codex-web-hub:' + a.revision, CODEX_WEB_REVISION=a.revision))
            status('installed', installedAt=int(time.time()*1000))
            atomic(state / ('deployment-' + a.revision + '.json'), dict(revision=a.revision, previousRevision=a.expected, schema=proof['schema'], healthy=True, separated=True, deployedAt=datetime.now(timezone.utc).isoformat(), verification=str(Path(a.verification).resolve())))
        except Exception:
            status('failed', code='ENGINE_MAINTENANCE_FAILED')
            if not exposed:
                subprocess.run(['docker', 'stop', '--time', '30', 'codex-web-engine'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with sqlite3.connect(backup) as source, sqlite3.connect(database) as destination:
                    source.backup(destination)
                env.write_text(previous_env)
                if previous_pointer:
                    (web / 'current.json').write_text(previous_pointer)
                if old_engine:
                    # The original image remains available. Recreate using the
                    # old revisions without ever applying an old image to schema 27+.
                    update_env(env, dict(WEB_REVISION=a.expected, ENGINE_REVISION=a.expected))
                    run(compose + ['up', '-d', '--no-deps', '--no-build', '--wait', 'engine', 'hub'])
                else:
                    run(['docker', 'start', 'codex-web-hub'])
                status('rolled_back', code='ENGINE_MAINTENANCE_FAILED')
            raise


if __name__ == '__main__':
    os.umask(0o077)
    main()
