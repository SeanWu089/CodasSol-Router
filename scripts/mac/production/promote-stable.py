#!/usr/bin/env python3
"""Promote a tested Desktop checkout into isolated, versioned CodasSol production.

Production Router/DevSpace/tunnel never execute directly from the Desktop.
The only production-mutating actions are atomic current-link switching and
a Router LaunchAgent restart, done by a detached worker with rollback.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
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

def atomic_link(target):
    temp = ROOT / (".current-" + uuid.uuid4().hex)
    os.symlink(str(target), temp)
    os.replace(temp, CURRENT)

def good_health(url, timeout=3):
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "CodasSol-DeploymentHealth/1.0"})
        with urllib.request.urlopen(request, timeout=timeout) as r:
            data = json.loads(r.read(4096))
            return r.status == 200 and data.get("ok") is True and data.get("backendReachable") is True
    except Exception:
        return False

def pid_from_prod():
    result = cmd_run(["/bin/ps", "-axo", "command="], capture_output=True, text=True)
    return str((CURRENT / "src/server.js").resolve()) in result.stdout

def healthy(wait_secs=25):
    deadline = time.monotonic() + wait_secs
    while time.monotonic() < deadline:
        if pid_from_prod() and good_health("http://127.0.0.1:17676/_codassol/health") and good_health(PUBLIC):
            return True
        time.sleep(1)
    return False

def restart_router():
    res = cmd_run(["/bin/launchctl","kickstart","-k",f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True)
    log("Router restart exit=" + str(res.returncode) + " " + res.stderr.strip())
    return res.returncode == 0

def activate(release_id):
    release = RELEASES / release_id
    if release.name != release_id or not (release / "src/server.js").is_file():
        raise RuntimeError("Invalid release directory")
    previous = os.readlink(CURRENT)
    log("Previous version: " + previous)
    atomic_link(Path("releases") / release_id)
    try:
        if not restart_router() or not healthy():
            raise RuntimeError("New release failed live and public health verification")
        log("PROMOTED: " + release_id)
        return 0
    except Exception as ex:
        log("FAILED, rolling back: " + str(ex))
        atomic_link(previous)
        restart_router()
        recovered = healthy()
        log("ROLLBACK_RECOVERED: " + str(recovered))
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
                shutil.copy2(src, dst)
        if cmd_run([NODE,"--check",staging/"src/server.js"]).returncode:
            raise RuntimeError("Source syntax check failed")
        test_log = LOGS / ("tests-" + label + ".log")
        with test_log.open("w") as out:
            tests = cmd_run([NODE,"--test"], cwd=staging, stdout=out, stderr=subprocess.STDOUT, timeout=150)
        if tests.returncode != 0:
            raise RuntimeError("Unit tests failed; see " + str(test_log))
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
    if len(sys.argv) >= 3 and sys.argv[1] == "--activate-worker":
        return activate(sys.argv[2])
    if len(sys.argv) == 1:
        return promote(SOURCE_DEFAULT)
    if len(sys.argv) == 2 and sys.argv[1] == "--dry-run":
        return promote(SOURCE_DEFAULT, dry_run=True)
    if len(sys.argv) == 2 and sys.argv[1] == "--status":
        log("PRODUCTION: " + str(ROOT))
        log("CURRENT: " + (os.readlink(CURRENT) if CURRENT.is_symlink() else "missing"))
        log("HEALTH_LOCAL: " + str(good_health("http://127.0.0.1:17676/_codassol/health")))
        log("HEALTH_PUBLIC: " + str(good_health(PUBLIC)))
        return 0
    if len(sys.argv) == 3 and sys.argv[1] == "--dry-run":
        return promote(sys.argv[2], dry_run=True)
    if len(sys.argv) == 2:
        return promote(sys.argv[1])
    raise RuntimeError("Usage: promote-stable.py [source_directory|--status]")

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log("ERROR: " + str(exc))
        sys.exit(1)
