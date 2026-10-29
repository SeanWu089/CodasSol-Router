STABILITY CANDIDATE — NOT PHYSICALLY ACCEPTED
Target: Windows x64, Windows PowerShell 5.1, private Node 22.23.3.
Windows 10/11 and scheduled-task behavior require physical qualification.
Run INSTALL.cmd (transaction.ps1); direct install.ps1 is intentionally guarded.
Before mutation, transaction.ps1 retains runtime/config/task snapshots privately.
An ordinary installer failure restores prior runtime/tasks/configuration.
Identity, OAuth state and monotonic session-generation ledgers are never rewound.
Power loss/forced termination recovery and rollback itself are NOT yet qualified.
Do not deploy unattended. Preserve the printed backup path for manual recovery.
DevSpace 1.1.0-beta.4 is installed from npm at installation time (network required).
This is not a fully offline bundle. Existing identity and credentials are reused.
No automatic ingress migration: choose the correct origin explicitly on enrollment.
The local Router can run without Mac; remote access still depends on its ingress.
Uninstall for candidate evaluation: after verifying task ownership, stop and disable
only the three Standalone V02 tasks. Retain runtime/state/backup for reversible
re-enable; no credential deletion or legacy cleanup is required for acceptance.
The installer does not install optional Sentinel inside the transaction.

RC.1 CHANGES
  Background tasks use bundled Node directly, without PowerShell script policy.
  INSTALL.cmd unblocks only files in this extracted package; no policy changes.
  On first install, provide your explicit HTTPS Router origin (Cloudflare or legacy ngrok) and pairing token.
  Token input is hidden. Existing identity, roots and registration are preserved.
  LocalOnly is an explicit opt-out; default install includes registration.
  Local health and remote registration are verified separately.
  No automatic fixed-domain failover or Mac-offline ChatGPT access is claimed.

CodasSol Windows Node — standalone v0.2 rc.1
===============================================

WHAT THIS DOES
  Runs a local, independent CodasSol Router on 127.0.0.1:17678.
  Runs DevSpace on 127.0.0.1:7676 using a supervisor task.
  Uses a private Node 22 installation; no global PATH or npm changes.
  Preserves old Agent, NodeV02, DevSpaceRescue and existing credentials.
  Does not require the Mac to be online for local Windows operation.

INSTALL
  1. Extract the ZIP normally. Do not run from inside compressed ZIP preview.
  2. Run INSTALL.cmd as your normal Windows user.
  3. If prompted, initialize DevSpace and select "Coding Agents".
  4. After local health verification, optionally check "Install File Sentinel"
     in the graphical component selector. It is unchecked by default.
  5. Confirm "INSTALLATION COMPLETE". Registration and local health are separate checks.
  6. ONLY AFTER verification passes, run CLEANUP-OLD.cmd to disable old
     CodasSol scheduled tasks and archive old install folders, without
     deleting private credentials or other applications.

  INSTALL.cmd removes downloaded-file marks only from this extracted package.
  It does not change PowerShell execution policy. Organization Group Policy
  requiring signed scripts remains enforced and will show a clear failure.

The default workspace permission root is your current Windows user profile.
For another directory, run the script in a regular PowerShell session:
  .\transaction.ps1 -Roots 'C:\Users\YOUR_USERNAME|D:\PROJECTS'
Choose only locations you have explicit permission to access.
For unattended installs, use -InstallFileSentinel to opt in explicitly or
-SkipSentinelPrompt to skip the optional GUI. The File Sentinel itself can
also be installed/uninstalled independently from
components\file-sentinel\windows\install.ps1.
It records local file change metadata and hashes, not file contents or the
responsible process. It does not attempt to repair or restore files.

HEALTH
  DevSpace: http://127.0.0.1:7676/healthz
  Router:   http://127.0.0.1:17678/_codassol/health
  The Router must report backendReachable=true.
  For a real local MCP execution check after VERIFY.cmd passes:
    %LOCALAPPDATA%\CodasSol\NodeV02Standalone\node\node.exe probe-mcp.mjs
  Run that command from the extracted installation ZIP directory.
  The check opens the current user's Desktop as a workspace and runs hostname
  through the local Router; it does not print any DevSpace OAuth credentials.
  Logs: %LOCALAPPDATA%\CodasSol\NodeV02Standalone\logs
  The Router and DevSpace scheduled tasks keep a supervisor active while
  Windows is logged in. A crashed Router is restarted after a short delay;
  an existing healthy Router is not duplicated if DevSpace alone is down.

OPTIONAL BACKEND RECOVERY ACCEPTANCE
  Ordinary tool failures must not restart DevSpace. After installation, run
  the private Node runtime with probe-mcp.mjs --failed-command-check to verify
  exit code 7 is returned, the backend PID stays unchanged, and hostname works.
  PowerShell 5.1 stderr warnings are tolerated by the daemon supervisor;
  genuine daemon exits still trigger recovery.
  Run test-backend-recovery.ps1 -PerformCrashTest through a separate
  Scheduled Task, not through the backend being tested. The test briefly
  interrupts Windows MCP calls. It stops only the verified private DevSpace
  listener, expects the existing supervisor to recover it, preserves Router
  PID/installation identity, then opens a workspace and executes hostname.
  Keep probe-mcp.mjs beside the test script. Without the opt-in switch no
  process is stopped. Result: NodeV02Standalone/logs/backend-recovery-check.json.
  Backend restart invalidates native process sessions even when workspace IDs
  survive. Do not reuse old session IDs or replay uncertain commands. Current
  DevSpace counters can restart at 1; generation-aware handles remain pending.

RELIABILITY AND SECURITY
  Windows supervised sessions reserve a distinct integer range at each launch.
  The private .codassol-node-v02/session-generation.json ledger and initialized
  marker must not be deleted or rolled back independently. An abandoned
  session-generation.lock, lost/corrupt ledger, or exhausted range stops new
  allocation until reviewed; never reset the ledger to recover service.
  This adapter preserves the published dependency files. Its upstream session
  allocation contract must be physically reverified when upgrading DevSpace.
  This package does NOT bypass enterprise antivirus or application policy.
  If DevSpace dist/cli.js disappears or Windows blocks script execution,
  stop: do not turn off or evade the hospital's security controls.
  The installer does NOT embed credentials, ngrok URLs or Mac identity.
  The Router listens on loopback only. It is NOT accessible from other PCs
  or ChatGPT until independently authorized HTTPS ingress is configured.
  Preview.5 guides this authorization during installation.
  Mutual peer configuration and authenticated client endpoints must be set
  up on each node separately. No automatic NAT traversal, client failover,
  or Mac-offline cross-network connectivity is included in this preview.
  A device being online is not proof that it can execute remote commands.

Do not publish tokens, .codassol private state, or DevSpace auth files.
