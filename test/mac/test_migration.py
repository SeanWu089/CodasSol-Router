"""Non-disruptive migration worker checks using mocks (never signals live PIDs)."""
import importlib.util
import json
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch, call
import subprocess

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/mac/menu-app/migrate-devspace.py"
SPEC = importlib.util.spec_from_file_location("migration", SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class MigrationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "status.json"
        self.state.write_text(json.dumps({"phase": "prepared", "expected_pid": 123456}))
        self.state_patch = patch.object(m, "STATE", self.state)
        self.base_patch = patch.object(m, "BASE", Path(self.tmp.name))
        self.state_patch.start()
        self.base_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.addCleanup(self.base_patch.stop)

    def test_migration_success_only_stops_exact_listener_and_verifies_health(self):
        listeners = [[123456], [], []]
        with patch.object(m, "healthy", return_value=True), \
             patch.object(m, "listeners", side_effect=listeners), \
             patch.object(m, "loaded", return_value=False), \
             patch.object(m.os, "kill") as kill, \
             patch.object(m, "launchctl", return_value=subprocess.CompletedProcess([], 0, "", "")) as ctl, \
             patch.object(m, "wait_healthy", return_value=True):
            m.migrate()
        kill.assert_called_once_with(123456, signal.SIGTERM)
        ctl.assert_called_once_with("bootstrap", m.DOMAIN, str(m.MANAGED_PLIST))
        self.assertEqual(json.loads(self.state.read_text())["phase"], "success")

    def test_fails_closed_if_listener_changed_before_cutover(self):
        with patch.object(m, "healthy", return_value=True), \
             patch.object(m, "listeners", return_value=[999999]), \
             patch.object(m, "loaded", return_value=False), \
             patch.object(m.os, "kill") as kill:
            m.migrate()
        kill.assert_not_called()
        self.assertEqual(json.loads(self.state.read_text())["phase"], "aborted")

    def test_bootstrap_failure_calls_rollback(self):
        with patch.object(m, "healthy", return_value=True), \
             patch.object(m, "listeners", side_effect=[[123456], [], []]), \
             patch.object(m, "loaded", return_value=False), \
             patch.object(m.os, "kill"), \
             patch.object(m, "launchctl", return_value=subprocess.CompletedProcess([], 5, "", "denied")), \
             patch.object(m, "recover") as recover:
            m.migrate()
        recover.assert_called_once()
        self.assertIn("bootstrap failed", recover.call_args.args[0])

    def test_no_cutover_from_missing_preflight(self):
        self.state.write_text(json.dumps({"phase": "aborted", "expected_pid": 123456}))
        with patch.object(m.os, "kill") as kill:
            m.migrate()
        kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
