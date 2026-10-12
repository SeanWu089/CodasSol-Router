# Distributed Routing v0.2 (development)

**Route the Project, Not Devices.** A node is both a Router and a DevSpace
execution host. The Mac no longer needs to remain online for a Windows node
to serve its own projects. This is a development version, not yet a public
release or a zero-configuration cross-network service.

## Deploy an independent Windows Router

Build the v0.2 Windows bundle from this branch using
`./scripts/package-windows-agent.sh`, then copy
`dist/CodasSol-Windows-Node-v0.2.0-dev.zip` to Windows, extract it, and run
`INSTALL.cmd`.
Choose your local workspace roots. When asked whether to connect to an
existing Router, choose **No** if the Mac is offline. The installer starts
local DevSpace and an independent Router on **127.0.0.1:17676** and creates
logon autostart tasks. Enrollment as an old-style Agent is optional.

Check locally (PowerShell):

```powershell
Invoke-RestMethod http://127.0.0.1:17676/_codassol/health
```

`backendReachable` must be `true` to execute DevSpace tools. A local MCP
client connects to the **Windows** Router and authorizes against the local
Windows DevSpace, independent of the Mac. Existing Mac OAuth bearer tokens
are *not* interchangeable with the Windows DevSpace's authorization.

## Add trusted Router peers

Each node maintains its own private configuration. On every target Router,
retrieve its **peer token** (different from the Agent pairing token):

```sh
# macOS, from the repository:
npm run router:peer-token --silent

# Windows, using the installed Node runtime and Router app:
# %LOCALAPPDATA%\CodasSol\Agent\node\node.exe
#   %LOCALAPPDATA%\CodasSol\Agent\app\router-cli.js peer-token
```

On the **calling** Router, create `~/.codassol/peers.json` (Windows:
`%USERPROFILE%\.codassol\peers.json`) with one record per *other* node:

```json
[
  {
    "id": "WINDOWS-PC-ID",
    "url": "https://windows-node.example-private-network",
    "token": "PASTE_THE_TARGET_ROUTERS_PRIVATE_PEER_TOKEN_HERE",
    "platform": "win32",
    "roots": ["C:\\Users\\USERNAME", "D:\\Projects"]
  }
]
```

The `id` **must match** `CODASSOL_LOCAL_DEVICE_ID` on that target. The Windows
bundle uses `%COMPUTERNAME%` automatically; existing Mac setups use `local`
unless the operator explicitly overrides that environment variable. Configure
the reverse direction separately, with the Mac's peer token and Mac roots.
Keep each JSON file private (Unix mode `0600`); it contains access credentials.
Restart the Router after changing its peers file.

The Windows Router **listens on loopback by default**. To make it reachable
from peers over a trusted VPN/overlay, create the private file
`%USERPROFILE%\.codassol\router-node.json`:

```json
{ "listenHost": "0.0.0.0" }
```

Restart the `CodasSol Router` scheduled task. Bind firewall access to trusted
peers only, use authenticated HTTPS via a private-network proxy/TLS endpoint,
and **never** expose the raw Router port to the public Internet. Plain HTTP
between non-loopback peers is rejected unless explicitly allowed via
`CODASSOL_ALLOW_INSECURE_PEERS=1` (Mac) or the private setting
`"allowInsecurePeers": true` (Windows), strictly for protected networks.

## How it behaves

- Every Router knows its local roots and probes its configured peers.
- `open_workspace` selects the best online root as in v0.1, failing closed on
  ambiguity or offline owners; peer OAuth belongs to the executing node.
- Once opened, the owner also saves the workspace binding locally. A new
  Router can query live peers to recover otherwise unknown owner bindings.
- If the Mac is switched off, an online Windows Router can still accept
  Windows MCP requests and access Windows workspaces.
- No request is silently replayed on another device after a failed command.

**Not yet automatic:** if ChatGPT or Codex was configured to use *only* the Mac
MCP URL and that Mac shuts down, that URL is unreachable. Configure a separate
Windows entry point or a resilient external ingress/endpoint failover layer.
Peer routing is not a substitute for client failover or for NAT traversal,
filesync, or powering on sleeping computers.

## Verification boundaries

`npm test` includes a two-Router integration case: open a Windows workspace
through a Mac Router, shut down the Mac Router, then read that workspace
directly through the Windows Router. A real two-device deployment with
network firewall, OAuth and Windows Scheduled Tasks must be tested before
publishing v0.2 as generally available.

## Device Registry v1 (experimental API)

The device directory is separate from the routing table and persists in the
private state directory as `devices.json`. It remembers registered/local and
trusted-peer-discovered devices when they are offline. Every Router has a
persisted `installationId` for collision detection. Existing route IDs are
**not** silently changed, and a display-name change never changes a workspace
binding or grants remote execution rights.

`GET /_codassol/devices` lists this device first, then other devices with
`id`, `installationId`, `name`, `platform`, `kind`, `status`,
`backendReachable`, `lastSeenAt` and `isThisDevice` fields. `status` can be
`online`, `degraded`, `offline`, or `unknown` (known by catalog, but not directly
reachable from this Router). This API is protected by a **separate local admin
token**; Agent pairing/heartbeat and peer bearer tokens do not authorize GUI
renames.

Retrieve the secret on the **Router you want to use** via
`npm run router:admin-token --silent`. Example from a trusted local shell:

```sh
TOKEN="$(npm run router:admin-token --silent)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17676/_codassol/devices
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Home GPU"}' \
  http://127.0.0.1:17676/_codassol/devices/WINDOWS-PC-ID
```

Do not paste this token into public logs or check it into Git. Remote clients
must first be securely paired/authorized; do not expose the endpoint over raw
public HTTP. A rename is persisted locally before the Router makes a best-effort
immediate publication to trusted peers; the response includes `sync.attempted`
and `sync.delivered`. Authenticated Peer Routers independently exchange
snapshots over `GET/POST /_codassol/peer/catalog` during their usual health
probes and use deterministic Lamport revisions to reconcile conflicting edits.
If nodes are disconnected, **temporary divergence is unavoidable**; names
converge when reachable peers exchange snapshots again. Peer list discovery,
per-client pairing UI, revoke/reset flows and a genuinely push-driven UI are
separate stages. A device discovered through another peer is **display-only**
until that Router is explicitly authorized to route to it.

### Optional private connection address

A trusted HTTPS peer may set `connectAddress` to a verified IP when its private
DNS name is unavailable to the calling Router. Keep `url` as the certificate
DNS identity: TLS SNI, hostname validation and Host remain tied to that URL.
The IP only changes socket resolution; tokens and `installationId` pins remain
required as before. Invalid IPs, non-HTTPS pins and redirects are rejected.
Do not commit deployment addresses or credentials. Verify the target IP through
the trusted network inventory and repeat physical execution checks after changes.

### Probe diagnostics

Authenticated device lists and MCP discovery expose a nullable `connectivity`
record for explicitly configured peers: `checkedAt` (Unix milliseconds),
`durationMs`, `consecutiveFailures`, and `failureCode`. Fixed failure categories
separate DNS, timeout, TLS, connection, authorization, protocol/identity and
local catalog failures. Raw exceptions, peer URLs and credentials are excluded.
Successful probes reset the failure count; failed probes retain the last
successful contact time while immediately disabling the execution route.
An unreachable peer's backend is unknown (`null`), not independently proven
unhealthy. These fields measure the identity/health probe, not an end-to-end
execution test; `executionVerified` remains unknown.
