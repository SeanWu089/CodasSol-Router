# Windows Agent Setup

This guide connects a Windows computer to an already-running CodasSol Router.
The Windows machine does not need an ngrok endpoint or inbound firewall rule.

## Recommended personal setup: self-contained bundle

For most users, download the latest Windows bundle from:

https://github.com/SeanWu089/CodasSol-Router/releases/latest

Transfer the ZIP to Windows, extract it, then double-click INSTALL.cmd.

Public bundles do not embed a build machine's LAN address. The installer asks
for the Router URL when no private default was intentionally supplied. For a
private bundle, set `CODASSOL_ROUTER_URL` explicitly while packaging.

The bundle carries its own Windows Node 22 runtime, so the target PC does not
need Git, a global Node installation, or administrator-level npm changes.
DevSpace is installed privately under %LOCALAPPDATA%\CodasSol\Agent.

For DevSpace downloads, the installer first tries npmmirror with a temporary
per-command registry override, then the machine's existing npm/proxy
configuration, then the official npm registry. It does not permanently change
global registry or proxy settings.

The repository-based setup below remains available for development.

During installation, choose the workspace roots that CodasSol is allowed to
route to this machine. The recommended profile grants the current Windows user
profile plus fixed non-system drives. It does not grant the whole system drive
C:\ by default, and it does not automatically include removable or network
drives.

The installer writes the same root list to both DevSpace allowedRoots and the
CodasSol Agent configuration. This keeps the Router's advertised capabilities
aligned with the machine-local security boundary.

### Release notes

- v0.1.0: first Windows bundle. Existing DevSpace roots could remain out of
  sync with the roots advertised to the Router.
- v0.1.1: synchronized DevSpace and Agent roots and added explicit access
  profiles plus REPAIR-ROOT.cmd.
- v0.1.2: public bundles no longer embed the build machine's private LAN Router
  address. Private builds can intentionally prefill one with
  CODASSOL_ROUTER_URL.

The v0.1.0 root mismatch was fail-closed: DevSpace rejected paths outside its
configured roots rather than granting extra access.

## Build the bundle yourself

On macOS:

    ./scripts/package-windows-agent.sh

The output is dist/CodasSol-Windows-Agent.zip.

## Prerequisites

- Node.js 22 or newer
- Git for Windows
- network reachability from Windows to the Router URL

## 1. Prepare DevSpace

The setup script installs DevSpace if it is missing. If DevSpace has never been
initialized, the script launches `devspace init`.

For an Agent-only machine, choose **Coding Agents** rather than ChatGPT. The
machine does not need its own public URL or tunnel.

The setup script starts DevSpace from the Windows user profile directory when
port 7676 is not already running.

## 2. Enroll

On the Router machine, obtain:

- a Router URL reachable from Windows;
- the private pairing token.

Then run from PowerShell in a clone of this repository:

```powershell
.\scripts\windows\setup-agent.ps1 -RouterUrl "http://ROUTER-IP:17676"
```

The script prompts for the pairing token using hidden input so it does not need
to appear in PowerShell command history.

By default the Agent advertises the Windows user profile as its project root.
Override it with `-Roots` when a narrower root is preferred. Multiple roots
use `|` as the separator.

The pairing token is used only during enrollment and is not stored on Windows.
The Router issues a separate per-device Agent token.

## 3. Test in foreground

```powershell
cd "$env:USERPROFILE\CodasSol-Router"
node src\agent.js run
```

Keep this window open for the first cross-device test.

## 4. Optional autostart

After the first test succeeds:

```powershell
.\scripts\windows\install-autostart.ps1
```

This creates a Scheduled Task for the current Windows user and starts the Agent
at logon.

## Private state

Windows Agent state is stored under:

```text
%USERPROFILE%\.codassol\agent.json
```

It contains the device Agent token and local DevSpace OAuth material. Keep it
private and never commit it.

