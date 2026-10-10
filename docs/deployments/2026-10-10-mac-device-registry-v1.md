# Mac Router Device Registry v1 cutover — 2026-10-10

## Verified result

Device Registry v1 was enabled on the **running macOS Router** using a detached worker with health verification and automatic rollback. The cutover completed successfully; rollback was not required. The existing Mac menu app v0.3.1 reads the new authenticated directory endpoint without an app reinstall.

Checks performed on the real Mac:

- Before cutover: Router and DevSpace reported `ok: true`; the Router LaunchAgent PID owned the listening TCP/17676 socket. The production Router did not yet expose `/_codassol/devices`.
- Independent sandbox: Registry startup, authentication, legacy Agent migration, rename, persistence, and isolation of the real state passed.
- Combined staged runtime: **33 Node tests passed**; the macOS menu/launchd/migration tests also passed.
- Following guarded Router-only restart: `/_codassol/health` returned `ok: true, backendReachable: true`; `http://127.0.0.1:7676/healthz` still responded normally.
- With the **local admin token**, `GET /_codassol/devices` returned `version: 1`, the local Router first, and the preexisting registered Windows Agent. Unauthorized requests are denied. Its presence was initially offline, then reflected a subsequent live heartbeat as online.
- `GET /_codassol/peer/info` continued to report protocol 2 with Registry v1 capability and installation identity.
- Router private files retain mode `0600`; original runtime and private-state backups are saved under a user-private `~/.local/share/codassol-router-upgrades/backup-*` folder.

## Important source/runtime difference

The deployed Router is a **Registry v1 overlay on the existing production v0.2 runtime**, not a byte-for-byte checkout of `develop`. The overlay uses the Registry-related files from `develop` at `2b5c278` (`src/device-catalog.js`, `peer-mesh.js`, `private-state.js`, `router-cli.js`, `runtime.js`, `server.js`) and preserves two existing in-production compatibility adjustments:

1. Forwarding of additional MCP `mcp-method` and `mcp-name` request headers on peer operations.
2. The existing temporary legacy Windows D:/E: fallback in `src/routing-policy.js` for an Agent that currently advertises no roots.

These compatibility differences must be reviewed and replaced with tested, explicit routing rules **before a later full runtime replacement**. Do not assume `git checkout develop && copy src/` will preserve the current live Windows behavior. The automatic deployment worker and manifest are stored outside Git in the private local upgrades folder.

## Scope boundary — Windows not yet upgraded

At cutover, the Mac's private `peers.json` contained **zero configured Router peers**. A Windows Agent was still registered and later heartbeated online, but that does **not** imply the independent Windows Router is reachable, authenticated as a peer, or running Registry v1. Windows is a separate deployment task once an authenticated management path and rollback approach are confirmed.

The UI may display the registered Windows Agent and its heartbeat-derived status. It does not currently guarantee full Mac↔Windows directory synchronization, and no unregistered Android phone is added automatically.

## Next steps

1. Review/preserve the two production compatibility adjustments in source and integration tests.
2. Confirm the actual Windows Router endpoint/identity and user-approved safe update method; back up Windows runtime and Scheduled Tasks before attempting a Windows cutover.
3. Configure authenticated Router peers bidirectionally, verify cross-device rename and offline merge on physical devices, and keep the Mac independent of Windows uptime.

**Do not copy private Router state, admin tokens, peer tokens, TLS keys, or machine-specific endpoint URLs into this repository.**
