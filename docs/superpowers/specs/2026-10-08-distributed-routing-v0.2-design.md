# CodasSol v0.2: Independent Router Nodes

## Intent

Any online computer may host a usable CodasSol Router; shutting down a Mac must
not prevent a Windows computer from routing its own workspaces or routing to
other reachable computers. The Router remains a DevSpace control plane; it is
not a data synchronizer or a remote desktop.

## Approaches evaluated

1. **Permanent cloud coordinator**: stable URL, simple discovery, but moves the
   single point of failure and requires a hosted dependency.
2. **Trusted peer Routers (chosen for the first v0.2 slice)**: a Router on each
   machine discovers configured peers with health probes, executes locally or
   over authenticated peer RPC, and independently persists bindings. No Mac
   dependency; requires reachable private-network peer addresses.
3. **Unmanaged LAN broadcast / leader election**: zero-config on a single LAN,
   but does not work reliably across homes, NATs, sleep, or untrusted networks.

## Scope of this slice

- Backwards compatible with v0.1.x Agent enrollment and polling.
- Each Router serves local DevSpace as an independent endpoint.
- Explicit peer list, per-target bearer credential, authenticated protocol-v2
  metadata and execution RPC, strict identity match and backend health probe.
- Execute peer MCP requests using the *receiving* machine's local DevSpace
  OAuth. Never forward the calling node's DevSpace bearer credential.
- Owner-side binding persistence: an `open_workspace` routed via another Router
  also creates a binding on the actual execution machine. When a Router sees an
  unknown workspace ID, ask known online owner peers before failing closed.
- Never replay non-idempotent MCP operations after a network/peer failure;
  never redirect a bound workspace to a different device.
- Windows distribution includes Router runtime and an optional local-only
  setup path, without requiring the old Mac to be online for installation.

## Explicit limitations

- Peers are manually configured, not yet discovered via overlay network APIs.
- A client attached to a *dead* Mac endpoint still needs a working Windows
  endpoint, or a separately provided stable failover ingress. No software on
  the offline Mac can transparently redirect an established MCP connection.
- Peer links should use TLS/overlay private networking. Non-loopback HTTP is
  opt-in only. A leaked peer credential grants the full configured DevSpace
  capability of the receiving node; avoid exposing peer RPC publicly.
- This does not replicate files, DevSpace state, OAuth sessions, or make an
  offline device's files accessible.

## Protocol

`GET /_codassol/peer/info` and `POST /_codassol/peer/execute` require the
receiver's peer token. `GET /_codassol/peer/binding?workspace_id=...` returns
only bindings owned by the receiving node, never routes through third nodes.
The execution endpoint accepts only `POST /mcp` payloads, replacing caller
authorization with the receiver's own DevSpace OAuth. Version and peer-ID
mismatches reject discovery. Errors return explicit responses; no silent retry.

## Verification

Unit tests for input validation, offline states, authentication and binding
conflicts; two local Router processes or test servers with distinct roots to
prove independent Windows-style route selection and owner-side binding after
the original Router goes offline. Existing 19 Router tests must remain green.
