#!/usr/bin/env python3
"""Guarded first split / engine upgrade. UI-only releases use publish-web.py."""
import argparse
from contextlib import ExitStack
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
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine_checkpoint


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


def owner_activation(state, config):
    """First owner-only team activation; never treat an existing team as single-user."""
    assert not config.get('team', {}).get('enabled'), 'Team upgrades require full registry backup admission'
    root = Path(config.get('team', {}).get('root', str(state / 'data/team')))
    assert root.is_absolute() and not root.is_symlink()
    assert root.resolve().is_relative_to((state / 'data').resolve()) and root.resolve() != (state / 'data').resolve()
    assert not root.exists() or (root.is_dir() and not any(root.iterdir())), 'Team state already exists'
    assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}', config['auth'].get('ownerLogin', ''))
    target = json.loads(json.dumps(config))
    target['team'] = dict(config.get('team', {}), enabled=True, registrationEnabled=False, root=str(root))
    return target, root


def restore_owner_activation(state, original, root, revision):
    """Before public admission, preserve failed team metadata and restore exact old config."""
    assert root.resolve().is_relative_to((state / 'data').resolve()) and root.resolve() != (state / 'data').resolve()
    assert not root.is_symlink()
    if root.exists():
        root.rename(root.with_name(root.name + '-failed-' + revision + '-' + str(time.time_ns())))
    temporary = state / 'config.rollback.tmp'
    temporary.write_bytes(original)
    temporary.chmod(0o600)
    temporary.replace(state / 'config.json')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('revision')
    p.add_argument('--expected', required=True)
    p.add_argument('--state', default=os.environ.get('CODEX_WEB_STATE'))
    p.add_argument('--release', required=True)
    p.add_argument('--verification', required=True)
    p.add_argument('--check', action='store_true')
    p.add_argument('--enable-team-owner', action='store_true')
    a = p.parse_args()
    if not a.state or not all(re.fullmatch(r'[a-f0-9]{7,64}', x) for x in [a.revision, a.expected]):
        p.error('Explicit state and image revisions required')
    state, release = Path(a.state).resolve(strict=True), Path(a.release).resolve(strict=True)
    proof = json.loads(Path(a.verification).read_text())
    assert proof['revision'] == a.revision and all(proof[k] for k in ['build', 'typecheck', 'repositoryChecks', 'tests', 'browsers', 'imageSmoke'])
    image = inspect('codex-web-hub:' + a.revision)
    assert image and image['Config']['Labels']['org.opencontainers.image.revision'] == a.revision
    assert image['Config']['Labels'].get('io.codex-web.release-kind') != 'web-only', 'Asset publisher is not an engine release'
    # Git's default abbreviation length differs as object databases grow. Match
    # the explicit image revision against HEAD rather than that local default.
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=release, text=True).strip().startswith(a.revision)
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=release, text=True).strip()
    old_engine = inspect('codex-web-engine')
    container = 'codex-web-engine' if old_engine else 'codex-web-hub'
    old = old_engine or inspect(container)
    assert old and old['Config']['Labels']['org.opencontainers.image.revision'] == a.expected
    original_config = (state / 'config.json').read_bytes()
    config = json.loads(original_config)
    enabled_team = bool(config.get('team', {}).get('enabled'))
    if enabled_team:
        assert old_engine and not a.enable_team_owner
        assert all(proof.get(k) for k in ['teamCheckpoint', 'teamRollback', 'teamUpgradeAdmission', 'codexContinuityPreflight'])
        engine_checkpoint.team_layout(state, config)
    activation = owner_activation(state, config) if a.enable_team_owner else None
    if activation:
        assert all(proof.get(k) for k in ['ownerMigration', 'ownerTeamImage', 'ownerRollback', 'codexContinuityPreflight'])
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
    with ExitStack() as resources:
        lock = resources.enter_context((state / 'send-handoff-deploy.lock').open('w'))
        fcntl.flock(lock, fcntl.LOCK_EX)
        if enabled_team:
            # Serialize host profile provisioning and stopped-profile recovery as
            # well as engine deployments. Never copy a running browser profile.
            host_lock_path = engine_checkpoint.canonical(Path(config['team']['root']) / 'gpt-host.lock')
            host_lock = resources.enter_context(host_lock_path.open('a'))
            fcntl.flock(host_lock, fcntl.LOCK_EX)
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
            # Enabled Team's reservation freezes all API/native mutation paths.
            # An owner-only SQLite lock cannot protect the other namespaces and
            # can deadlock graceful shutdown writes, so it is only legacy fallback.
            db = None if enabled_team else sqlite3.connect(database, timeout=5)
            try:
                if db:
                    db.execute('BEGIN IMMEDIATE')
                if not idle(reserve_terminals=True):
                    continue
                assert inspect(container)['Config']['Labels']['org.opencontainers.image.revision'] == a.expected
                assert (state / 'config.json').read_bytes() == original_config, 'Configuration changed while waiting'
                if activation:
                    owner_activation(state, config)
                status('installing')
                # No public admission after the final database-locked recheck.
                run(['docker', 'stop', '--time', '10', 'codex-web-hub'])
                if old_engine:
                    run(['docker', 'stop', '--time', '45', container])
                break
            except Exception:
                # No candidate has started. A failed stop must not strand the
                # public gateway or leave the installation falsely "installing".
                if old_engine:
                    run(['docker', 'start', container])
                run(['docker', 'start', 'codex-web-hub'])
                status('failed', code='ENGINE_STOP_FAILED')
                raise
            finally:
                if db:
                    if db.in_transaction:
                        db.rollback()
                    db.close()
        backup = state / ('before-engine-' + a.revision + '.sqlite')
        checkpoint = None
        try:
            if enabled_team:
                checkpoint = engine_checkpoint.create(state, state / 'backups' / ('before-team-engine-' + a.revision + '-' + str(time.time_ns())), a.expected)
            else:
                with sqlite3.connect(database) as source, sqlite3.connect(backup) as destination:
                    source.backup(destination)
                backup.chmod(0o600)
        except Exception:
            if old_engine:
                run(['docker', 'start', container])
            run(['docker', 'start', 'codex-web-hub'])
            status('failed', code='BACKUP_FAILED')
            raise
        env = state / 'deploy.env'
        previous_env = env.read_text() if env.exists() else ''
        previous_pointer = (web / 'current.json').read_text() if (web / 'current.json').exists() else None
        compose = ['docker', 'compose', '--env-file', str(env), '-f', str(release / 'ops/linux/compose.yaml')]
        exposed = False
        try:
            update_env(env, dict(WEB_REVISION=a.revision, ENGINE_REVISION=a.revision))
            if activation:
                before_config = state / ('before-owner-team-' + a.revision + '.json')
                before_config.write_bytes(original_config)
                before_config.chmod(0o600)
                atomic(state / 'config.json', activation[0])
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--wait', 'engine'])
            if activation:
                run(['docker', 'exec', 'codex-web-engine', 'node', 'dist/owner-team-check.js'])
            if checkpoint:
                engine_checkpoint.admission(state, checkpoint)
            run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
                 '-v', str(state / 'engine') + ':/run/codex-engine:ro', '-v', str(web) + ':/releases',
                 'codex-web-hub:' + a.revision, 'node', 'dist/publish-web.js', '/web', '/releases', '/run/codex-engine/engine.sock', a.revision])
            # After admission, failures require forward repair; never restore an
            # old database over newly accepted owner work.
            exposed = True
            if checkpoint:
                # Persist this boundary before starting any public gateway. A
                # later host recovery must not restore over admitted user writes.
                engine_checkpoint.write_json(checkpoint / 'admitted.json', dict(revision=a.revision, at=time.time_ns()))
            run(compose + ['up', '-d', '--no-deps', '--no-build', '--wait', 'hub'])
            run(['python3', str(release / 'ops/linux/publish-web.py'), a.revision, '--state', str(state)])
            run(['docker', 'exec', 'codex-web-engine', 'node', 'dist/doctor.js', '--config', '/config/config.json', '--json', '--public'], stdout=subprocess.DEVNULL)
            backup_env = Path.home() / '.config/codex-web/backup.env'
            if backup_env.exists():
                update_env(backup_env, dict(CODEX_WEB_IMAGE='codex-web-hub:' + a.revision, CODEX_WEB_REVISION=a.revision))
            status('installed', installedAt=int(time.time()*1000))
            atomic(state / ('deployment-' + a.revision + '.json'), dict(revision=a.revision, previousRevision=a.expected, schema=proof['schema'], healthy=True, separated=True, checkpoint=str(checkpoint) if checkpoint else None, deployedAt=datetime.now(timezone.utc).isoformat(), verification=str(Path(a.verification).resolve())))
        except Exception:
            status('failed', code='ENGINE_MAINTENANCE_FAILED')
            if not exposed:
                run(['docker', 'stop', '--time', '30', 'codex-web-engine'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if checkpoint:
                    engine_checkpoint.restore(state, checkpoint)
                else:
                    with sqlite3.connect(backup) as source, sqlite3.connect(database) as destination:
                        source.backup(destination)
                if activation:
                    restore_owner_activation(state, original_config, activation[1], a.revision)
                env.write_text(previous_env)
                if previous_pointer:
                    (web / 'current.json').write_text(previous_pointer)
                if old_engine:
                    # The original image remains available. Recreate using the
                    # old revisions without ever applying an old image to schema 27+.
                    # Keep the exact former gateway and engine pair; compatible
                    # web-only releases may have advanced independently.
                    run(compose + ['up', '-d', '--no-deps', '--no-build', '--wait', 'engine', 'hub'])
                else:
                    run(['docker', 'start', 'codex-web-hub'])
                status('rolled_back', code='ENGINE_MAINTENANCE_FAILED')
            raise


if __name__ == '__main__':
    os.umask(0o077)
    main()
