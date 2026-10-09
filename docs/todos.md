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
- [ ] Safely migrate independently started DevSpace to a managed background service so CodasSol-mac can truly control connection on/off without leaving terminal-launched sessions unmanaged. Confirm an interruption window before any restart.
- [x] v0.2 pre-migration: build a stable location-independent DevSpace helper with package/Node fallback discovery and guarded LaunchAgent lifecycle, improve status diagnostics and icon opacity, and exercise path-failure regression tests.
- [ ] Verify the managed LaunchAgent start/stop and startup-on-login behavior in a safe test environment before the one-time production cutover.
