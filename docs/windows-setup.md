# Windows Agent Setup

This guide connects a Windows computer to an already-running CodasSol Router.
The Windows machine does not need an ngrok endpoint or inbound firewall rule.

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

