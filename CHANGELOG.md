# Changelog

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
