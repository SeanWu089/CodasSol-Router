"""Exercise release guards using temporary paths and mocked service operations."""
import importlib.util
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


if __name__ == '__main__':
    unittest.main()
