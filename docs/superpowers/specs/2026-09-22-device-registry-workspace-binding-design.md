# Device Registry and Workspace Binding Design

## Goal

Add the routing core required for multiple DevSpace machines while keeping the
existing single-Mac HTTP path unchanged.

The router must make the device decision once, when a workspace is opened, and
then reuse that decision for every later request carrying the same
`workspace_id`.

## Device registry

Each device has a stable ID, platform, optional project roots, transport
metadata and presence mode.

- `static` presence is intended for directly configured local backends.
- `heartbeat` presence is intended for outbound agents and expires after a
  configurable TTL.
- project-root matching is platform aware, including Windows paths even when
  the router itself runs on macOS or Linux.

Runtime device data is private deployment state and is not committed.

## Open-workspace routing

For the first `open_workspace`:

1. an explicit device ID wins when valid and online;
2. otherwise the requested path is matched against registered project roots;
3. the most-specific matching root wins;
4. equal valid matches are rejected as ambiguous;
5. a path matching only offline devices is rejected;
6. with exactly one online device, the router may use it as the single-device
   compatibility fallback.

The policy fails closed instead of guessing when multiple devices remain
possible.

## Workspace binding

After DevSpace successfully returns a `workspace_id`, the router stores:

- workspace ID;
- device ID;
- root and mode when available;
- creation/update timestamps.

Bindings are persisted atomically in local JSON state outside the repository.
A workspace ID cannot silently move to another device. Conflicting bindings
raise an error.

## Scope boundary

This phase implements and tests the routing core only. It does not yet parse or
rewrite live MCP traffic. Live multi-device transport will be connected after
the outbound Agent path and backend-authentication boundary are implemented.

