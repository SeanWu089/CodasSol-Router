# Todos

## 2026-10-28 — GitHub synchronization

- [x] Preserve the original private development branch and uncommitted files;
  prepare a separate public-safe source snapshot from published history.
- [x] Add CI coverage for `develop` and portable production-helper tests.
- [x] Verify 53 Node tests, 13 isolated Python tests, shell syntax and diff hygiene.
- [ ] Integrate the public source PR into `develop` after its GitHub checks and
  review. Branch publication and automated-check results are tracked on GitHub.
- [ ] Review other unpublished branch/tag histories separately before pushing;
  preserve branches containing device-specific deployment records locally.
- [ ] Reconcile production-only Router modules before any whole-source runtime
  promotion. Existing SEC-01, NET-03 and CF-03 user acceptance remains pending.
- [ ] Before production adoption of the exported release helper, add deployment
  serialization and review externally linked inputs and worker interruption.

The original local project-state draft remains unchanged. Public notes omit
real deployment identities and addresses in accordance with `SECURITY.md`.

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
- [ ] Verify physical Windows legacy Agent `open_workspace` and `exec_command` via Mac Router. Existing `Windows node B` workspace-bound remote exec still returned an internal connector error despite online heartbeat; do not re-enroll, delete bindings or infer backend readiness from presence.
- [x] Fix misleading Mac menu bar status on `fix/mac-device-execution-status-v0.2`: distinguish Agent heartbeat from execution verification, show unknown Agent backend as unverified, add legacy API and state-label regression tests; build and install Mac GUI v0.3.2 with guarded rollback while preserving Router/DevSpace/ngrok processes.
- [ ] Deploy the Router `/_codassol/devices` API tri-state `backendReachable` fix in an approved Router maintenance window; current production API still reports heartbeat as backend reachability, but Mac v0.3.2 renders Agents defensively without implying execution works.

- [x] 2026-10-13: Remove obsolete Windows node B registration, retain current Windows outbound node, install Mac v0.3.3 live network/ingress status and invalidate stale green indicators; verify build, fixtures and live model. Source: fix/mac-live-connectivity in CodasSol-Router-mac-status.

- [x] 2026-10-13: Complete Mac menu v0.3.4 install/verification: move Connection into This Device detail, keep registered Windows visible independent of external checks, show live HTTPS request/payload-byte totals and rates. Windows reconnect is not a deployment prerequisite per Sean; do not expand into Windows recovery.

- [x] 2026-10-14: Verify Mac through the CodasSol plugin, fix online Windows green indicator and local-row external-probe coupling; build/test/install menu v0.3.5 without restarting connection services.

- [x] 2026-10-14: Explain HTTPS request count and install clickable request categories/recent logs with private metadata, preserve pre-classification totals, reduce repeated public checks on panel opening.

- [x] 2026-10-14: Audit icon/list/detail consistency, replace independent icon condition with shared aggregate state, expire local health, test connected/partial/checking/offline and recovery, install menu v0.3.7.

- [x] 2026-10-14: Fix hidden request-page Back navigation, pin subpage return outside scroll content, reset scroll when routes change, build/install menu v0.3.8.

- [x] 2026-10-14: Verify Mac access after grey-icon report, distinguish partial peer outage with orange dot instead of dimming usable local connection, build/test/install menu v0.3.9.

- [x] 2026-10-14: Add outside-click/app-deactivation dismissal, preserve panel interactions, remove event monitors after closure, build/install menu v0.3.10.

- [x] 2026-10-15: Isolate macOS production away from iCloud Desktop under Application Support, introduce versioned releases/guarded deployment, retarget all three LaunchAgents and verify restored end-to-end CodasSol access.
- [ ] 2026-10-15 follow-up: Verify reboot/login persistence of the new macOS production LaunchAgents. iCloud Git metadata and essential source files were hydrated and project folder marked Keep Downloaded, but project-level release scripts remain uncommitted pending focused review.


## 2026-10-22 — Cloudflare ingress migration

- [x] Configure new Cloudflare DNS/tunnel, private credential and login LaunchAgent; migrate DevSpace publicBaseUrl with backup/rollback; verify HTTPS, missing-auth rejection, PKCE OAuth and actual Mac workspace/hostname execution.
- [ ] Switch/recreate the app-backed CodasSol connector with `https://router.example.com/mcp`, then reauthorize and perform an actual connector tool call. Existing connector migration is not complete.
- [ ] Before the next Router promotion, update the production deployment helper's old ngrok public-health target and validate the change.
- [ ] Verify installed menu-app ingress monitoring against the Cloudflare route; record any old-ngrok coupling before changing it.
- [ ] Migrate each intended Windows outbound node to the new ingress only after selecting/verifying its physical identity; preserve credentials and enrollment IDs. Not part of the verified Mac path yet.

### User acceptance — awaiting explicit user confirmation

- [ ] CF-01 — In the app, connect CodasSol using `https://router.example.com/mcp` and complete existing owner-password authorization. Expected: authorization stays on the new domain and the connector connects. Status: untested; no user confirmation yet.
- [ ] CF-02 — After CF-01, ask CodasSol to read a known Desktop project file or run hostname. Expected: returns the intended Mac result without ngrok. Status: untested by user; automated HTTPS workspace/hostname verification passed separately.
- [ ] CF-03 — At a convenient time, log out/in or reboot Mac, then repeat CF-02. Expected: Cloudflare tunnel starts automatically and Codas works. Status: untested; no reboot performed.


## 2026-10-22 — Security audit and reconnect follow-up

- [x] Reproduce backend-error authentication fail-open in an isolated mock; prepare and deploy fail-closed ping verification without false OAuth401 responses. Latest version stable-20261022-112732-3aa1ac; 53 tests passed and actual Codas discovery/hostname verified.
- [x] Enforce HTTPS/minimumTLS1.2 and loopback-only Router binding; preserve backups and verify HTTP301 plus loopback listeners.
- [x] Verify restored Codas app through real workspace and command calls. Prior connector-migration execution item is complete; user-facing acceptance remains separate below.
- [ ] Reconcile production-only src enhancements into canonical development source before the next general release. Do not overwrite newer production routing/SSE/traffic behavior with an older checkout.
- [ ] Complete remaining security review scope (release/update scripts, mobile code, transitive dependency checks and intended physical Windows runtime) before any claim of a comprehensive all-platform audit. Do not infer Windows identity/readiness from Mac success.

### User acceptance — preserve reported reconnect failure

- [ ] SEC-01 — Sean reported repeated reconnection on intermediate release stable-20261022-111907-071a0b. Repaired in stable-20261022-112732-3aa1ac; awaiting user retest: use Codas several times in the same chat. Expected: device discovery and Mac file/hostname calls succeed without repeated Owner-password login. Automated verification passed; user confirmation still pending.
- [ ] SEC-02 — From another LAN device, direct Mac:17676 should be unreachable, while the authenticated HTTPS Codas MCP endpoint works. Awaiting user test; automated listener inspection shows loopback only.
- [ ] SEC-03 — Existing CF-03 physical logout/login or reboot test remains untested. Do not mark passed from a LaunchAgent state alone.

- [ ] NET-01 (2026-10-23, awaiting user test): After normal network switching/sleep-wake, use @Codas to read a Desktop project. Expected: connection recovers without reinstall or repeated authorization. Public HTTPS and real Mac tool calls were verified after tunnel DNS adjustment; long-term recovery remains untested.

- [x] NET-02 automated: supervisor startup grace, consecutive failures, recovery reset, private metrics, and owned-process shutdown regression tests (5) passed.
- [ ] NET-03 user acceptance: after natural sleep/wake or Wi-Fi switching, wait up to several minutes and use Codas again. Expected: automatic recovery without entering owner password. Awaiting user confirmation.

## 2026-10-23 — Cloudflare migration checkpoint
- [x] Isolate Mac fixes from Android branch and verify 53 Node / 5 supervisor tests.
- [ ] SEC-01 user acceptance: use Codas repeatedly without repeated owner-password login; awaiting explicit confirmation.
- [ ] NET-03 user acceptance: after sleep/wake or network switching, verify automatic recovery; awaiting explicit confirmation.
- [ ] CF-03 user acceptance: verify automatic startup after logout/login or reboot.
- [ ] Reconcile production-only Router enhancements before general production promotion.
