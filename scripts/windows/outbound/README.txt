CodasSol Windows outbound SSE bootstrap

Prerequisite: the installed NodeV02Standalone private Node and healthy
loopback DevSpace at 127.0.0.1:7676. This package contains no credentials.
target.json is generated for the intended public HTTPS ingress.

Extract the package on the intended Windows account. In the extracted folder:
  powershell -NoProfile -File .\Start-Bridge.ps1
The first run prompts for the Mac Router pairing token with hidden input.
Get that token locally on the Mac using its router-cli.js pairing-token
command. Do not paste credentials into chat. Keep the Windows terminal open.
Ctrl+C stops the foreground outbound channel. Rerun the same script to resume.

Pairing retains the independent Router's device and installation IDs, uses
a separate outbound-agent.json, and permits only the user's Desktop root.
Windows .ts.net peers are backed up and removed; the known owned Router
Scheduled Task is restarted to reload them. Other Node processes, DevSpace,
legacy Agent state, user VPN software and network settings are preserved.
The old CodasSol Tailscale Serve mapping still requires scoped inspection
and cleanup; this channel does not connect to it. Mac-offline ingress
takeover is a separate, unverified milestone.

No execution-policy bypass is provided. If Windows blocks this script,
report the actual error and follow the applicable local policy.
