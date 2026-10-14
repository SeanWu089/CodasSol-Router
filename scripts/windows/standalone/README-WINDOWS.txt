CodasSol Windows Node — standalone v0.2 preview.4
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
  5. Confirm "WINDOWS NODE READY" and run VERIFY.cmd once more.
  6. ONLY AFTER verification passes, run CLEANUP-OLD.cmd to disable old
     CodasSol scheduled tasks and archive old install folders, without
     deleting private credentials or other applications.

  If PowerShell reports that an extracted script is not digitally signed,
  verify the ZIP SHA-256 against the official release first. If you trust
  that exact package and local policy allows it, use Windows file Properties
  to unblock the original ZIP before re-extraction. Do not relax execution
  policy, switch off antivirus, or bypass organization-managed restrictions.

The default workspace permission root is your current Windows user profile.
For another directory, run the script in a regular PowerShell session:
  .\install.ps1 -Roots 'C:\Users\YOUR_USERNAME|D:\PROJECTS'
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
  Mutual peer configuration and authenticated client endpoints must be set
  up on each node separately. No automatic NAT traversal, client failover,
  or Mac-offline cross-network connectivity is included in this preview.
  A device being online is not proof that it can execute remote commands.

Do not publish tokens, .codassol private state, or DevSpace auth files.
