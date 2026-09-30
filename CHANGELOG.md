# Changelog

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
