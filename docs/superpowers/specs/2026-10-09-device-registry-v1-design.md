# Device Registry v1 — peer-synchronized device directory

## Approved direction

Provide one logical device directory across CodasSol clients, without requiring a permanently online Mac or a hosted coordinator. Keep the routing registry and user-facing directory separate: changing a display name must never redirect an existing workspace or mutate a device identity.

## Alternative architectures considered

1. **Mac-authoritative table**: simple, but Mac offline makes Windows/client updates impossible. Rejected.
2. **Cloud central coordinator**: strong globally serialized updates, but adds hosting and another dependency. Deferred.
3. **Trusted peer anti-entropy (chosen)**: each Router persists an independent directory; authenticated peers exchange replicated metadata on periodic probes and publish after rename. Offline updates converge deterministically after reconnection.

## Contract for first backend slice

- Keep existing Router IDs untouched for compatibility with deployed `peers.json`, Agent tokens and workspace bindings. Persist directory keyed by ID; never use a mutable label as a routing key. Each Router also persists a distinct installation UUID to detect copied/ambiguous legacy IDs without rewriting existing routing identities. A later enrollment migration can replace legacy host-based IDs with permanent generated IDs; silently rewriting existing IDs is forbidden.
- `DeviceCatalog` persists identity-adjacent display metadata and rename revisions atomically under the private Router state directory. Store only display names, platform, kind, and revision, **never** peer tokens, Agent credentials, roots or transport addresses.
- Two independent concepts: **registered** (known in durable directory) and **online/executable** (fresh heartbeat/peer probe and healthy backend). A remembered device must not look live just because it appears in the directory.
- `GET /_codassol/devices` returns a local-first device list, with online, degraded or offline status. `PATCH /_codassol/devices/:id` changes display name. Both require a private per-Router **admin token**, not an unauthenticated UI request. Agents cannot rename devices with an Agent heartbeat token.
- `GET/POST /_codassol/peer/catalog` use the existing authenticated peer-token boundary. The peer mesh exchanges catalog snapshots bidirectionally on periodic probes and opportunistically broadcasts new names. A receiver never allows peer catalog data to overwrite routes, OAuth credentials, ownership or peer endpoints.
- Rename revision uses a persisted Lamport counter and deterministic tie-break on origin ID, so independent offline edits converge when connected. Display-name conflicts prefer the newest logical clock and then origin ID; local updates increment beyond any observed counter.
- Preserve the current v0.2 peer connection rules (private TLS/overlay or explicitly enabled trusted HTTP). A functioning Windows local Router remains usable with Mac offline.

## Honest scope and limitations

- **Synchronization is eventual**, not instantaneous when a device is offline, a peer is unreachable or discovery is incomplete. Polling runs on the existing peer interval; a rename attempts an immediate publish to reachable configured peers.
- Peer links are explicitly configured in this version. This does not implement NAT traversal, automatic joining, public key enrollment, revoked device tombstones, zero-trust identity attestation or a client failover ingress.
- A remote device discovered transitively is displayable, but not automatically routable: only explicitly configured trusted peers and directly enrolled Agents can execute actions.
- Existing installations with `local` or hostname-based Router IDs require an explicit, carefully staged identity migration in a later release. A label change must not create a new device.
- macOS, Windows and mobile clients may use the same contract later; this slice builds and tests the backend without restarting the Mac production Router.

## Verification

Unit tests cover rename persistence, concurrent Lamport merges, unchanged routing IDs, input validation, and offline devices; integration tests cover independently started Mac/Windows Routers, authenticated snapshots, API authorization, rename propagation and Mac-offline Windows operation.
