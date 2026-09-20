"""Offline update/rollback fixtures. No Docker/native credentials or networking."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import subprocess

sys.path.insert(0, str(Path('ops/linux').resolve()))
import engine_checkpoint as checkpoint

OWNER = '11111111-1111-4111-8111-111111111111'
MEMBER = '22222222-2222-4222-8222-222222222222'
UNOPENED = '33333333-3333-4333-8333-333333333333'


class CheckpointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.data = self.state / 'data'
        self.team = self.data / 'team'
        self.team.mkdir(parents=True)
        self.profile = self.team / 'users' / MEMBER / 'gpt'
        self.profile.mkdir(parents=True)
        (self.profile / 'session').write_text('same private browser')
        (self.profile / 'SingletonSocket').symlink_to('/tmp/fixture-browser-socket')
        (self.team / 'gpt-host.lock').touch()
        self.config = {'team': {'enabled': True, 'root': str(self.team), 'registrationEnabled': False}, 'hub': {'databasePath': str(self.data / 'app.db'), 'resultsPath': str(self.data / 'results')}, 'auth': {'username': 'owner', 'ownerLogin': 'eriark'}}
        (self.state / 'config.json').write_text(json.dumps(self.config))
        (self.state / 'deploy.env').write_text('ENGINE_REVISION=aaaaaaa\nWEB_REVISION=bbbbbbb\n')
        (self.state / 'web-releases').mkdir()
        (self.state / 'web-releases/current.json').write_text('{"id":"old-assets"}')
        for path in [self.data / 'app.db', self.team / 'users' / MEMBER / 'app.db']:
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE content(id TEXT PRIMARY KEY, value TEXT); INSERT INTO content VALUES('native-thread','private text'); CREATE TABLE receipts(id TEXT PRIMARY KEY,state TEXT); INSERT INTO receipts VALUES('pending-native','unknown');")
                db.executescript("CREATE TABLE users(username TEXT PRIMARY KEY,passwordHash TEXT); INSERT INTO users VALUES('owner','same-password-hash'); CREATE TABLE threads(id TEXT PRIMARY KEY,projectId TEXT,codexThreadId TEXT); INSERT INTO threads VALUES('hub-thread','project','native-thread');")
            results = path.parent / 'results'
            results.mkdir()
            (results / 'private.bin').write_bytes(b'private result')
        (self.team / 'shared-results').mkdir()
        (self.team / 'shared-results/shared.bin').write_bytes(b'published result')
        with sqlite3.connect(self.team / 'team.db') as db:
            db.executescript('''
            PRAGMA foreign_keys=ON;
            CREATE TABLE team_meta(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE team_users(id TEXT PRIMARY KEY,legacy INTEGER,login TEXT,passwordHash TEXT,state TEXT);
            CREATE TABLE team_namespaces(userId TEXT PRIMARY KEY REFERENCES team_users(id),initialized INTEGER);
            CREATE TABLE team_projects(id TEXT PRIMARY KEY,ownerId TEXT REFERENCES team_users(id));
            CREATE TABLE team_project_members(projectId TEXT REFERENCES team_projects(id),userId TEXT REFERENCES team_users(id),role TEXT,state TEXT);
            CREATE TABLE team_gpt_profiles(userId TEXT PRIMARY KEY REFERENCES team_users(id),slot INTEGER,serviceToken TEXT);
            CREATE TABLE team_receipts(userId TEXT,scope TEXT,state TEXT);
            CREATE TABLE team_audit(seq INTEGER PRIMARY KEY,action TEXT);
            CREATE TABLE team_sessions(tokenHash TEXT PRIMARY KEY,userId TEXT REFERENCES team_users(id));
            ''')
            db.execute("INSERT INTO team_meta VALUES('originalOwner',?)", (OWNER,))
            for user, legacy, state, initialized in [(OWNER, 1, 'active', 1), (MEMBER, 0, 'disabled', 1), (UNOPENED, 0, 'active', 0)]:
                db.execute('INSERT INTO team_users VALUES(?,?,?,?,?)', (user, legacy, 'eriark' if legacy else user, 'same-password-hash', state))
                db.execute('INSERT INTO team_namespaces VALUES(?,?)', (user, initialized))
            db.execute("INSERT INTO team_projects VALUES('shared',?)", (OWNER,))
            db.execute("INSERT INTO team_project_members VALUES('shared',?,'owner','active')", (OWNER,))
            db.execute("INSERT INTO team_project_members VALUES('shared',?,'collaborator','active')", (MEMBER,))
            db.execute("INSERT INTO team_gpt_profiles VALUES(?,1,'same-private-token')", (MEMBER,))
            db.execute("INSERT INTO team_receipts VALUES(?,'send','unknown')", (MEMBER,))
            db.execute("INSERT INTO team_sessions VALUES('original-session',?)", (OWNER,))
        self.target = self.state / 'backups/checkpoint'

    def create(self):
        return checkpoint.create(self.state, self.target, 'aaaaaaa')

    def test_exact_restore_retains_private_namespaces_assets_unknown_receipts_and_profile_inodes(self):
        old_profile = self.profile.stat().st_ino
        lock_inode = (self.team / 'gpt-host.lock').stat().st_ino
        self.create()
        manifest = checkpoint.verify(self.target)
        self.assertEqual(len(manifest['layout']['users']), 3)
        self.assertFalse(any('/gpt/' in path for path in manifest['entries']))
        self.assertFalse((self.target / 'restore-check').exists())
        checkpoint.admission(self.state, self.target)
        with sqlite3.connect(self.team / 'team.db') as db:
            db.execute("UPDATE team_users SET passwordHash='broken'")
            db.execute('DELETE FROM team_sessions')
        with sqlite3.connect(self.team / 'users' / MEMBER / 'app.db') as db:
            db.execute('DELETE FROM content')
            db.execute("UPDATE receipts SET state='done'")
        (self.data / 'results/private.bin').write_bytes(b'changed')
        (self.team / 'shared-results/new.bin').write_bytes(b'failed new asset')
        (self.state / 'deploy.env').write_text('ENGINE_REVISION=ccccccc')
        with self.assertRaisesRegex(RuntimeError, 'PRIVACY_CHANGED'):
            checkpoint.admission(self.state, self.target)
        failed = checkpoint.restore(self.state, self.target)
        self.assertTrue((failed / 'data/team/shared-results/new.bin').exists())
        self.assertFalse((self.team / 'shared-results/new.bin').exists())
        self.assertEqual(self.profile.stat().st_ino, old_profile)
        self.assertEqual((self.team / 'gpt-host.lock').stat().st_ino, lock_inode)
        self.assertTrue((self.profile / 'SingletonSocket').is_symlink())
        self.assertEqual((self.data / 'results/private.bin').read_bytes(), b'private result')
        self.assertIn('WEB_REVISION=bbbbbbb', (self.state / 'deploy.env').read_text())
        with sqlite3.connect(self.team / 'team.db') as db:
            self.assertEqual(db.execute('SELECT tokenHash FROM team_sessions').fetchall(), [('original-session',)])
        with sqlite3.connect(self.team / 'users' / MEMBER / 'app.db') as db:
            self.assertEqual(db.execute('SELECT * FROM content').fetchall(), [('native-thread', 'private text')])
            self.assertEqual(db.execute('SELECT state FROM receipts').fetchone(), ('unknown',))
        checkpoint.verify(self.target)

    def test_restore_forbidden_after_admission(self):
        self.create()
        checkpoint.write_json(self.target / 'admitted.json', {'revision': 'ccccccc'})
        (self.data / 'results/new-after-admission').write_text('must survive')
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_ADMITTED'):
            checkpoint.restore(self.state, self.target)
        self.assertTrue((self.data / 'results/new-after-admission').exists())

    def test_corrupt_copy_or_missing_private_database_blocks_restore(self):
        self.create()
        (self.target / 'data/team/users' / MEMBER / 'app.db').write_bytes(b'bad copy')
        with self.assertRaisesRegex(RuntimeError, 'CHECKSUM'):
            checkpoint.restore(self.state, self.target)
        self.assertEqual((self.data / 'results/private.bin').read_bytes(), b'private result')

    def test_missing_namespace_or_project_owner_refused(self):
        missing = self.team / 'users' / MEMBER / 'app.db'
        saved = missing.with_suffix('.saved')
        missing.rename(saved)
        with self.assertRaisesRegex(RuntimeError, 'DATABASE_MISSING'):
            self.create()
        saved.rename(missing)
        with sqlite3.connect(self.team / 'team.db') as db:
            db.execute("DELETE FROM team_project_members WHERE role='owner'")
        with self.assertRaisesRegex(RuntimeError, 'PROJECT_OWNER'):
            self.create()

    def test_binding_change_or_missing_access_table_blocks_admission(self):
        self.create()
        with sqlite3.connect(self.team / 'team.db') as db:
            db.execute("UPDATE team_gpt_profiles SET serviceToken='wrong-account'")
        with self.assertRaisesRegex(RuntimeError, 'PRIVACY_CHANGED'):
            checkpoint.admission(self.state, self.target)
        with sqlite3.connect(self.team / 'team.db') as db:
            db.execute('DROP TABLE team_receipts')
        with self.assertRaisesRegex(RuntimeError, 'TABLE_MISSING'):
            checkpoint.admission(self.state, self.target)

    def test_links_are_rejected_except_untouched_profile(self):
        (self.data / 'results/leak').symlink_to(self.state / 'config.json')
        with self.assertRaisesRegex(RuntimeError, 'CHECKPOINT_LINK'):
            self.create()
        (self.data / 'results/leak').unlink()
        self.config['hub']['databasePath'] = str(self.state / 'outside.db')
        with self.assertRaisesRegex(RuntimeError, 'STORAGE_OUTSIDE_DATA'):
            checkpoint.team_layout(self.state, self.config)

    def test_private_identity_and_restore_admission_flag_cannot_disappear(self):
        with sqlite3.connect(self.team / 'team.db') as db:
            db.execute("INSERT INTO team_meta VALUES('nativeAdmission','blocked')")
        self.create()
        with sqlite3.connect(self.data / 'app.db') as db:
            db.execute("UPDATE threads SET codexThreadId='another-native-thread'")
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_IDENTITY_CHANGED'):
            checkpoint.admission(self.state, self.target)
        with sqlite3.connect(self.team / 'team.db') as db:
            db.execute("DELETE FROM team_meta WHERE key='nativeAdmission'")
        with self.assertRaisesRegex(RuntimeError, 'PRIVACY_CHANGED'):
            checkpoint.admission(self.state, self.target)

    def test_wal_data_included_without_mutating_checkpoint(self):
        db = sqlite3.connect(self.team / 'users' / MEMBER / 'app.db')
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("INSERT INTO content VALUES('wal-thread','committed WAL')")
        db.commit()
        self.create()
        checkpoint.verify(self.target)
        checkpoint.verify(self.target)
        with checkpoint.database(self.target / 'data/team/users' / MEMBER / 'app.db') as saved:
            self.assertEqual(saved.execute("SELECT value FROM content WHERE id='wal-thread'").fetchone(), ('committed WAL',))

    def test_wal_removed_during_asset_copy_preserves_committed_data(self):
        path = self.team / 'team.db'
        db = sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("INSERT INTO team_audit VALUES(1,'committed before shutdown')")
        db.commit()
        original = checkpoint.copy_inventory
        def copy(source, target, entries):
            if source == self.data:
                self.assertTrue(Path(str(path) + '-wal').exists())
                db.close()  # Last connection checkpoints and removes the WAL.
                self.assertFalse(Path(str(path) + '-wal').exists())
            return original(source, target, entries)
        try:
            with patch.object(checkpoint, 'copy_inventory', copy):
                self.create()
        finally:
            db.close()
        checkpoint.verify(self.target)
        with sqlite3.connect(self.target / 'data/team/team.db') as saved:
            self.assertEqual(saved.execute('SELECT action FROM team_audit').fetchall(), [('committed before shutdown',)])
        self.assertFalse((self.target / 'data/team/team.db-wal').exists())


class UpgraderTest(unittest.TestCase):
    setUp = CheckpointTest.setUp

    def execute(self, failure=None, check=False, busy=False):
        spec = importlib.util.spec_from_file_location('upgrade', 'ops/linux/upgrade-engine.py')
        upgrade = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(upgrade)
        release = self.state / 'release'
        release.mkdir()
        proof = self.state / 'verification.json'
        proof.write_text(json.dumps(dict(revision='ccccccc', schema=28, **{k: True for k in ['build', 'typecheck', 'repositoryChecks', 'tests', 'browsers', 'imageSmoke', 'teamCheckpoint', 'teamRollback', 'teamUpgradeAdmission', 'codexContinuityPreflight']})))
        events = []
        failed = False
        if failure == 'backup':
            (self.data / 'results/unsafe').symlink_to(self.state / 'config.json')
        def run(args, **kwargs):
            nonlocal failed
            events.append(args)
            if 'dist/maintenance-check.js' in args:
                return subprocess.CompletedProcess(args, 20 if busy else 0)
            candidate = 'ENGINE_REVISION=ccccccc' in (self.state / 'deploy.env').read_text()
            if 'compose' in args and args[-1] == 'engine' and candidate:
                # Simulate a candidate migration before an engine startup failure.
                (self.data / 'results/candidate-file').write_text('new engine wrote this')
                if failure == 'identity':
                    with sqlite3.connect(self.team / 'team.db') as db:
                        db.execute("UPDATE team_users SET passwordHash='wrong'")
                if failure == 'engine' and not failed:
                    failed = True
                    raise subprocess.CalledProcessError(1, args)
            if 'dist/publish-web.js' in args:
                (self.state / 'web-releases/current.json').write_text('{"id":"candidate-assets"}')
            if 'dist/doctor.js' in args and failure == 'after_admission':
                (self.data / 'results/new-user-write').write_text('accepted by new engine')
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0)
        def inspect(name):
            revision = 'ccccccc' if name == 'codex-web-hub:ccccccc' else 'aaaaaaa'
            labels = {'org.opencontainers.image.revision': revision}
            if failure == 'web_only' and revision == 'ccccccc':
                labels['io.codex-web.release-kind'] = 'web-only'
            return {'Config': {'Labels': labels}}
        def output(args, **kwargs):
            return 'c' * 40 if 'rev-parse' in args else ''
        argv = ['upgrade-engine.py', 'ccccccc', '--expected', 'aaaaaaa', '--state', str(self.state), '--release', str(release), '--verification', str(proof)]
        if check:
            argv.append('--check')
        with patch.object(sys, 'argv', argv), patch.object(upgrade, 'inspect', inspect), patch.object(upgrade.subprocess, 'run', run), patch.object(upgrade.subprocess, 'check_output', output), patch.object(upgrade.Path, 'home', lambda: self.state):
            if failure:
                with self.assertRaises((subprocess.CalledProcessError, RuntimeError, AssertionError)):
                    upgrade.main()
            else:
                upgrade.main()
        return events

    def test_busy_check_never_stops_or_copies_storage(self):
        events = self.execute(check=True, busy=True)
        self.assertFalse(any('stop' in event or 'compose' in event for event in events))
        self.assertFalse((self.state / 'backups').exists())

    def test_success_checks_before_gateway_and_records_admission(self):
        events = self.execute()
        check = next(i for i, args in enumerate(events) if '--reserve-terminals' in args)
        stop = next(i for i, args in enumerate(events) if 'stop' in args)
        self.assertLess(check, stop)
        receipt = json.loads((self.state / 'deployment-ccccccc.json').read_text())
        saved = Path(receipt['checkpoint'])
        self.assertTrue((saved / 'admitted.json').exists())
        self.assertTrue((saved / 'verified.json').exists())
        self.assertEqual(json.loads((self.state / 'web-releases/maintenance.json').read_text())['state'], 'installed')

    def test_web_only_image_rejected_before_touching_running_services(self):
        events = self.execute(failure='web_only')
        self.assertFalse(events)
        self.assertFalse((self.state / 'backups').exists())

    def test_backup_failure_restarts_original_services_without_candidate(self):
        events = self.execute(failure='backup')
        self.assertFalse(any('compose' in args for args in events))
        self.assertIn(['docker', 'start', 'codex-web-engine'], events)
        self.assertIn(['docker', 'start', 'codex-web-hub'], events)
        self.assertIn('ENGINE_REVISION=aaaaaaa', (self.state / 'deploy.env').read_text())
        self.assertEqual(json.loads((self.state / 'web-releases/maintenance.json').read_text())['code'], 'BACKUP_FAILED')

    def test_failed_engine_restores_both_databases_and_exact_previous_pair(self):
        events = self.execute(failure='engine')
        self.assertEqual((self.state / 'deploy.env').read_text(), 'ENGINE_REVISION=aaaaaaa\nWEB_REVISION=bbbbbbb\n')
        self.assertEqual((self.state / 'web-releases/current.json').read_text(), '{"id":"old-assets"}')
        self.assertFalse((self.data / 'results/candidate-file').exists())
        self.assertTrue(any('compose' in args and args[-2:] == ['engine', 'hub'] for args in events))
        self.assertEqual(json.loads((self.state / 'web-releases/maintenance.json').read_text())['state'], 'rolled_back')

    def test_wrong_identity_never_reaches_public_gateway(self):
        events = self.execute(failure='identity')
        self.assertFalse(any('compose' in args and args[-1:] == ['hub'] and args[-2:] != ['engine', 'hub'] for args in events))
        with sqlite3.connect(self.team / 'team.db') as db:
            self.assertEqual(db.execute('SELECT DISTINCT passwordHash FROM team_users').fetchall(), [('same-password-hash',)])

    def test_failure_after_admission_retains_new_writes(self):
        events = self.execute(failure='after_admission')
        self.assertTrue((self.data / 'results/new-user-write').exists())
        self.assertIn('ENGINE_REVISION=ccccccc', (self.state / 'deploy.env').read_text())
        self.assertFalse(any('compose' in args and args[-2:] == ['engine', 'hub'] for args in events))
        saved = next((self.state / 'backups').glob('before-team-engine-*'))
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_ADMITTED'):
            checkpoint.restore(self.state, saved)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
