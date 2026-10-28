import importlib.util
import subprocess
import unittest
from unittest import mock
from pathlib import Path
spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).with_name('cloudflare-supervisor.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
class Tests(unittest.TestCase):
    def test_grace(self):
        w=s.HealthWindow(0)
        for now in range(0,180,10):
            self.assertFalse(w.restart(now,False))
        self.assertTrue(w.restart(180,False))
    def test_transient_and_recovery_reset(self):
        w=s.HealthWindow(0)
        for now in range(200,250,10):
            self.assertFalse(w.restart(now,False))
        self.assertFalse(w.restart(250,True))
        self.assertFalse(w.restart(260,False))
        self.assertEqual(w.failures,1)
    def test_stalled_after_healthy(self):
        w=s.HealthWindow(0)
        self.assertFalse(w.restart(200,True))
        for now in range(210,260,10):
            self.assertFalse(w.restart(now,False))
        self.assertTrue(w.restart(260,False))
    def test_terminate_owned_process(self):
        child=subprocess.Popen(['/bin/sleep','60'])
        s.stop(child)
        self.assertIsNotNone(child.poll())
        s.stop(child)
    def test_loopback_and_no_token_in_command(self):
        self.assertIn('127.0.0.1:20245',s.COMMAND)
        self.assertIn('--token-file',s.COMMAND)
        self.assertNotIn('--token',s.COMMAND)
    def test_private_configuration_is_supplied_locally(self):
        with mock.patch.dict(s.os.environ, {
                'CODASSOL_CLOUDFLARED_BIN': '/opt/test/cloudflared',
                'CODASSOL_CLOUDFLARE_TOKEN_FILE': '/tmp/test-credential-file',
                'CODASSOL_TUNNEL_DNS_RESOLVER': '127.0.0.1:5353'}, clear=True):
            command=s.build_command()
        self.assertEqual(command[0], '/opt/test/cloudflared')
        self.assertEqual(command[-2:], ['--token-file', '/tmp/test-credential-file'])
        self.assertIn('127.0.0.1:5353', command)
        self.assertNotIn('--token', command)
    def test_system_dns_is_default(self):
        with mock.patch.dict(s.os.environ, {}, clear=True):
            command=s.build_command()
        self.assertNotIn('--dns-resolver-addrs', command)

if __name__ == '__main__':
    unittest.main()
