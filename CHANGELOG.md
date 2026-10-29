# Changelog

## Verified Mac integration — 2026-10-10

- Consolidate previously tested Device Registry v1, Mac-side device discovery,
  guarded workspace routing, and macOS menu-bar controller v0.3.2 into the
  default branch; keep their original feature/fix commits and release tag.
- Show Agent presence separately from validated command execution. A recent
  heartbeat must not be reported as proof that remote DevSpace tools work.
- Preserve the production Mac Router/DevSpace/ngrok deployment unchanged by
  this Git history update. The Registry API's remaining source/runtime
  discrepancy and the unverified Windows execution path are documented.
- **Not a stable distributed v0.2 release:** Windows independent ingress,
  Mac-offline client access, and Windows reboot/network recovery still need
  physical integration tests.

## v0.2.0-dev — in progress (2026-10-08)

- Unify the Windows v0.2 package with the verified private Node +
  `@waishnav/devspace/dist/cli.js` startup path, replacing the unreliable
  npm-generated `devspace.cmd` shim for install, init, and autostart.
- Stop only CodasSol-managed scheduled tasks/private Node processes before an
  in-place Windows upgrade, and handle empty Router roots files cleanly.
- Pin the Mac LaunchAgent to Node's persistent executable path and tolerate
  launchd's brief label-reuse delay when reloading the Router.
- Add opt-in authenticated Router-to-Router peer transport; remote DevSpace
  OAuth credentials remain local to the executing machine.
- Persist workspace bindings on owner nodes and recover ownership from a
  reachable owner even after the original Router endpoint is offline.
- Ship a Windows-capable standalone Router runtime and optional Agent
  enrollment; local Windows routing no longer requires the Mac to be online.
- Reject offline roots and ambiguous owners instead of silently re-routing
  operations to a different computer.
- Client endpoint failover, peer discovery automation, and physical Windows
  validation remain pending before a stable v0.2 release.

## v0.1.4 — 2026-10-08

- Added the Android V0 native Router/DevSpace health client and USB debug
  tunnel workflow, with explicit mobile credential security boundaries.
- Kept Router and Windows Agent protocol compatibility with v0.1.3.
- Planned distributed routing as a separate v0.2 development milestone.

## v0.1.3 — 2026-09-30

- Replaced test-machine-looking Router and Windows path examples with neutral
  placeholders in public installer scripts.
- Kept public release artifacts free of deployment-specific identifiers.

## v0.1.2 — 2026-09-30

- Public Windows bundles no longer embed the build machine's private LAN Router address.
- Private deployments can prefill a Router URL only by explicitly setting `CODASSOL_ROUTER_URL`.
- Verified 19/19 Router tests, ZIP integrity, and address-free public packaging.

## v0.1.1 — 2026-09-30

- Added the self-contained Windows Agent bundle with Node.js 22 x64.
- Added private DevSpace installation, autostart, and mirror/proxy/upstream dependency fallback.
- Added explicit Windows workspace access-policy selection.
- Fixed synchronization between DevSpace `allowedRoots` and Agent-advertised roots.

## v0.1.0 — 2026-09-30

- First self-contained Windows Agent bundle.
- Known issue: an existing DevSpace configuration could retain roots different from those advertised to the Router, causing remote `open_workspace` to fail closed with `Path is outside allowed roots`.
- Kept as a historical prerelease and superseded by `v0.1.1+`.


## Windows standalone rc.1 (local qualification only)
- Integrates standalone packaging/supervision with the current develop SSE lease and exact stream replacement protocol. Source-only previews were consolidated without importing private deployment history.
- Adds bounded stream idle timeouts, stale-heartbeat isolation, duplicate/expired job suppression, explicit HTTPS enrollment origins and singleton supervisors.
- Removes the personal legacy rootless-drive routing exception; explicit device selection and backend allowedRoots remain required.
- Transaction installer keeps private local rollback snapshots; identity/OAuth/session-generation state is never rewound.
- Local qualification: 118 Node checks and 26 Python helper checks on the preceding candidate; rerun Node checks after privacy cleanup. This does not establish Windows execution.
- WIN-01 pending: PowerShell 5.1 parsing, fresh install and authenticated local execution.
- WIN-02 pending: upgrade/failure injection and rollback, including file locks and task restoration.
- WIN-03 pending: reboot, disconnect/reconnect, sleep/wake and real remote execution.
- WIN-04 pending: reversible owned-task disable/uninstall and restore.
- Requires network access to install DevSpace 1.1.0-beta.4. No unattended deployment; no stable claim.
