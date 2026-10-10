# Todos

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

- [x] Compare short HTTP polling, HTTP long polling, SSE, WebSocket and
  ngrok Endpoint Pooling against simplicity, latency, free-plan usage and
  single-owner stability; record the SSE-first decision and trade-offs in
  `docs/thoughts.md`. This is a **design decision**, not a deployed feature.
- [ ] Prototype authenticated outbound HTTPS SSE with a standby node, small
  heartbeat/keepalive frames, task events, HTTP POST results, bounded reconnect
  backoff/jitter, and fallback to existing HTTP Agent polling. Preserve
  device-scoped authorization and DevSpace-local execution.
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
