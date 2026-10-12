CodasSol Windows Node — standalone v0.2 preview
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
  4. Confirm "WINDOWS NODE READY" and run VERIFY.cmd once more.
  5. ONLY AFTER verification passes, run CLEANUP-OLD.cmd to disable old
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

RELIABILITY AND SECURITY
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
