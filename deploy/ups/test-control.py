#!/usr/bin/env python3
"""Unprivileged installer contracts: real files/SQLite, fake accounts/systemd/HTTP."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
UNITS = ('factory-ups-control.service', 'factory-ups-selftest.service', 'factory-ups-selftest.timer')
STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, sqlite3, subprocess, sys
base = pathlib.Path(os.environ['FIXTURE'])
root = base / 'root'
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (base / 'calls').open('a') as out:
    out.write(name + ' ' + ' '.join(args) + '\n')
statefile = base / 'state'
state = json.loads(statefile.read_text())
if name == 'getent':
    if not (base / 'account').exists(): sys.exit(2)
    print('factory-ups-control:x:991:991::/var/lib/factory-ups-control:/usr/sbin/nologin')
elif name == 'useradd':
    (base / 'account').touch()
elif name == 'id':
    print('991')
elif name == 'timedatectl':
    print(os.environ.get('FIXTURE_TIMEZONE', 'America/New_York'))
elif name == 'chown':
    pass
elif name == 'runuser':
    assert args[:3] == ['-u', 'factory-ups-control', '--']
    sys.exit(subprocess.call(args[3:]))
elif name == 'curl':
    assert 'Tailscale-User-Login: operator@example.com' in args
    print(os.environ.get('HTTP_CODE', '403'), end='')
elif name == 'install':
    filtered = []
    while args:
        arg = args.pop(0)
        if arg in ('-o', '-g'): args.pop(0)
        else: filtered.append(arg)
    sys.exit(subprocess.call(['/usr/bin/install', *filtered]))
elif name == 'systemctl':
    op = args.pop(0)
    if op == 'show':
        if 'DropInPaths' in args: print('')
        else: print('loaded' if (root / 'etc/systemd/system' / args[0]).exists() else 'not-found')
    elif op in ('is-enabled', 'is-active'):
        if '--quiet' in args:
            sys.exit(0 if state.get(args[-1], ['', ''])[1] == 'active' else 3)
        print(state.get(args[0], ['not-found', 'unknown'])[op == 'is-active'])
    elif op == 'daemon-reload':
        for unit in list(state):
            if not (root / 'etc/systemd/system' / unit).exists(): del state[unit]
    elif op in ('enable', 'disable', 'start', 'stop'):
        now = '--now' in args
        for unit in [a for a in args if a != '--now']:
            entry = state.setdefault(unit, ['disabled', 'inactive'])
            if op in ('enable', 'disable'): entry[0] = 'enabled' if op == 'enable' else 'disabled'
            if op in ('start', 'stop') or now: entry[1] = 'active' if op in ('start', 'enable') else 'inactive'
            if unit == 'factory-ups-selftest.service' and op == 'start': raise AssertionError('Installer ran scheduled test!')
            if unit == 'factory-ups-control.service' and (op == 'start' or op == 'enable' and now):
                db = root / 'var/lib/factory-ups-control/audit.db'
                if db.exists() and op == 'enable':
                    assert list((root / 'var/backups').glob('ups-control.*/audit.db')), 'Startup before backup'
                elif not db.exists():
                    with sqlite3.connect(db) as conn: conn.execute('CREATE TABLE events(id INTEGER)')
    else: raise AssertionError(op)
    if op not in ('show', 'is-enabled', 'is-active'): statefile.write_text(json.dumps(state))
else: raise AssertionError(name)
'''


def tree(path):
    return {str(p.relative_to(path)): (p.read_bytes(), p.stat().st_mode & 0o777, p.stat().st_mtime_ns)
            for p in path.rglob('*') if p.is_file()}


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.geteuid(), 0)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'root'
        self.root.mkdir()
        (self.base / 'state').write_text('{}')
        bin = self.base / 'bin'
        bin.mkdir()
        for name in ('systemctl', 'timedatectl', 'getent', 'useradd', 'install', 'curl', 'runuser', 'id', 'chown'):
            path = bin / name
            path.write_text(STUB)
            path.chmod(0o755)
        self.env = dict(os.environ, FIXTURE=str(self.base), UPS_CONTROL_TEST_ROOT=str(self.root),
                        BACKUP_TEST_ROOT=str(self.root), PATH=f'{bin}:/usr/bin:/bin')
        self.binary = self.base / 'prebuilt'
        self.binary.write_text('#!/bin/sh\nexit 99 # installer must not execute the binary\n')
        self.binary.chmod(0o755)
        for path in ('etc/nut/factory-control.password', 'etc/factory-alerts/slack-token'):
            file = self.root / path
            file.parent.mkdir(parents=True)
            file.write_text('secret-fixture-' + file.name + '\n')
            file.chmod(0o600)

    def run_script(self, script='install-ups-control.sh', args=None, success=True):
        if args is None: args = [str(self.binary), '0', 'operator@example.com']
        result = subprocess.run(['bash', str(HERE / script), *args], env=self.env,
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertNotIn('secret-fixture', result.stdout + result.stderr)
        return result.stdout + result.stderr

    def snapshots(self):
        return sorted((self.root / 'var/backups').glob('ups-control.*'))

    def test_fresh_dry_rerun_and_rollback_retains_db(self):
        before = tree(self.root)
        for flag in ('--dry-run', '--preflight'):
            output = self.run_script(args=[str(self.binary), '0', 'operator@example.com', flag])
            self.assertIn('<masked>', output)
            self.assertEqual(before, tree(self.root))
        self.run_script()
        first = self.snapshots()[0]
        db = self.root / 'var/lib/factory-ups-control/audit.db'
        with sqlite3.connect(db) as conn:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA wal_autocheckpoint=0')
            conn.execute('INSERT INTO events VALUES (42)')
            conn.commit()
            self.assertTrue(Path(str(db) + '-wal').exists())
            self.run_script()
        with sqlite3.connect(db) as conn: self.assertEqual(conn.execute('SELECT * FROM events').fetchall(), [(42,)])
        snapshots = [p for p in self.snapshots() if p != first]
        with sqlite3.connect(snapshots[0] / 'audit.db') as conn:
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(conn.execute('SELECT * FROM events').fetchall(), [(42,)])
        db_before = db.read_bytes()
        output = self.run_script('rollback-ups-control.sh', [str(first)])
        self.assertIn('--set-path /control off', output)
        self.assertEqual(db.read_bytes(), db_before)
        self.assertFalse((self.root / 'usr/local/bin/factory-ups-control').exists())
        self.assertEqual(json.loads((self.base / 'state').read_text()), {})
        calls = (self.base / 'calls').read_text()
        self.assertNotIn('tailscale ', calls)
        self.assertNotIn('start factory-ups-selftest.service', calls)
        service = (HERE / 'factory-ups-control.service.in').read_text()
        self.assertNotIn('PrivateNetwork', service)
        self.assertNotIn('PrivateUsers', service)
        self.assertIn('127.0.0.1:8090', service)
        self.assertIn('ExecStartPre=/usr/local/bin/factory-ups-control --db-path /var/lib/factory-ups-control/audit.db migrate', service)
        self.assertNotIn('migrate', (HERE / 'factory-ups-selftest.service').read_text())

    def test_exact_prior_files_and_mixed_states(self):
        for name in UNITS:
            path = self.root / 'etc/systemd/system' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('prior ' + name)
            path.chmod(0o640)
        binary = self.root / 'usr/local/bin/factory-ups-control'
        binary.parent.mkdir(parents=True)
        binary.write_text('prior binary')
        prior = tree(self.root)
        state = {UNITS[0]: ['disabled', 'active'], UNITS[1]: ['static', 'inactive'], UNITS[2]: ['enabled', 'inactive']}
        (self.base / 'state').write_text(json.dumps(state))
        self.run_script()
        snapshot = self.snapshots()[0]
        self.run_script('rollback-ups-control.sh', [str(snapshot)])
        for path, value in prior.items(): self.assertEqual(tree(self.root)[path], value)
        self.assertEqual(json.loads((self.base / 'state').read_text()), state)

    def test_bad_db_blocks_startup_and_bad_http_blocks_timer(self):
        db = self.root / 'var/lib/factory-ups-control/audit.db'
        db.parent.mkdir(parents=True)
        db.write_bytes(b'not sqlite')
        self.run_script(success=False)
        self.assertNotIn('enable --now', (self.base / 'calls').read_text())
        db.unlink()
        self.env['HTTP_CODE'] = '200'
        output = self.run_script(success=False)
        self.assertIn('not rejected', output)
        self.assertNotIn('enable --now factory-ups-selftest.timer', (self.base / 'calls').read_text())

    def test_unsafe_inputs_fail_read_only(self):
        before = tree(self.root)
        self.env['FIXTURE_TIMEZONE'] = 'UTC'
        self.run_script(success=False)
        self.assertEqual(before, tree(self.root))
        self.env.pop('FIXTURE_TIMEZONE')
        self.run_script(args=[str(self.binary), '000991', 'operator@example.com', '--dry-run'], success=False)
        credential = self.root / 'etc/nut/factory-control.password'
        credential.chmod(0o644)
        self.run_script(success=False)
        credential.chmod(0o600)
        credential.unlink()
        credential.symlink_to(self.binary)
        self.run_script(success=False)
        credential.unlink()
        credential.write_bytes(before['etc/nut/factory-control.password'][0])
        self.assertFalse((self.root / 'var/backups').exists())
        self.assertFalse((self.base / 'account').exists())

    def test_backup_config_rollback_preserves_data_and_symlink(self):
        script = '../backup/rollback-backup-config.sh'
        config = self.root / 'etc/factory-backup/nodes.conf'
        config.parent.mkdir(parents=True)
        config.write_text('old config')
        link = self.root / 'usr/local/lib/factory-backup/nodes.conf'
        link.parent.mkdir(parents=True)
        link.symlink_to('/etc/factory-backup/nodes.conf')
        data = self.root / 'var/lib/factory-ups-control/audit.db'
        data.parent.mkdir(parents=True)
        data.write_bytes(b'audit data must survive')
        for unit in ('factory-backup.service', 'factory-backup.timer'):
            file = self.root / 'etc/systemd/system' / unit
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('prior ' + unit)
        state = {'factory-backup.service': ['disabled', 'active'], 'factory-backup.timer': ['enabled', 'inactive']}
        (self.base / 'state').write_text(json.dumps(state))
        self.run_script(script, ['--snapshot'])
        snapshot = next((self.root / 'var/backups').glob('backup-config.*'))
        config.write_text('new config')
        link.unlink()
        link.write_text('new file')
        self.run_script(script, [str(snapshot)])
        self.assertEqual(config.read_text(), 'old config')
        self.assertEqual(os.readlink(link), '/etc/factory-backup/nodes.conf')
        self.assertEqual(data.read_bytes(), b'audit data must survive')
        self.assertEqual(json.loads((self.base / 'state').read_text()), state)


if __name__ == '__main__':
    unittest.main()
