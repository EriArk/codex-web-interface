"""Cold, same-installation Team checkpoints. Not a portable/native-profile backup.

The caller holds the deployment and GPT-host locks, closes public admission and
stops the engine. Restore is allowed only before the replacement gateway starts.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import time


def require(value, code):
    if not value:
        raise RuntimeError(code)


def canonical(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, 'CHECKPOINT_PATH')
    return path


def file_hash(path):
    require(stat.S_ISREG(path.lstat().st_mode), 'CHECKPOINT_FILE')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    with path.open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())


def database(path):
    canonical(path)
    require(path.is_file() and not path.is_symlink(), 'CHECKPOINT_DATABASE_MISSING')
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'CHECKPOINT_DATABASE_INTEGRITY')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'CHECKPOINT_DATABASE_FOREIGN_KEY')
        return db
    except BaseException:
        db.close()
        raise


def team_layout(state, config, data=None):
    """Validate every account, including disabled and not-yet-opened namespaces."""
    data = canonical(data or state / 'data')
    configured_data = canonical(state / 'data')
    require(config.get('team', {}).get('enabled'), 'CHECKPOINT_TEAM_REQUIRED')
    team = canonical(config['team']['root'])
    owner_db = canonical(config['hub']['databasePath'])
    results = canonical(config['hub']['resultsPath'])
    for path in (team, owner_db, results):
        require(path != configured_data and path.is_relative_to(configured_data), 'CHECKPOINT_STORAGE_OUTSIDE_DATA')
    require(not owner_db.is_relative_to(team) and not results.is_relative_to(team), 'CHECKPOINT_STORAGE_OVERLAP')
    require(not owner_db.is_relative_to(results) and not team.is_relative_to(results), 'CHECKPOINT_STORAGE_OVERLAP')
    relative_team = team.relative_to(configured_data)
    registry = data / relative_team / 'team.db'
    db = database(registry)
    try:
        owner = db.execute("SELECT value FROM team_meta WHERE key='originalOwner'").fetchone()
        require(owner and re.fullmatch(r'[a-f0-9-]{36}', owner[0]), 'CHECKPOINT_OWNER')
        users = db.execute('SELECT u.id,u.legacy,n.initialized FROM team_users u LEFT JOIN team_namespaces n ON n.userId=u.id ORDER BY u.id').fetchall()
        require(1 <= len(users) <= 10 and [u[0] for u in users if u[1]] == [owner[0]], 'CHECKPOINT_OWNER_MAPPING')
        require(all(re.fullmatch(r'[a-f0-9-]{36}', u[0]) and u[1] in (0, 1) and u[2] in (0, 1) for u in users), 'CHECKPOINT_NAMESPACE')
        require(not db.execute("SELECT p.id FROM team_projects p WHERE (SELECT count(*) FROM team_project_members m WHERE m.projectId=p.id AND m.role='owner' AND m.state='active') != 1 OR NOT EXISTS (SELECT 1 FROM team_project_members m WHERE m.projectId=p.id AND m.userId=p.ownerId AND m.role='owner' AND m.state='active')").fetchall(), 'CHECKPOINT_PROJECT_OWNER')
        databases = [registry.relative_to(data).as_posix()]
        for user, legacy, initialized in users:
            require(not legacy or initialized, 'CHECKPOINT_OWNER_STORAGE')
            if initialized:
                path = owner_db.relative_to(configured_data) if legacy else relative_team / 'users' / user / 'app.db'
                selected = database(data / path)
                selected.close()
                databases.append(path.as_posix())
        # Exclude entire browser mounts, not just Chromium lock files. These live
        # containers keep the same profile inodes throughout update and rollback.
        protected = [(relative_team / 'gpt-host.lock').as_posix()]
        protected += [(relative_team / 'users' / u[0] / 'gpt').as_posix() for u in users]
        return dict(ownerId=owner[0], users=users, databases=databases, protected=sorted(protected))
    finally:
        db.close()


def privacy(data, registry, expected=None):
    """Compare old access/binding columns even if an upgrade adds schema columns.

Sessions and audit can expire/grow at boot. Their exact bytes still belong to the
checkpoint; all durable Team access, content and operation tables must survive.
"""
    db = database(data / registry)
    try:
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'team_%' ORDER BY name")]
        tables = [name for name in tables if name not in ('team_sessions', 'team_audit')]
        if expected:
            require(set(expected) <= set(tables), 'CHECKPOINT_PRIVACY_TABLE_MISSING')
            tables = list(expected)
        result = {}
        for table in tables:
            require(re.fullmatch(r'team_[a-z_]+', table), 'CHECKPOINT_TABLE')
            columns = expected[table]['columns'] if expected else [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
            require(all(re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', column) for column in columns), 'CHECKPOINT_COLUMN')
            rows = db.execute('SELECT ' + ','.join('"' + c + '"' for c in columns) + f' FROM "{table}"' + (" WHERE key!='schema'" if table == 'team_meta' else '')).fetchall()
            serialized = sorted(json.dumps(row, separators=(',', ':')) for row in rows)
            result[table] = dict(columns=columns, hash=hashlib.sha256(json.dumps(serialized).encode()).hexdigest())
        return result
    finally:
        db.close()


def private_bindings(data, databases, expected=None):
    result = {}
    for name in databases[1:]:
        db = database(data / name)
        try:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            # Existing private table presence and stable identities must survive
            # boot. Native history/status can legitimately refresh independently.
            required = expected[name]['tables'] if expected else sorted(tables - {'sqlite_sequence'})
            require(set(required) <= tables, 'CHECKPOINT_PRIVATE_TABLE_MISSING')
            hashes = {}
            for table, columns in [('users', ['username', 'passwordHash']), ('threads', ['id', 'projectId', 'codexThreadId'])]:
                if table not in tables:
                    continue
                rows = db.execute('SELECT ' + ','.join(columns) + f' FROM "{table}" ORDER BY 1').fetchall()
                hashes[table] = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
            result[name] = dict(tables=required, identities=hashes)
        finally:
            db.close()
    return result


def inventory(root, protected=(), databases=()):
    root = canonical(root)
    entries = {}
    volatile = {name + '-shm' for name in databases}
    def visit(folder):
        for path in sorted(folder.iterdir()):
            name = path.relative_to(root).as_posix()
            if name in volatile:
                require(path.is_file() and not path.is_symlink(), 'CHECKPOINT_SQLITE_SHM')
                continue  # SQLite rebuilds its shared-memory index from the saved WAL.
            if name in protected:
                require(not path.is_symlink(), 'CHECKPOINT_PROTECTED_LINK')
                continue
            info = path.lstat()
            require(not path.is_symlink(), 'CHECKPOINT_LINK')
            require(len(path.relative_to(root).parts) <= 40, 'CHECKPOINT_DEPTH')
            if stat.S_ISDIR(info.st_mode):
                entries[name] = dict(kind='directory', mode=stat.S_IMODE(info.st_mode))
                visit(path)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'CHECKPOINT_SPECIAL_FILE')
                entries[name] = dict(kind='file', mode=stat.S_IMODE(info.st_mode), bytes=info.st_size, hash=file_hash(path))
            require(len(entries) <= 200000, 'CHECKPOINT_LIMIT')
    visit(root)
    return entries


def copy_inventory(source, target, entries):
    require(not target.exists(), 'CHECKPOINT_TARGET_EXISTS')
    target.mkdir(mode=0o700)
    for name, item in entries.items():
        path = target / name
        require(path.is_relative_to(target) and '..' not in Path(name).parts and not Path(name).is_absolute(), 'CHECKPOINT_ENTRY')
        if item['kind'] == 'directory':
            path.mkdir(mode=0o700)
        else:
            shutil.copyfile(source / name, path)
            path.chmod(0o600)
            require(path.stat().st_size == item['bytes'] and file_hash(path) == item['hash'], 'CHECKPOINT_COPY_CHANGED')


def verify(checkpoint):
    canonical(checkpoint)
    require(not checkpoint.is_symlink(), 'CHECKPOINT_LINK')
    manifest = json.loads((checkpoint / 'checkpoint.json').read_text())
    require(manifest['kind'] == 'codex-web-engine-checkpoint' and manifest['format'] == 1, 'CHECKPOINT_FORMAT')
    actual = inventory(checkpoint / 'data', databases=manifest['layout']['databases'])
    # Copied files/directories have intentionally more restrictive permissions.
    comparable = lambda entries: {p: {k: v for k, v in item.items() if k != 'mode'} for p, item in entries.items()}
    require(comparable(actual) == comparable(manifest['entries']), 'CHECKPOINT_CHECKSUM')
    for name, digest in manifest['private'].items():
        require(name in ('config.json', 'deploy.env', 'web-pointer.json'), 'CHECKPOINT_PRIVATE_PATH')
        require(file_hash(checkpoint / name) == digest, 'CHECKPOINT_CONFIG_CHECKSUM')
    config = json.loads((checkpoint / 'config.json').read_text())
    layout = team_layout(Path(manifest['state']), config, checkpoint / 'data')
    # JSON encodes database tuples as arrays.
    require(json.loads(json.dumps(layout)) == manifest['layout'], 'CHECKPOINT_MAPPING_CHANGED')
    require(privacy(checkpoint / 'data', layout['databases'][0], manifest['privacy']) == manifest['privacy'], 'CHECKPOINT_PRIVACY_CHANGED')
    require(private_bindings(checkpoint / 'data', layout['databases'], manifest['privateBindings']) == manifest['privateBindings'], 'CHECKPOINT_PRIVATE_IDENTITY_CHANGED')
    return manifest


def create(state, destination, revision):
    state, destination = canonical(state), canonical(destination)
    require(not destination.is_relative_to(state / 'data'), 'CHECKPOINT_DESTINATION')
    require(not destination.exists(), 'CHECKPOINT_TARGET_EXISTS')
    destination.mkdir(mode=0o700, parents=True)
    try:
        config = json.loads((state / 'config.json').read_text())
        layout = team_layout(state, config)
        entries = inventory(state / 'data', layout['protected'], layout['databases'])
        require(shutil.disk_usage(destination).free > 3 * sum(item.get('bytes', 0) for item in entries.values()) + 64 * 1024 ** 2, 'CHECKPOINT_DISK_SPACE')
        copy_inventory(state / 'data', destination / 'data', entries)
        private = {}
        for name, source in [('config.json', state / 'config.json'), ('deploy.env', state / 'deploy.env'), ('web-pointer.json', state / 'web-releases/current.json')]:
            if source.exists():
                canonical(source)
                shutil.copyfile(source, destination / name)
                (destination / name).chmod(0o600)
                private[name] = file_hash(destination / name)
        require(inventory(state / 'data', layout['protected'], layout['databases']) == entries, 'CHECKPOINT_SOURCE_CHANGED')
        manifest = dict(kind='codex-web-engine-checkpoint', format=1, revision=revision, state=str(state), layout=layout, entries=entries, private=private,
                        privacy=privacy(state / 'data', layout['databases'][0]), privateBindings=private_bindings(state / 'data', layout['databases']), createdAt=time.time_ns())
        write_json(destination / 'checkpoint.json', manifest)
        verify(destination)
        # Rehearse the exact file copy used for rollback, offline and without any
        # App Server startup, migration or replay of unknown native operations.
        copy_inventory(destination / 'data', destination / 'restore-check', entries)
        require(inventory(destination / 'restore-check', databases=layout['databases']) == inventory(destination / 'data', databases=layout['databases']), 'CHECKPOINT_REHEARSAL')
        for name in layout['databases']:
            db = database(destination / 'restore-check' / name)
            db.close()
        shutil.rmtree(destination / 'restore-check')
        write_json(destination / 'verified.json', dict(restored=True, revision=revision))
        return destination
    except BaseException:
        # Keep incomplete evidence in a private, never-retained-as-valid folder.
        if destination.exists():
            destination.rename(destination.with_name(destination.name + '-incomplete-' + str(time.time_ns())))
        raise


def admission(state, checkpoint):
    manifest = verify(checkpoint)
    require(str(canonical(state)) == manifest['state'], 'CHECKPOINT_INSTALLATION')
    require(file_hash(state / 'config.json') == manifest['private']['config.json'], 'CHECKPOINT_CONFIG_CHANGED')
    layout = team_layout(state, json.loads((state / 'config.json').read_text()))
    require(json.loads(json.dumps(layout)) == manifest['layout'], 'CHECKPOINT_MAPPING_CHANGED')
    require(privacy(state / 'data', layout['databases'][0], manifest['privacy']) == manifest['privacy'], 'CHECKPOINT_PRIVACY_CHANGED')
    require(private_bindings(state / 'data', layout['databases'], manifest['privateBindings']) == manifest['privateBindings'], 'CHECKPOINT_PRIVATE_IDENTITY_CHANGED')


def restore(state, checkpoint):
    manifest = verify(checkpoint)
    require(str(canonical(state)) == manifest['state'], 'CHECKPOINT_INSTALLATION')
    require(not (checkpoint / 'admitted.json').exists(), 'CHECKPOINT_ALREADY_ADMITTED')
    protected = manifest['layout']['protected']
    current = inventory(state / 'data', protected, manifest['layout']['databases'])
    staged = state / ('engine-restore-' + str(time.time_ns()))
    copy_inventory(checkpoint / 'data', staged, manifest['entries'])
    failed = state / ('engine-failed-' + str(time.time_ns()))
    failed.mkdir(mode=0o700)
    # Move only disjoint subtrees. Protected profile mounts and the held host-lock
    # inode remain in place; all failed engine data is retained, including new files.
    def units(names):
        result = []
        for name in sorted(names, key=lambda n: (len(Path(n).parts), n)):
            if any(name == p or p.startswith(name + '/') for p in protected):
                continue
            if not any(name.startswith(parent + '/') for parent in result):
                result.append(name)
        return result
    volatile = {name + '-shm' for name in manifest['layout']['databases'] if (state / 'data' / (name + '-shm')).exists()}
    targets = units(set(current) | set(manifest['entries']) | volatile)
    write_json(failed / 'restore-journal.json', dict(checkpoint=str(checkpoint), staged=str(staged), targets=targets))
    for name in targets:
        live = state / 'data' / name
        if live.exists():
            saved = failed / 'data' / name
            saved.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            live.rename(saved)
        source = staged / name
        if source.exists():
            live.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source.rename(live)
    # Preserve engine-visible permission bits (e.g. owner-only executable helpers).
    for name, item in sorted(manifest['entries'].items(), reverse=True):
        (state / 'data' / name).chmod(item['mode'])
    for name, target in [('config.json', state / 'config.json'), ('deploy.env', state / 'deploy.env'), ('web-pointer.json', state / 'web-releases/current.json')]:
        if name in manifest['private']:
            temporary = target.with_name(target.name + '.rollback')
            shutil.copyfile(checkpoint / name, temporary)
            temporary.chmod(0o600)
            temporary.replace(target)
    admission(state, checkpoint)
    shutil.rmtree(staged)
    write_json(failed / 'restored.json', dict(ok=True, checkpoint=str(checkpoint)))
    return failed
