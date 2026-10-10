# Todos

- Add CI regression coverage that builds the Windows public bundle and asserts no private Router address is embedded.
- Add a reproducible end-to-end remote `open_workspace` integration test with a follow-up workspace-bound operation.
- Add release automation that generates checksums and validates bundle contents before publishing.
- Add Agent revocation/token-rotation commands before recommending Internet-facing deployments.
- Add a version/protocol handshake so the Router can identify incompatible or outdated Agents.
- Add backend health to Agent heartbeats and expose distinct states such as online/backend-ready/backend-degraded.
- Add an Agent-side DevSpace supervisor/restart path so a remote machine can recover from a dead local execution backend without requiring an interactive login or reboot.
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
- [ ] Deploy Registry v1 to actual Mac and Windows Routers in an approved maintenance window and verify live peer names, backend health and rename propagation. Existing Mac Router is still the older production version.
- [ ] Finalize secure client pairing/credential distribution and realtime push subscriptions for Windows/Android/iOS; current macOS implementation reads only local admin state and polls every 8 seconds.
