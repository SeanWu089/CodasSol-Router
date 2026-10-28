#!/usr/bin/python3
"""Supervise only our cloudflared child; credentials never enter argv/logs."""
import signal
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

READY = 'http://127.0.0.1:20245/ready'
def build_command():
    binary = (os.environ.get('CODASSOL_CLOUDFLARED_BIN')
              or shutil.which('cloudflared') or '/opt/homebrew/bin/cloudflared')
    token_file = Path(os.environ.get(
        'CODASSOL_CLOUDFLARE_TOKEN_FILE',
        str(Path.home() / '.codassol' / 'cloudflare-codas.token'))).expanduser()
    command = [binary, 'tunnel', '--no-autoupdate', '--edge-ip-version', '4',
               '--metrics', '127.0.0.1:20245', 'run']
    resolver = os.environ.get('CODASSOL_TUNNEL_DNS_RESOLVER', '').strip()
    if resolver:
        command.extend(['--dns-resolver-addrs', resolver])
    command.extend(['--token-file', str(token_file)])
    return command

COMMAND = build_command()

class HealthWindow:
    def __init__(self, started):
        self.started = started
        self.failures = 0
    def restart(self, now, healthy):
        self.failures = 0 if healthy else self.failures + 1
        return now - self.started >= 180 and self.failures >= 6

def healthy():
    try:
        # Ignore shell/system HTTP proxies for a strictly loopback health check.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(READY, timeout=3) as response:
            return response.status == 200
    except Exception:
        return False

def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()

def main():
    stopping = False
    def shutdown(signum, frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    delay = 10
    while not stopping:
        started = time.monotonic()
        child = subprocess.Popen(COMMAND)
        window = HealthWindow(started)
        try:
            while not stopping and child.poll() is None:
                if window.restart(time.monotonic(), healthy()):
                    print('Tunnel unavailable after grace and consecutive checks; restarting owned child.', flush=True)
                    break
                for _ in range(10):
                    if stopping or child.poll() is not None:
                        break
                    time.sleep(1)
        finally:
            stop(child)
        if stopping:
            break
        lived = time.monotonic() - started
        delay = 10 if lived >= 600 else min(delay * 2, 120)
        print('Tunnel retry in %s seconds.' % delay, flush=True)
        for _ in range(delay):
            if stopping:
                break
            time.sleep(1)

if __name__ == '__main__':
    main()
