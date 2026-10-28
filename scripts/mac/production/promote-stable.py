#!/usr/bin/env python3
"""Promote a tested Desktop checkout into isolated, versioned CodasSol production.

Production Router/DevSpace/tunnel never execute directly from the Desktop.
The only production-mutating actions are atomic current-link switching and
a Router LaunchAgent restart, done by a detached worker with rollback.
"""
import datetime as dt
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit
import uuid

ROOT = Path.home() / "Library" / "Application Support" / "CodasSol" / "production"
RELEASES = ROOT / "releases"
CURRENT = ROOT / "current"
LOGS = ROOT / "logs"
NODE = Path(os.environ.get("CODASSOL_NODE") or shutil.which("node") or "node").expanduser().resolve()
LABEL = "com.codassol.router"
SOURCE_DEFAULT = Path(os.environ.get("CODASSOL_SOURCE_DIR", str(Path.cwd())))
PUBLIC = os.environ.get("CODASSOL_PUBLIC_HEALTH_URL", "")

def log(line):
    print(line, flush=True)

def cmd_run(command, **kw):
    return subprocess.run([str(v) for v in command], **kw)

def sync_root():
    fd = os.open(ROOT, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

@contextmanager
def activation_lock():
    # Keep the inode: unlinking a lock file can let two workers lock different files.
    with (ROOT / '.promotion.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError('Another activation or recovery is in progress') from exc
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)

def reject_symlinks(paths, excluded=()):
    excluded = set(excluded)
    for path in paths:
        path = Path(path)
        entries = [path]
        if path.is_dir() and not path.is_symlink():
            entries.extend(path.rglob('*'))
        for entry in entries:
            if entry not in excluded and entry.is_symlink():
                raise RuntimeError('Release input contains a symlink: ' + str(entry))

def release_target_path(target):
    if not isinstance(target, str) or not target:
        raise RuntimeError('Invalid release target')
    path = Path(target)
    expected = str(RELEASES / path.name) if path.is_absolute() else 'releases/' + path.name
    if target != expected or path.name in ('', '.', '..'):
        raise RuntimeError('Invalid release target')
    release = path if path.is_absolute() else ROOT / path
    if RELEASES.is_symlink():
        raise RuntimeError('Invalid releases directory symlink')
    return release

def checked_release_target(target):
    release = release_target_path(target)
    if release.is_symlink() or not (release / 'src/server.js').is_file():
        raise RuntimeError('Invalid release directory')
    reject_symlinks([release])
    return release

def check_current(expected):
    if not CURRENT.is_symlink() or os.readlink(CURRENT) != expected:
        raise RuntimeError('Current link changed outside this activation; refusing to overwrite it')

def write_journal(record):
    temporary = ROOT / ('.activation-' + uuid.uuid4().hex)
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            json.dump(record, output)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, ROOT / 'activation.json')
        sync_root()
    finally:
        if temporary.exists():
            temporary.unlink()

def read_journal():
    path = ROOT / 'activation.json'
    if path.is_symlink():
        raise RuntimeError('Invalid activation journal symlink')
    if not path.exists():
        return None
    try:
        record = json.loads(path.read_text())
        if record.get('version') != 1 or record.get('phase') not in ('prepared', 'verified'):
            raise ValueError('Invalid journal schema')
        # A damaged/missing candidate must not prevent rollback to an intact previous release.
        release_target_path(record['previous'])
        release_target_path(record['candidate'])
        return record
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise RuntimeError('Invalid activation journal; preserve it for review') from exc

def clear_journal():
    (ROOT / 'activation.json').unlink()
    sync_root()

def atomic_link(target):
    temp = ROOT / (".current-" + uuid.uuid4().hex)
    os.symlink(str(target), temp)
    os.replace(temp, CURRENT)
    sync_root()

def good_health(url, timeout=3):
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "CodasSol-DeploymentHealth/1.0"})
        with urllib.request.urlopen(request, timeout=timeout) as r:
            data = json.loads(r.read(4096))
            return r.status == 200 and data.get("ok") is True and data.get("backendReachable") is True
    except Exception:
        return False

def pid_from_prod(expected=None):
    result = cmd_run(["/bin/ps", "-axo", "command="], capture_output=True, text=True, timeout=5)
    target = ROOT / expected if expected is not None else CURRENT
    return str((target / "src/server.js").resolve()) in result.stdout

def healthy(wait_secs=25, expected=None):
    deadline = time.monotonic() + wait_secs
    while time.monotonic() < deadline:
        if expected is not None:
            check_current(expected)
        if pid_from_prod(expected) and good_health("http://127.0.0.1:17676/_codassol/health") and good_health(PUBLIC):
            return True
        time.sleep(1)
    return False

def restart_router():
    res = cmd_run(["/bin/launchctl","kickstart","-k",f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True, timeout=15)
    log("Router restart exit=" + str(res.returncode) + " " + res.stderr.strip())
    return res.returncode == 0

def rollback_locked(record):
    checked_release_target(record['previous'])
    if not CURRENT.is_symlink() or os.readlink(CURRENT) not in (record['candidate'], record['previous']):
        raise RuntimeError('Current link changed outside this activation; refusing rollback')
    if os.readlink(CURRENT) != record['previous']:
        atomic_link(record['previous'])
    # A killed worker may have restored the link but not yet restarted the service.
    recovered = restart_router() and healthy(expected=record['previous'])
    if recovered:
        check_current(record['previous'])
        clear_journal()
    log('ROLLBACK_RECOVERED: ' + str(recovered))
    return recovered

def recover_locked():
    record = read_journal()
    if record is None:
        return True
    if record['phase'] == 'verified' and CURRENT.is_symlink() and os.readlink(CURRENT) == record['candidate']:
        try:
            checked_release_target(record['candidate'])
            candidate_healthy = healthy(expected=record['candidate'])
        except (RuntimeError, OSError):
            candidate_healthy = False
        if candidate_healthy:
            check_current(record['candidate'])
            clear_journal()
            return True
    return rollback_locked(record)

def recover_pending():
    with activation_lock():
        return 0 if recover_locked() else 2

def activate(release_id):
    if Path(release_id).name != release_id:
        raise RuntimeError('Invalid release directory')
    candidate = 'releases/' + release_id
    checked_release_target(candidate)
    with activation_lock():
        if not recover_locked():
            raise RuntimeError('Pending activation recovery failed; refusing a new activation')
        previous = os.readlink(CURRENT)
        checked_release_target(previous)
        record = {'version': 1, 'previous': previous, 'candidate': candidate, 'phase': 'prepared'}
        log('Previous version: ' + previous)
        try:
            # The durable journal precedes the switch, including its directory entry.
            write_journal(record)
            check_current(previous)
            atomic_link(candidate)
            if not restart_router() or not healthy(expected=candidate):
                raise RuntimeError('New release failed live and public health verification')
            check_current(candidate)
            record['phase'] = 'verified'
            write_journal(record)
            clear_journal()
            log('PROMOTED: ' + release_id)
            return 0
        except (Exception, KeyboardInterrupt) as exc:
            log('FAILED, rolling back: ' + str(exc))
            if (ROOT / 'activation.json').exists():
                rollback_locked(record)
            return 2

def promote(source, dry_run=False):
    source = Path(source).expanduser().resolve()
    if not dry_run:
        endpoint = urlsplit(PUBLIC)
        if (endpoint.scheme != "https" or not endpoint.hostname
                or endpoint.username or endpoint.password or endpoint.fragment
                or endpoint.hostname == "example.com"
                or endpoint.hostname.endswith(".example.com")):
            raise RuntimeError("Set CODASSOL_PUBLIC_HEALTH_URL to your HTTPS health endpoint before promotion")
    if not NODE.is_file() or not (source / "src/server.js").is_file():
        raise RuntimeError("Missing Node binary or source Router")
    if source == ROOT or ROOT in source.parents:
        raise RuntimeError("Production cannot be its own deployment source")
    required = ["src","test","scripts","package.json"]
    if any(not (source / item).exists() for item in required):
        raise RuntimeError("Source missing src/test/scripts/package.json")
    RELEASES.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    tocopy = required + [x for x in ["README.md","CHANGELOG.md","SECURITY.md"] if (source / x).exists()]
    # Router bundles do not ship the native macOS menu-bar image. It is
    # packaged separately in the GUI .app and may be an iCloud placeholder.
    menu_image = source / "scripts/mac/menu-app/SeanTemplate.png"
    reject_symlinks([source / name for name in tocopy], excluded=[menu_image])
    scan = cmd_run(["/usr/bin/find", *[str(source / p) for p in tocopy],
                    "-type","f","!", "-path",str(menu_image),
                    "-flags","+dataless","-print"], capture_output=True, text=True)
    if scan.returncode != 0 or scan.stdout.strip():
        raise RuntimeError("Unhydrated cloud placeholder files or scan failure: " + scan.stdout[:1200] + scan.stderr[:400])
    label = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    staging = RELEASES / (".staging-" + label)
    final = RELEASES / ("stable-" + label)
    staging.mkdir()
    try:
        for item in tocopy:
            src, dst = source/item, staging/item
            if src.is_dir():
                ignored = shutil.ignore_patterns("SeanTemplate.png") if item == "scripts" else None
                shutil.copytree(src, dst, symlinks=True, ignore=ignored)
            else:
                shutil.copy2(src, dst, follow_symlinks=False)
        # Reject links introduced during copying before any candidate code runs.
        reject_symlinks([staging])
        reject_symlinks([source / name for name in tocopy], excluded=[menu_image])
        if cmd_run([NODE,"--check",staging/"src/server.js"]).returncode:
            raise RuntimeError("Source syntax check failed")
        test_log = LOGS / ("tests-" + label + ".log")
        with test_log.open("w") as out:
            tests = cmd_run([NODE,"--test"], cwd=staging, stdout=out, stderr=subprocess.STDOUT, timeout=150)
        if tests.returncode != 0:
            raise RuntimeError("Unit tests failed; see " + str(test_log))
        reject_symlinks([staging])
        if dry_run:
            shutil.rmtree(staging)
            log("DRY_RUN_PASSED: tests and syntax checks passed; production release unchanged")
            log("TEST_LOG: " + str(test_log))
            return 0
        sha = hashlib.sha256((staging / "src/server.js").read_bytes()).hexdigest()
        (staging / "RELEASE.json").write_text(json.dumps(
            {"id": final.name, "source": str(source), "created_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
             "server_sha256": sha, "tests": "pass", "type": "tested-checkout"}, indent=2)+"\n")
        staging.rename(final)
        log("STAGED_AND_TESTED: " + final.name)
        log("TEST_LOG: " + str(test_log))
        joblog = LOGS / ("activate-" + label + ".log")
        with joblog.open("a") as out:
            worker = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--activate-worker", final.name],
                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                start_new_session=True, close_fds=True)
        log("ACTIVATION_WORKER_PID: " + str(worker.pid))
        log("ACTIVATION_LOG: " + str(joblog))
        log("A guard will revert to the previous release if external or local health fails.")
        return 0
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise

def main():
    if len(sys.argv) == 2 and sys.argv[1] == '--recover':
        def interrupted(signum, frame):
            raise KeyboardInterrupt('Recovery interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        return recover_pending()
    if len(sys.argv) == 3 and sys.argv[1] == "--activate-worker":
        def interrupted(signum, frame):
            raise KeyboardInterrupt('Activation interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        return activate(sys.argv[2])
    if len(sys.argv) == 1:
        return promote(SOURCE_DEFAULT)
    if len(sys.argv) == 2 and sys.argv[1] == "--dry-run":
        return promote(SOURCE_DEFAULT, dry_run=True)
    if len(sys.argv) == 2 and sys.argv[1] == "--status":
        log("PRODUCTION: " + str(ROOT))
        log("CURRENT: " + (os.readlink(CURRENT) if CURRENT.is_symlink() else "missing"))
        log("PENDING_RECOVERY: " + str((ROOT / 'activation.json').exists()))
        log("HEALTH_LOCAL: " + str(good_health("http://127.0.0.1:17676/_codassol/health")))
        log("HEALTH_PUBLIC: " + str(good_health(PUBLIC)))
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--dry-run":
        return promote(sys.argv[2], dry_run=True)
    if len(sys.argv) == 2:
        return promote(sys.argv[1])
    raise RuntimeError("Usage: promote-stable.py [source_directory|--dry-run [source_directory]|--status|--recover]")

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log("ERROR: " + str(exc))
        sys.exit(1)
