"""Exercise release guards using temporary paths and mocked service operations."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    'promote', Path(__file__).with_name('promote-stable.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'production'
        self.releases = self.root / 'releases'
        self.releases.mkdir(parents=True)
        self.current = self.root / 'current'
        for name in ['old', 'new']:
            (self.releases / name / 'src').mkdir(parents=True)
            (self.releases / name / 'src/server.js').write_text('// fixture\n')
        self.current.symlink_to('releases/old')
        self.source = Path(self.temp.name) / 'checkout'
        for name in ['src', 'test', 'scripts']:
            (self.source / name).mkdir(parents=True)
        (self.source / 'src/server.js').write_text('// fixture\n')
        (self.source / 'package.json').write_text('{}\n')
        values = dict(ROOT=self.root, RELEASES=self.releases,
                      CURRENT=self.current, LOGS=self.root / 'logs',
                      NODE=Path(sys.executable), PUBLIC='https://configured.invalid/health')
        self.patcher = mock.patch.multiple(p, **values)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_invalid_public_endpoint_blocks_before_commands(self):
        for endpoint in ['', 'http://configured.invalid/health',
                         'https://router.example.com/health',
                         'https://user:secret@configured.invalid/health',
                         'https://configured.invalid/health#fragment']:
            with self.subTest(endpoint=endpoint), mock.patch.object(p, 'PUBLIC', endpoint), \
                    mock.patch.object(p, 'cmd_run') as command:
                with self.assertRaisesRegex(RuntimeError, 'CODASSOL_PUBLIC_HEALTH_URL'):
                    p.promote(self.source)
                command.assert_not_called()
                self.assertEqual(os.readlink(self.current), 'releases/old')

    def test_dry_run_never_activates_or_restarts(self):
        completed = subprocess.CompletedProcess([], 0, stdout='', stderr='')
        with mock.patch.object(p, 'PUBLIC', ''), \
                mock.patch.object(p, 'cmd_run', return_value=completed), \
                mock.patch.object(p, 'atomic_link') as link, \
                mock.patch.object(p, 'restart_router') as restart, \
                mock.patch.object(p.subprocess, 'Popen') as worker:
            self.assertEqual(p.promote(self.source, dry_run=True), 0)
            link.assert_not_called()
            restart.assert_not_called()
            worker.assert_not_called()
        self.assertEqual(os.readlink(self.current), 'releases/old')
        self.assertEqual(list(self.releases.glob('.staging-*')), [])

    def test_syntax_failure_cleans_staging_and_preserves_release(self):
        scan = subprocess.CompletedProcess([], 0, stdout='', stderr='')
        bad_syntax = subprocess.CompletedProcess([], 1)
        with mock.patch.object(p, 'cmd_run', side_effect=[scan, bad_syntax]), \
                mock.patch.object(p, 'restart_router') as restart:
            with self.assertRaisesRegex(RuntimeError, 'syntax check failed'):
                p.promote(self.source, dry_run=True)
            restart.assert_not_called()
        self.assertEqual(os.readlink(self.current), 'releases/old')
        self.assertEqual(list(self.releases.glob('.staging-*')), [])

    def test_failed_health_rolls_back_to_original_release(self):
        with mock.patch.object(p, 'restart_router', return_value=True) as restart, \
                mock.patch.object(p, 'healthy', side_effect=[False, True]):
            self.assertEqual(p.activate('new'), 2)
        self.assertEqual(restart.call_count, 2)
        self.assertEqual(os.readlink(self.current), 'releases/old')

    def test_success_keeps_verified_release(self):
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', return_value=True):
            self.assertEqual(p.activate('new'), 0)
        self.assertEqual(os.readlink(self.current), 'releases/new')

    def test_unknown_release_preserves_current_link(self):
        with self.assertRaisesRegex(RuntimeError, 'Invalid release'):
            p.activate('missing')
        self.assertEqual(os.readlink(self.current), 'releases/old')

    def test_second_activation_is_rejected_while_lock_is_held(self):
        with (self.root / '.promotion.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(p, 'restart_router') as restart, \
                    mock.patch.object(p, 'healthy', return_value=True):
                with self.assertRaisesRegex(RuntimeError, 'in progress'):
                    p.activate('new')
                restart.assert_not_called()
        self.assertEqual(os.readlink(self.current), 'releases/old')

    def test_source_symlinks_are_rejected_before_commands(self):
        for target in ['external.js', 'missing.js']:
            outside = Path(self.temp.name) / target
            if target == 'external.js':
                outside.write_text('// outside checkout\n')
            link = self.source / 'src/linked.js'
            link.symlink_to(outside)
            with self.subTest(target=target), mock.patch.object(p, 'cmd_run') as command:
                with self.assertRaisesRegex(RuntimeError, 'symlink'):
                    p.promote(self.source, dry_run=True)
                command.assert_not_called()
            link.unlink()

    def test_top_level_source_symlink_is_rejected(self):
        (self.source / 'package.json').unlink()
        (self.source / 'package.json').symlink_to(self.releases / 'old/src/server.js')
        with mock.patch.object(p, 'cmd_run') as command:
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                p.promote(self.source, dry_run=True)
            command.assert_not_called()

    def test_killed_worker_leaves_recoverable_journal(self):
        child_code = '''
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('release_worker', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.ROOT = Path(sys.argv[2])
m.RELEASES = m.ROOT / 'releases'
m.CURRENT = m.ROOT / 'current'
m.PUBLIC = 'https://configured.invalid/health'
m.restart_router = lambda: os._exit(91)
m.activate('new')
'''
        child = subprocess.run(
            [sys.executable, '-B', '-c', child_code, str(Path(p.__file__).resolve()), str(self.root)],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(child.returncode, 91, child.stderr)
        self.assertEqual(os.readlink(self.current), 'releases/new')
        self.assertTrue((self.root / 'activation.json').is_file())
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', return_value=True):
            self.assertEqual(p.recover_pending(), 0)
        self.assertEqual(os.readlink(self.current), 'releases/old')
        self.assertFalse((self.root / 'activation.json').exists())

    def test_failed_rollback_keeps_journal_until_recovery(self):
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', return_value=False):
            self.assertEqual(p.activate('new'), 2)
        self.assertTrue((self.root / 'activation.json').is_file())
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'recovery'):
                p.activate('new')
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', return_value=True):
            self.assertEqual(p.recover_pending(), 0)
        self.assertFalse((self.root / 'activation.json').exists())

    def test_foreign_link_is_not_overwritten_after_health_check(self):
        other = self.releases / 'other/src'
        other.mkdir(parents=True)
        (other / 'server.js').write_text('// another release\n')
        def changed_link(**kwargs):
            self.current.unlink()
            self.current.symlink_to('releases/other')
            return True
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', side_effect=changed_link):
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                p.activate('new')
        self.assertEqual(os.readlink(self.current), 'releases/other')
        self.assertTrue((self.root / 'activation.json').is_file())

    def test_keyboard_interrupt_rolls_back(self):
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', side_effect=[KeyboardInterrupt(), True]):
            self.assertEqual(p.activate('new'), 2)
        self.assertEqual(os.readlink(self.current), 'releases/old')
        self.assertFalse((self.root / 'activation.json').exists())

    def test_recovery_handles_each_durable_switch_phase(self):
        for phase, current, expected, restarts in [
                ('prepared', 'old', 'old', 1),
                ('prepared', 'new', 'old', 1),
                ('verified', 'new', 'new', 0)]:
            with self.subTest(phase=phase, current=current):
                self.current.unlink()
                self.current.symlink_to('releases/' + current)
                (self.root / 'activation.json').write_text(json.dumps({
                    'version': 1, 'phase': phase,
                    'previous': 'releases/old', 'candidate': 'releases/new'}))
                with mock.patch.object(p, 'restart_router', return_value=True) as restart, \
                        mock.patch.object(p, 'healthy', return_value=True):
                    self.assertEqual(p.recover_pending(), 0)
                self.assertEqual(restart.call_count, restarts)
                self.assertEqual(os.readlink(self.current), 'releases/' + expected)
                self.assertFalse((self.root / 'activation.json').exists())

    def test_invalid_journal_never_changes_current(self):
        for contents in ['not json', 'null', json.dumps({
                'version': 1, 'phase': 'prepared',
                'previous': '../outside', 'candidate': 'releases/new'})]:
            (self.root / 'activation.json').write_text(contents)
            with self.subTest(contents=contents), mock.patch.object(p, 'restart_router') as restart:
                with self.assertRaisesRegex(RuntimeError, 'Invalid'):
                    p.recover_pending()
                restart.assert_not_called()
                self.assertEqual(os.readlink(self.current), 'releases/old')
                self.assertEqual((self.root / 'activation.json').read_text(), contents)

    def test_release_directory_symlink_is_rejected(self):
        (self.releases / 'linked').symlink_to(self.releases / 'new', target_is_directory=True)
        with mock.patch.object(p, 'restart_router') as restart:
            with self.assertRaisesRegex(RuntimeError, 'Invalid release'):
                p.activate('linked')
            restart.assert_not_called()

    def test_recovery_restores_previous_when_candidate_is_missing(self):
        p.shutil.rmtree(self.releases / 'new')
        for phase in ['prepared', 'verified']:
            self.current.unlink()
            self.current.symlink_to('releases/new')
            (self.root / 'activation.json').write_text(json.dumps({
                'version': 1, 'phase': phase,
                'previous': 'releases/old', 'candidate': 'releases/new'}))
            with self.subTest(phase=phase), \
                    mock.patch.object(p, 'restart_router', return_value=True), \
                    mock.patch.object(p, 'healthy', return_value=True):
                self.assertEqual(p.recover_pending(), 0)
            self.assertEqual(os.readlink(self.current), 'releases/old')
            self.assertFalse((self.root / 'activation.json').exists())

    def test_link_introduced_during_copy_is_rejected_before_execution(self):
        external = Path(self.temp.name) / 'external.json'
        external.write_text('{}')
        original_copy = p.shutil.copy2
        def injected_copy(src, dst, **kwargs):
            if Path(src) == self.source.resolve() / 'package.json':
                Path(src).unlink()
                Path(src).symlink_to(external)
            return original_copy(src, dst, **kwargs)
        scan = subprocess.CompletedProcess([], 0, stdout='', stderr='')
        with mock.patch.object(p.shutil, 'copy2', side_effect=injected_copy), \
                mock.patch.object(p, 'cmd_run', return_value=scan) as command:
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                p.promote(self.source, dry_run=True)
        self.assertEqual(command.call_count, 1)  # cloud-file scan only; no candidate execution
        self.assertEqual(list(self.releases.glob('.staging-*')), [])

    def test_process_lock_is_released_when_holder_exits(self):
        child_code = '''
import fcntl, sys, time
with open(sys.argv[1], 'a+b') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print('ready', flush=True)
    time.sleep(30)
'''
        child = subprocess.Popen(
            [sys.executable, '-B', '-c', child_code, str(self.root / '.promotion.lock')],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with self.assertRaisesRegex(RuntimeError, 'in progress'):
                p.activate('new')
        finally:
            child.terminate()
            child.communicate(timeout=5)
        self.assertTrue((self.root / '.promotion.lock').is_file())
        with mock.patch.object(p, 'restart_router', return_value=True), \
                mock.patch.object(p, 'healthy', return_value=True):
            self.assertEqual(p.activate('new'), 0)


if __name__ == '__main__':
    unittest.main()
