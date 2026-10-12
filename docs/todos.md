# Todos

## 2026-10-12 — SSH recovery checkpoint

- [x] Restore physical Windows standalone services through their existing scheduled tasks and reverify Router health plus local MCP workspace-bound hostname execution.
- [x] Implement and test optional per-peer HTTPS connection address to handle unavailable tailnet DNS without changing system DNS or disabling certificate checks.
- [x] Deploy the Windows Router supervisor-only update and verify recovery after a scoped process crash, preserving DevSpace PID and device identity (2026-10-12).
- [x] Deploy backed-up Mac peer transport/config and verify actual Mac→Windows workspace-bound execution after two automatic rollbacks (2026-10-12).
- [x] Verify reverse Windows→Mac workspace-bound execution with exit 0 (2026-10-12), after an initial DEVICE_OFFLINE during peer recovery.
- [ ] Repeat both physical directions after network/reboot recovery; current successful two-way calls do not prove sustained availability.

- [x] Confirm Windows Tailscale Serve activation for Router 17678 and authenticated HTTPS installation identity (2026-10-12).
- [ ] Stabilize and test already configured bidirectional peers; confirm the Mac Device Registry shows the independent Windows Router online separately from the old Agent. Preserve original state and rollback on failed readiness checks.
- [ ] Prove separate Windows-hosted ChatGPT/MCP HTTPS ingress and client failover with Mac powered off; private Tailscale peer connectivity is necessary for LAN peer routing but not sufficient for this Phase 0 acceptance criterion.

- [x] Verify physical Windows standalone preview.1 local deployment: installed worker PASS, Router 17678 and DevSpace 7676 health checks, CLI on disk, authenticated MCP `tools/list`, Windows Desktop `open_workspace`, and workspace-bound `exec_command` (2026-10-10). Do not mark Mac-offline ChatGPT reachability as complete.

- [x] Add an always-running Windows standalone Router supervisor with guarded health checks and local error logs; maintain independent backend supervision. Mac contract regression passed, but physical Windows restart/reboot tests remain pending.
- [ ] Rebuild the Windows standalone preview.2 candidate, verify its checksum, stage it on the physical PC, and run the installer through the normal approved Windows execution policy. Preserve legacy Agent, workspaces, and credentials until both local ports and execution are verified.
- [ ] Investigate intermittent Tailscale/SSH disconnects on `SEANSWPC` using network/power and event-log evidence before assigning a cause; the Windows Tailscale service reports Running but link tests have repeatedly failed.

- [x] Build a separately installed Windows Router v0.2 candidate with protected legacy install directories, supervised DevSpace startup, authenticated local Router identity verification and opt-in legacy archive/cleanup (no endpoint-protection evasion).
- [ ] On physical Windows, install/test the standalone Node candidate, verify DevSpace CLI stays present after reboot, confirm port 17678 Router identity and backend execution, then optionally archive old tasks/install directories.
- [ ] Provision authorized, resilient HTTPS ingress and mutually authenticated node peers to prove ChatGPT/other device → Windows while the Mac is offline; localhost-only Router is not an Internet-accessible client endpoint.

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
