# Todos

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
- [x] Build CodasSol Mobile Android V0 as a lightweight native Kotlin control client under `mobile/android/`.
- [x] Verify the RedMagic physical-device path end to end: ADB authorization, debug APK build/install/launch, USB reverse tunnel, healthy Router response, failure state, and recovery.
