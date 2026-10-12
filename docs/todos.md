# Todos

## Mac fixed-domain ngrok lifecycle recovery (2026-10-12)

- [x] Inspect live Mac process ownership and legacy start script. Confirm
  separate, healthy DevSpace and Router LaunchAgents; identify manual
  `ngrok http 7676` tunnel as cause of missing public Router health.
- [x] Implement independent, scoped ngrok LaunchAgent runner,
  idempotent staging/status manager and detached migration with PID/domain
  verification plus automatic rollback. Runner refuses unhealthy Router
  and never restarts DevSpace.
- [x] Activate managed ngrok `17676` for the fixed public domain after
  testing; verify public health and unauthenticated /mcp HTTP 401, preserve
  DevSpace/Router PIDs and ensure launchd manages reconnect/restart.
- [x] Replace obsolete `start-devspace-ngrok` user entry with compatibility
  wrapper, preserving a dated backup of the original; optionally replace
  stale Desktop script if safely writable (iCloud may mark it dataless).
- [x] Verify full Node/macOS test suite, commit in isolated worktree, and
  check the live public tunnel after the migration.

## v0.3: public OAuth continuity (in progress, 2026-10-12)

- [x] Implement two-phase auth replication: signed/encrypted PREPARED
  snapshot, durable local source commit, signed COMMITTED certificate,
  durable standby confirmation and source-side ACK before returning
  OAuth results. Block pending-state promotion, unsigned commit bypass,
  ambiguous ACK retries and concurrent same-host transaction races.
- [x] Add opt-in ingress activation preflight binding locally COMMITTED
  replica state to an EXTERNALLY confirmed latest revision and verified
  fenced ingress claim. Run mock two-node takeover tests where pending,
  absent latest-proof and lease failures prohibit activation.
- [ ] Design and physically test the external latest-commit register,
  exclusive lease and crash reconciliation, including source crash
  between its local fsync and the signed commit certificate. Preserve
  fail-closed behavior until these are available: **mock leases are
  insufficient for production automatic takeover**.

- [x] Prototype encrypted, signed, per-recipient auth state replication:
  pinned source/target identities, source signature, AES-GCM confidentiality,
  monotonic revision/digest chain, rollback/gap/epoch rejection and
  durable follower acknowledgement over authenticated SSE Agent jobs.
- [x] Implement an opt-in mirrored OAuth transaction wrapper that requires
  an externally verified writer lease, syncs the complete proposed
  refresh/client/revocation state to a standby **before** returning a
  successful write, and stops on missing replica, ambiguous ACK,
  lease loss or unsafe single-host migration. Loopback integration only.
- [x] Add async live revocation verification from an atomic local
  auth-state file (rather than a startup snapshot), with 503 fail-closed
  state failures vs 401 invalid bearer, and explicit no-op signed
  replica attestations to update trusted freshness. Tests verify
  dynamic revocation without server restart.
- [ ] Connect the live revocation reader and periodic attestation scheduler
  to the actual provisioned ingress role under a validated fencing
  authority. Budget both heartbeat and replica result requests under
  ngrok Free; never refresh freshness merely by updating a local clock.
- [x] Correct heartbeat quota math: 60s POST = 43,200/device/month, not
  720. Move SSE Agent positive POST heartbeat to 15 minutes
  (~2,880/device/month); 20-minute online TTL; keep legacy TTL at 30s.
- [ ] Supply a genuine ngrok/provider-backed fencing and latest-commit
  authority; verify split-brain, simultaneous restart, uncertain writes and
  standby promotion with physical Mac/Windows devices. Mirroring alone
  cannot establish an authoritative latest committed checkpoint.
- [ ] Provision pinned signing and per-device decryption keys outside Git,
  wire mirrored refresh/client/revocation authorities into opt-in runtime,
  provide safe migration and revocation freshness, and support
  checkpoint chunking or deltas for >128 KiB auth state.

- [x] Implement short-lived, one-time local owner approval codes separate
  from Router admin and pairing tokens, plus an opt-in browser consent
  page restricted to pre-registered callback URIs and exact PKCE/resource.
- [x] Implement `POST /token` for authorization-code+S256 and
  refresh-token grant, including family rotation, replay revocation,
  per-client/resource binding, bounded request parsing and no-store.
  HTTP integration passes on independent Mac/Windows loopback Routers.
- [x] Add local disk-backed refresh authority with atomic replacement,
  exclusive locking and fail-closed stale-lock policy. It is SINGLE-HOST
  only; parallel two-Router test uses shared test authority/local filename.
- [x] Advertise RFC8414 authorization-server metadata only when
  pre-registered client issuer AND owner approval flow are configured;
  advertise DCR only when a separately provided dynamic registry exists.
- [ ] Build a real provider-fenced SERIALIZABLE refresh/grant authority
  shared by physically independent Mac and Windows nodes. Ensure token
  family revocation, JWT JTI revocation and grant state remain fresh and
  rollback-resistant after unexpected power loss and leader handoff.
- [x] Implement a constrained RFC7591 public-client DCR subset with HTTPS
  (or loopback HTTP) callback allowlists, persisted local registry,
  bounded anonymous registration and per-request client refresh.
  Verify dynamic registration → consent → code exchange on loopback.
- [ ] Replace the single-host dynamic-client registry with a provider-fenced
  shared authority that remains consistent across real Mac/Windows failover.
  Optionally add Client ID Metadata Document support with SSRF controls.
- [ ] Add a provisioned, user-ready startup and owner approval UX;
  assess live revocation synchronization (the static 5-minute snapshot
  currently blocks durable production authentication).
- [ ] Validate the full *actual* ChatGPT login, refresh and live ngrok
  two-host switch; no automatic upgrade of the legacy Mac connection.

- [x] Separate CodasSol public MCP bearer validation from local DevSpace
  access tokens in opt-in Router mode. Verify stable issuer/audience/scope,
  pinned Ed25519 public keys, expiry, fresh revocation snapshots, and
  fail-closed JWT handling on both simulated Mac and Windows ingress.
- [x] Handle 401 + protected-resource metadata at the stable public origin;
  issue **no** public token or client authorization before a real OAuth
  provider is implemented. Block unknown-path/invalid-MCP raw proxying to
  DevSpace in the experimental mode.
- [x] Prove the same public test token authorizes local MCP calls and remote
  Agent jobs without ever passing the bearer token to another DevSpace.
  The existing production Router has NOT been upgraded to this mode.
- [ ] Implement a standards-compliant PUBLIC OAuth 2.1 authorization
  server at the stable issuer: client registration/metadata, owner sign-in
  and approval, authorization code + PKCE S256, token issuance, refresh
  and safe revocation/key rollover. Preserve user consent semantics.
- [x] Add an isolated authorization-code + S256 PKCE **grant core**:
  pre-registered redirect whitelist, explicit owner approval flag,
  one-time/expiring grants, stable resource URI, EdDSA access token
  issuance and cross-node signature verification tests. NOT wired to HTTP.
- [ ] Make OAuth client registration, refresh-token state and revocations
  durable and recoverable after a real Mac→Windows cutover; sync verified,
  device-scoped credentials securely. A 5-minute-only static revocation
  snapshot cannot support indefinite offline takeover.
- [ ] Support authenticated Streamable HTTP GET/DELETE and session affinity
  without returning remote sessions to the wrong DevSpace. Fail closed
  until implemented.
- [ ] Complete a real ChatGPT OAuth login, verify continuity across TWO
  physical Router hosts and unchanged MCP URL, then plan an explicit
  one-time transition from the legacy Mac DevSpace OAuth issuer.

## Core direction: Intelligent Routing (parallel to Dynamic Ingress)

- [ ] Design a **ChatGPT-first, semantic project selection** flow: before
  `open_workspace`, ChatGPT can query trusted online devices, registered
  workspace roots and optional consented project aliases/recent workspace
  metadata, then select an explicit `device_id` and `path` without
  requiring the user to specify both every time.
- [ ] Expand the authenticated `codassol_list_devices` and/or introduce an
  appropriately scoped `codassol_list_projects` / `codassol_resolve_project`
  tool. Return **actual** device IDs, capability/readiness, ownership hints
  and source provenance; never claim arbitrary unindexed project contents
  have already been discovered. Do not expose unauthorized paths.
- [ ] Preserve the safety boundary: ChatGPT may infer intent, but Router
  enforces device identity, allowed roots, authorization and existing
  `workspace_id` owner affinity. Unknown/ambiguous/offline targets must
  fail closed; never fall back to Mac/current ingress merely because a
  Windows path failed.
- [ ] Add regressions for natural requests (“Windows desktop program”,
  “continue yesterday's project”), duplicate project names on two devices,
  disconnected devices, similar Windows/macOS paths, explicit overrides,
  stale catalog entries and non-replay of mutating calls.
- [ ] Validate real ChatGPT web and Codex client tool discovery/routing with
  MCP metadata, separate **semantic selection** from deterministic Router
  checks, and verify actual `open_workspace` + follow-up command on the
  selected device.
- [ ] Keep transport pluggable and minimal: the existing peer HTTPS path is
  the verified implementation; evaluate an outbound task-claim channel for
  nodes without peer reachability. No mandatory Tailscale, WebSocket or P2P
  in the target product. Dynamic Ingress remains a separate entrypoint
  availability milestone.

## v0.3 transport decision — SSE-first, validate before implementation

- [x] Add ephemeral per-Router HMAC public-domain challenge endpoint and
  verify the candidate instance via the **fixed public HTTPS origin**
  before any ngrok adapter activation reports ACTIVE. Two-Router loopback
  test proves a wrong upstream is rejected; no remote admin token is sent.
- [x] Add an opt-in `IngressSupervisor` that schedules manager reconciliation,
  drains on stale/unavailable candidate snapshots, times out stalled probes,
  serializes concurrent checks, and shuts down owned listeners safely.
  Tested in two-supervisor simulation; **not running in installed Router**.
- [x] Enable an independent Router to enroll as its own authenticated
  outbound SSE standby Agent, pinned to its immutable installation ID,
  approved roots and exact loopback DevSpace target. Two independent
  Router instances on Mac loopback demonstrated task delivery and
  execution/result return with **no direct PeerMesh/VPN path**.
- [ ] Integrate `runStandbyRouterAgent` with the native Mac/Windows
  service lifecycle and ingress role transitions (drain before claiming
  ownership); validate actual Windows and ngrok HTTPS separately.
- [ ] Preserve Agent enrollment/token acceptance when the entrypoint
  changes hosts; current tokens are issued by an individual Router and
  do not transfer automatically. Also complete public OAuth continuity.
- [ ] Wire real, device-bound candidate snapshots + verified ngrok
  non-pooled claim/fencing into the supervisor. Never start its background
  loop automatically while the provider is still a test fake.
- [ ] Verify that the real ngrok provider enforces non-pooled endpoint
  exclusivity/fencing during same-domain handoff; public owner identity
  proof is necessary but does not substitute for external ownership.

- [x] Fix false-offline status: SSE 60-second positive heartbeat with 90s
  per-device TTL, unchanged legacy 30s TTL, and no fabricated heartbeat on
  disconnect. Add clock-controlled regression and SSE subscription tests.
- [x] Add `expiresAt` to newly queued jobs and reject expired work at the
  Agent **before** executing on DevSpace, even when a job was buffered
  inside an open SSE connection. Leave legacy Router jobs compatible.
- [ ] Define the policy for temporary legacy fallback under ngrok Free:
  continuous 25-second long-poll requests alone exceed 100k/30-day Agent.
  Decide between fail-closed quota warning, explicit slow fallback, or
  automatic SSE-only upgrade; do not claim fallback is cost-free.

- [x] Verify local streaming reverse-proxy delivery and run sticky-failover,
  partition/concurrent-acquisition simulated tests. Node suite 78/78 passed
  on 2026-10-12. These use a mock authority, not the live ngrok data plane.
- [x] Read-only production ingress diagnostics: Mac health 200, public health
  200, unauthenticated MCP 401, and correct local ngrok tunnel. No service
  changes. Mac-to-Windows HTTPS was unreachable during this check.
- [ ] Wait for physical Windows Router/network reachability and a safe
  **separate public test-domain environment**, or an explicitly planned
  maintenance cutover, before testing ngrok SSE streaming and same-domain
  takeover. Do not use the sole Free dev domain for competing live experiments.

- [x] Compare short HTTP polling, HTTP long polling, SSE, WebSocket and
  ngrok Endpoint Pooling against simplicity, latency, free-plan usage and
  single-owner stability; record the SSE-first decision and trade-offs in
  `docs/thoughts.md`. This is a **design decision**, not a deployed feature.
- [x] Implement and test **local loopback** SSE-first Agent/Router transport:
  bearer-authenticated task events, 20s keepalive, positive 60s POST heartbeat,
  HTTP POST results, duplicate-consumer rejection, stale-job purging,
  bounded exponential reconnect jitter and compatibility fallback to polling.
  Node regression tests pass; NOT installed on the live Mac service.
- [ ] Validate the new SSE protocol **over ngrok HTTPS** on an isolated test
  tunnel, including proxy buffering, idle cutoff, network partitions,
  reconnect/fallback timings and device-bound token revocation. Only then
  enable new transport in the regular installed Agents.
- [ ] Measure ngrok request/transfer accounting, SSE proxy/idle timeout and
  reconnection behavior with two real devices over a 24-hour soak; include
  short network outages, service restart and unexpected power loss.
- [ ] Prove non-pooled fixed-hostname exclusive acquisition/release/fencing on
  Mac and Windows, with sticky ownership and no automatic reclaim after
  recovery. Do not touch the production ngrok tunnel for unsafe tests.
- [ ] Verify ChatGPT MCP OAuth continuity and workspace/device ownership
  after ingress failover; do not automatically replay non-idempotent jobs.
- [ ] Confirm no mandatory Tailscale, WebSocket, P2P, extra public endpoints,
  or cloud-hosted always-on server in the resulting user setup.

## Core v0.3: Dynamic Ingress (highest architecture priority)

- [x] Add a read-only diagnostic CLI separating local Router, public Router,
  ngrok endpoint registration and unauthenticated MCP 401; summarize ngrok
  reconnect/heartbeat/DNS/connection resets without printing secrets.
- [x] Add a guarded ngrok lifecycle adapter with external-fencing and exact
  owned-process-handle contracts; simulated handover and fail-closed tests
  pass. No live Agent launcher or production lease provider wired yet.
- [x] Define **Single Endpoint · Dynamic Ingress · Distributed Nodes** contract,
  mobile eligibility limits, ownership fencing, independent public MCP auth,
  fail-closed behavior and acceptance checks; see
  [2026-10-10 design](superpowers/specs/2026-10-10-dynamic-ingress-v0.3-design.md).
- [x] Implement shared Core eligibility, deterministic candidate preference,
  fenced-lease ingress state machine, serialized transitions and simulated
  two-node safety/failure tests (disabled by default; **not** integrated with
  any production lease authority, endpoint adapter or real network).
- [ ] Implement an authoritative external claim provider and an endpoint
  adapter with real provider-enforced fencing before permitting activation.
  Current Core interfaces deliberately reject unfenced adapters.
- [ ] Investigate Mac's repeated ngrok Agent heartbeat timeouts, DNS errors
  and TCP resets; do not terminate the existing working tunnel as part of
  diagnostics. ChatGPT UI session loss is a separate, unverified cause.
- [ ] Verify real ngrok same-domain non-pooled exclusivity, ownership and
  orphaned-agent release under two hosts; do **not** reconfigure production
  ingress before those experiments.
- [ ] Implement Mac/Windows IngressAdapters, secure automatic authorization
  continuity and guarded cutover/rollback; then test Android capability
  gating and physical phone service lifecycle.
- [ ] Pass Mac-off/Windows-on and Windows-off/Mac-on ChatGPT MCP tests using
  the existing **unchanged** fixed domain. Remain untagged until approved.

- [x] Promote the Mac Device Registry v1, path-routing fail-closed fix and Mac menu app v0.3.2 into `develop`/`main` after Node + macOS regression suites pass, updating public release-status notes. Do not present the Windows Mac-offline v0.2 milestone as completed.
- [ ] Keep the root Android worktree's uncommitted `docs/thoughts.md` intact; retire only clean, merged temporary Worktrees, and do not delete the three active dirty development checkouts.

- [x] Create a dedicated `fix/windows-v0.2-unified` worktree branch based on the distributed Router v0.2 branch, without modifying the Android worktree.
- [x] Port the independent Windows DevSpace startup-path fix into v0.2, add install/upgrade regression contracts, and build an address-free Windows node archive.
- [x] Install Mac Router v0.2 into its actual LaunchAgent runtime, recover from transient launchd registration failure, and verify protocol 2 plus backend reachability.
- [ ] Install the new v0.2 node on the intended physical Windows computer and verify `/_codassol/health`, authenticated protocol-2 peer info, DevSpace tools, scheduled tasks, and Mac-offline execution.
- v0.2: [in progress] Independent Router node on Windows and macOS, trusted peer discovery, peer execution, owner-side bindings, and a Mac-offline failover integration test.
- v0.2 next: optional stable client ingress, automated node discovery/reachability, and peer-token rotation/revocation before Internet-facing use.

- Add CI regression coverage that builds the Windows public bundle and asserts no private Router address is embedded.
- Add a reproducible end-to-end remote `open_workspace` integration test with a follow-up workspace-bound operation.
- Add release automation that generates checksums and validates bundle contents before publishing.
- Add Agent revocation/token-rotation commands before recommending Internet-facing deployments.
- Add a version/protocol handshake so the Router can identify incompatible or outdated Agents.
- Add backend health to Agent heartbeats and expose distinct states such as online/backend-ready/backend-degraded.
- Add an Agent-side DevSpace supervisor/restart path so a remote machine can recover from a dead local execution backend without requiring an interactive login or reboot.
- [x] Device Registry v1 backend: persist metadata and installation UUIDs, authenticated list/rename API, deterministic peer synchronization, same-ID collision protection, and offline/non-routable device status.
- [ ] Device Registry v1 client: local-first Tailscale-style device list with live status, device detail, and authenticated rename on Mac/Windows/Android (iOS subsequently).
- [ ] Device onboarding: create immutable per-device enrollment identifiers for legacy hostname-based Agent IDs, including RedMagic registration. Never silently migrate existing router/device identities or workspace bindings.
- [ ] Test device directory on two physical PCs with bidirectional trusted peer connectivity. Peer synchronization is presently covered by local multi-Router integration tests.
- [x] Build CodasSol Mobile Android V0 as a lightweight native Kotlin control client under `mobile/android/`.
- [x] Verify the RedMagic physical-device path end to end: ADB authorization, debug APK build/install/launch, USB reverse tunnel, healthy Router response, failure state, and recovery.

- [x] Build a minimal macOS menu bar UI that independently probes DevSpace and Router health and offers start/stop for menu-managed DevSpace only.
- [ ] Test a fresh start/stop cycle with no pre-existing DevSpace process; preserve the presently active live connection until a safe test window.
- [ ] Add optional Login Items registration, error details/log viewing, and a packaged signed release after first-pass user feedback.
- [x] Safely migrate externally started DevSpace to a managed macOS LaunchAgent with an independent migration worker, watchdog, and legacy rescue fallback. Completed after notifying the user of the expected brief interruption.
- [x] v0.2 pre-migration: build a stable location-independent DevSpace helper with package/Node fallback discovery and guarded LaunchAgent lifecycle, improve status diagnostics and icon opacity, and exercise path-failure regression tests.
- [x] Verify a LaunchAgent start/stop cycle with an isolated mock DevSpace service and an app-independent startup helper prior to physical migration.
- [x] Execute the live one-time migration using the independent launchd worker and confirm the new managed PID and Router backend health; no fallback was needed.
- [ ] At a separately announced maintenance window, verify the real GUI-controlled Stop/Start cycle and a clean macOS login/reboot. Isolated LaunchAgent tests have passed, but full physical reboot behavior is not yet verified.
- [x] Use the new black-and-white Sean image only for the macOS menu bar template; retain the existing blue Finder/application icon unchanged.
- [x] Build a CodasSol-mac v0.3 menu-bar device popover with local-first list, per-device detail, rename via Registry v1, local DevSpace start/stop/diagnostic actions, and legacy Router fallback that never invents online state.
- [ ] Deploy Registry v1 to the actual Windows Router and verify cross-node peer names, backend health and rename propagation. Mac Router Registry v1 was deployed and verified on 2026-10-10.
- [ ] Finalize secure client pairing/credential distribution and realtime push subscriptions for Windows/Android/iOS; current macOS implementation reads only local admin state and polls every 8 seconds.
- [x] v0.3.1: polish legacy UI by hiding development warnings, listing both Agent and Peer records while excluding unregistered phones, suppress unsupported renames, and verify DevSpace listener ownership before Stop.
- [x] v0.2 path-routing repair (staged): add authenticated MCP device discovery and explicit selection, deny wrong-machine fallback, and cover tilde/Windows-path behavior with regression tests in `fix/device-routing-v0.2`.
- [x] Back up and deploy Mac Router-only routing repair with detached rollback worker (2026-10-10; source `864e368`, 45 tests passed; Router PID changed, DevSpace PID preserved, Router health and Registry v1 verified).
- [x] After approval, switch the fixed-domain ngrok ingress from DevSpace `localhost:7676` to Mac Router `localhost:17676` with detached rollback protection. Public health and authenticated public MCP `tools/list` / `codassol_list_devices` passed; preserved original ngrok configuration and Router/DevSpace processes.
- [ ] Confirm refreshed ChatGPT connector tool metadata: public MCP offers `codassol_list_devices` and optional `device_id`, while the current session's callable tool schema still lists the original six DevSpace tools. Do not claim automatic device discovery is available to every current ChatGPT session until refreshed.
- [ ] Verify physical Windows legacy Agent `open_workspace` and `exec_command` via Mac Router. Existing `SEANSWPC` workspace-bound remote exec still returned an internal connector error despite online heartbeat; do not re-enroll, delete bindings or infer backend readiness from presence.
- [x] Fix misleading Mac menu bar status on `fix/mac-device-execution-status-v0.2`: distinguish Agent heartbeat from execution verification, show unknown Agent backend as unverified, add legacy API and state-label regression tests; build and install Mac GUI v0.3.2 with guarded rollback while preserving Router/DevSpace/ngrok processes.
- [ ] Deploy the Router `/_codassol/devices` API tri-state `backendReachable` fix in an approved Router maintenance window; current production API still reports heartbeat as backend reachability, but Mac v0.3.2 renders Agents defensively without implying execution works.
