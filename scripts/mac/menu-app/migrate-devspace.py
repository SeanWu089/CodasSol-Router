#!/usr/bin/env python3
"""One-time, independently launched and recoverable CodasSol-mac cutover.

Prepare is non-disruptive. The actual worker runs in launchd, outside the
DevSpace/MCP process it needs to replace. It restores a legacy backup service
if the managed service fails to pass its real HTTP health checks.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.request


HOME = Path.home()
BASE = HOME / "Library/Application Support/CodasSol-mac"
AGENTS = HOME / "Library/LaunchAgents"
LOGS = HOME / "Library/Logs"
MANAGED = "com.codassol.devspace.mac"
RESCUE = "com.codassol.devspace.rescue"
MIGRATOR = "com.codassol.devspace.migration"
WATCHDOG = "com.codassol.devspace.migration.watch"
DOMAIN = f"gui/{os.getuid()}"
STATE = BASE / "migration-state.json"
MANAGED_PLIST = AGENTS / f"{MANAGED}.plist"
# The backup must NOT be in LaunchAgents until a rollback actually happens.
RESCUE_PLIST = BASE / f"{RESCUE}.plist"
WORKER_PLIST = BASE / f"{MIGRATOR}.plist"
WATCHDOG_PLIST = BASE / f"{WATCHDOG}.plist"
RUNNER = BASE / "devspace-runner.zsh"
WORKER = BASE / "migrate-devspace.py"


def run(*args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=check, timeout=20)


def say(msg: str) -> None:
    print(msg, flush=True)


def check_http(url: str, require_backend: bool = False) -> bool:
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=1.5) as response:
            if response.status != 200:
                return False
            body = json.load(response)
            return body.get("ok") is True and (not require_backend or body.get("backendReachable") is True)
    except (OSError, ValueError, KeyError):
        return False


def healthy() -> bool:
    return check_http("http://127.0.0.1:7676/healthz") and check_http(
        "http://127.0.0.1:17676/_codassol/health", True
    )


def listeners() -> list[int]:
    result = run("/usr/sbin/lsof", "-nP", "-t", "-iTCP:7676", "-sTCP:LISTEN")
    if result.returncode not in (0, 1):
        raise RuntimeError(f"Cannot inspect port 7676: {result.stderr}")
    return sorted({int(pid) for pid in result.stdout.splitlines() if pid.strip().isdigit()})


def launchctl(*args: str) -> subprocess.CompletedProcess[str]:
    return run("/bin/launchctl", *args)


def loaded(label: str) -> bool:
    return launchctl("print", f"{DOMAIN}/{label}").returncode == 0


def save_status(phase: str, **fields: object) -> None:
    previous: dict = {}
    if STATE.exists():
        try:
            previous = json.loads(STATE.read_text())
        except ValueError:
            pass
    previous.update(fields)
    previous["phase"] = phase
    previous["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    BASE.mkdir(parents=True, exist_ok=True)
    temp = STATE.with_suffix(".tmp")
    temp.write_text(json.dumps(previous, indent=2) + "\n")
    os.replace(temp, STATE)
    say(f"{phase}: {fields.get('message', '')}")


def write_plist(path: Path, data: dict) -> None:
    if path.exists():
        old = plistlib.loads(path.read_bytes())
        if old.get("Label") != data["Label"] or old.get("ProgramArguments") != data["ProgramArguments"]:
            raise RuntimeError(f"Foreign LaunchAgent at {path}; refusing to overwrite")
    temp = path.with_suffix(".new")
    temp.write_bytes(plistlib.dumps(data))
    os.replace(temp, path)


def path_env() -> dict[str, str]:
    return {"PATH": f"{HOME}/.local/share/fnm/aliases/default/bin:{HOME}/.local/npm-global/bin:{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}


def legacy_pid() -> int:
    pids = listeners()
    if len(pids) != 1:
        raise RuntimeError(f"Expected exactly one DevSpace listener; found {pids}")
    pid = pids[0]
    cmd = run("/bin/ps", "-p", str(pid), "-o", "command=")
    uid = run("/bin/ps", "-p", str(pid), "-o", "uid=")
    if cmd.returncode != 0 or uid.returncode != 0 or int(uid.stdout.strip()) != os.getuid():
        raise RuntimeError("Listener not owned by current user")
    if "devspace" not in cmd.stdout.lower() or "serve" not in cmd.stdout:
        raise RuntimeError(f"Listener is not a recognizable DevSpace process: {cmd.stdout.strip()}")
    return pid


def preflight() -> int:
    if not healthy():
        raise RuntimeError("DevSpace/Router health not ready; refusing migration")
    if any(loaded(label) for label in (MANAGED, RESCUE, MIGRATOR, WATCHDOG)):
        raise RuntimeError("A managed, rescue, migration, or watchdog LaunchAgent is already loaded")
    pid = legacy_pid()
    app_resources = HOME / "Applications/CodasSol-mac.app/Contents/Resources"
    for resource in ("devspace-runner.zsh", "migrate-devspace.py"):
        if not (app_resources / resource).is_file():
            raise RuntimeError(f"Application resource missing: {resource}")
    diag = run("/bin/zsh", str(app_resources / "devspace-runner.zsh"), "--diagnose")
    if diag.returncode != 0:
        raise RuntimeError(f"Managed runner preflight failed: {diag.stderr}")
    for folder in (BASE, AGENTS, LOGS):
        folder.mkdir(parents=True, exist_ok=True)
    for resource in ("devspace-runner.zsh", "migrate-devspace.py"):
        target = BASE / resource
        staged = BASE / (resource + ".new")
        shutil.copyfile(app_resources / resource, staged)
        os.chmod(staged, 0o700)
        os.replace(staged, target)
    python = "/usr/bin/python3"
    # Use the previous working npm invocation for rollback, not the new manager.
    devspace_shim = HOME / ".local/npm-global/bin/devspace"
    node_path = HOME / ".local/share/fnm/aliases/default/bin/node"
    if not node_path.is_file() or not devspace_shim.exists():
        raise RuntimeError("Legacy rollback executable missing; refusing migration")
    if run(str(node_path), str(devspace_shim), "--version").returncode != 0:
        raise RuntimeError("Legacy rollback invocation failed preflight")
    common = {"WorkingDirectory": str(HOME), "EnvironmentVariables": path_env(), "RunAtLoad": True,
              "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 15}
    write_plist(MANAGED_PLIST, dict(common, Label=MANAGED,
        ProgramArguments=["/bin/zsh", str(RUNNER), "--serve"],
        StandardOutPath=str(LOGS / "CodasSol-mac-DevSpace.log"),
        StandardErrorPath=str(LOGS / "CodasSol-mac-DevSpace.log")))
    write_plist(RESCUE_PLIST, dict(common, Label=RESCUE,
        ProgramArguments=[str(node_path), str(devspace_shim), "serve"],
        StandardOutPath=str(LOGS / "CodasSol-mac-Rescue.log"),
        StandardErrorPath=str(LOGS / "CodasSol-mac-Rescue.log")))
    write_plist(WORKER_PLIST, {"Label": MIGRATOR,
        "ProgramArguments": [python, str(WORKER), "run"],
        "RunAtLoad": True, "WorkingDirectory": str(HOME),
        "StandardOutPath": str(LOGS / "CodasSol-mac-Migration.log"),
        "StandardErrorPath": str(LOGS / "CodasSol-mac-Migration.log")})
    write_plist(WATCHDOG_PLIST, {"Label": WATCHDOG,
        "ProgramArguments": [python, str(WORKER), "watch"],
        "RunAtLoad": True, "WorkingDirectory": str(HOME),
        "StandardOutPath": str(LOGS / "CodasSol-mac-Migration-watch.log"),
        "StandardErrorPath": str(LOGS / "CodasSol-mac-Migration-watch.log")})
    save_status("prepared", expected_pid=pid, message="Runner, managed job, and independent rescue job staged; live connection untouched")
    return pid


def wait_healthy(seconds: int) -> bool:
    for _ in range(seconds * 2):
        if healthy():
            return True
        time.sleep(0.5)
    return False


def recover(reason: str) -> None:
    save_status("recovering", message=reason)
    if loaded(MANAGED):
        launchctl("bootout", f"{DOMAIN}/{MANAGED}")
    # A failed managed service must not collide with the rescue at next login.
    if MANAGED_PLIST.exists():
        os.replace(MANAGED_PLIST, BASE / f"{MANAGED}.failed.plist")
    for _ in range(20):
        if not listeners():
            break
        time.sleep(0.5)
    if listeners():
        save_status("manual_recovery_required", message="Port 7676 occupied; cannot launch rescue without collision")
        return
    rescued = AGENTS / f"{RESCUE}.plist"
    shutil.copyfile(RESCUE_PLIST, rescued)
    result = launchctl("bootstrap", DOMAIN, str(rescued))
    if result.returncode != 0:
        save_status("manual_recovery_required", message=f"Rescue bootstrap failed: {result.stderr}")
        return
    if wait_healthy(30):
        save_status("rolled_back", message="Legacy DevSpace restored through independent LaunchAgent")
    else:
        save_status("manual_recovery_required", message="Rescue started but health did not recover; inspect Logs/CodasSol-mac-Rescue.log")


def migrate() -> None:
    if not STATE.exists():
        raise RuntimeError("Migration state missing; do not stop anything")
    state = json.loads(STATE.read_text())
    if state.get("phase") != "prepared":
        say(f"Worker skipped in phase {state.get('phase')}")
        return
    pid = int(state["expected_pid"])
    if not healthy() or listeners() != [pid] or loaded(MANAGED) or loaded(RESCUE):
        save_status("aborted", message="Current process or health changed since preflight; no service was stopped")
        return
    save_status("stopping_legacy", message=f"Stopping known old DevSpace PID {pid}")
    os.kill(pid, signal.SIGTERM)
    for _ in range(40):
        if not listeners():
            break
        time.sleep(0.25)
    if listeners():
        save_status("aborted", message="Port did not become free after SIGTERM; no second instance started")
        return
    try:
        save_status("starting_managed", message="Legacy listener stopped; bootstrapping managed LaunchAgent")
        result = launchctl("bootstrap", DOMAIN, str(MANAGED_PLIST))
        if result.returncode != 0:
            recover(f"Managed bootstrap failed: {result.stderr}")
            return
        if wait_healthy(40):
            save_status("success", message="Managed DevSpace and Router backend both healthy")
        else:
            recover("Managed DevSpace did not become healthy within 40 seconds")
    except Exception as exc:
        recover(f"Migration worker error: {exc}")


def watch() -> None:
    # Second process, separately managed by launchd: survives a migration
    # worker crash, a broken MCP connection, or a closed shell session.
    for _ in range(24):
        time.sleep(5)
        if STATE.exists():
            state = json.loads(STATE.read_text()).get("phase")
            if state in ("success", "rolled_back") or (state == "aborted" and healthy()):
                say(f"Watchdog: migration ended in phase {state}; leaving services untouched")
                return
    if healthy():
        say("Watchdog: endpoints healthy; no recovery needed")
        return
    if loaded(RESCUE):
        say("Watchdog: rescue already loaded; no duplicate recovery")
        return
    recover("Watchdog: service unhealthy 120 seconds after migration start")


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) == 2 else "status"
    if arg == "prepare":
        preflight()
        say("PREPARED: ready for a separately scheduled, potentially disruptive migration")
    elif arg == "schedule":
        state = json.loads(STATE.read_text())
        if state.get("phase") != "prepared":
            raise RuntimeError("Migration is not prepared; refusing to start")
        watchdog = launchctl("bootstrap", DOMAIN, str(WATCHDOG_PLIST))
        if watchdog.returncode:
            raise RuntimeError(f"Watchdog scheduling failed (migration untouched): {watchdog.stderr}")
        result = launchctl("bootstrap", DOMAIN, str(WORKER_PLIST))
        if result.returncode:
            launchctl("bootout", f"{DOMAIN}/{WATCHDOG}")
            raise RuntimeError(f"Worker scheduling failed: {result.stderr}")
        say("Migration worker scheduled independently of DevSpace")
    elif arg == "run":
        migrate()
    elif arg == "watch":
        watch()
    elif arg == "status":
        say(STATE.read_text() if STATE.exists() else "No migration attempt has been staged")
    else:
        raise RuntimeError("Expected prepare, schedule, run, watch, or status")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No unhandled error should silently invalidate status if it is recorded.
        if len(sys.argv) > 1 and sys.argv[1] == "run":
            save_status("manual_recovery_required", message=f"Worker failed unexpectedly: {error}")
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
