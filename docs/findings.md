# Findings

- 2026-10-08 — On a connected RedMagic 11 Pro (nubia, Android 16), the Mac recognized USB and ADB became authorized. However, the phone's package manager returned `Success: created install session [-1]`, causing both streamed and non-streamed `adb install` to fail with `SecurityException: Caller has no access to session -1`. APK transfer with `adb push` succeeds. USB-install permission or on-device installation requires user action; do not interpret ADB authorization as installation authorization.
- 2026-10-08 — After enabling the USB installation permission on the RedMagic, `adb install -r` returned `Success` for CodasSol Mobile Android V0. The app launched in the foreground (`com.codassol.mobile/.MainActivity`), and the UI accessibility hierarchy reported Router `Connected` and backend `Reachable`. The phone's own `curl` returned HTTP 200 with `{"ok":true,"backendReachable":true}` through `adb reverse tcp:17676 tcp:17676`. Removing the reverse tunnel and tapping `Check connection` displayed `Disconnected / Unavailable`, and restoring the tunnel and tapping again returned `Connected / Reachable`. The Gradle `:app:assembleDebug` build completed successfully; debug APK size about 808 KiB.

- 2026-09-30 — The first Windows bundle could enroll successfully while an existing DevSpace configuration still enforced different `allowedRoots`. The first real Mac -> Router -> Windows `open_workspace` test exposed the mismatch because DevSpace correctly failed closed.
- 2026-09-30 — DevSpace permission roots and Router-advertised Agent roots are one logical policy and must stay synchronized.
- 2026-09-30 — Successful enrollment is not sufficient end-to-end proof. Verification should include a remote `open_workspace` and a follow-up operation on the returned workspace.
- 2026-09-30 — The original public packager auto-detected the build Mac's LAN IP and embedded it in `router-default.txt`. It was not a credential, but it violated the repository's deployment-boundary policy. `v0.1.2` makes public bundles address-free by default.
- 2026-09-30 — Release verification should also scan installer text/examples
  for test-machine-looking identifiers; v0.1.3 replaces those with neutral
  placeholders.
- 2026-09-30 — A live end-to-end test routed from the Mac Router into a Windows Desktop workspace and moved a desktop shortcut to the Windows Recycle Bin.
- 2026-09-30 — A later live session exposed a resilience gap: the Windows Agent heartbeat remained online while its local DevSpace backend became unreachable. The Router could still list the device but remote tool calls failed with an Agent-side fetch error. Device presence and execution-backend health must be tracked separately.
