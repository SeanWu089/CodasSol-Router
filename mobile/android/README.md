# Codas Android — wireless Agent preview

The phone connects **outbound over authenticated HTTPS/SSE** to a configured
Codas Router. Wi-Fi and mobile data are supported transports; USB is only an
optional developer installation/logging tool. The app never creates an ADB
reverse tunnel. Building projects remains the job of a computer/cloud worker.

Requires Android 11+ (API 30). This preview retains package ID
`com.codassol.mobile` and upgrades V0 in place.

## On the phone

1. Install the APK and enter the owner's HTTPS Router origin (a `/mcp` URL is
   also accepted). Enter the existing pairing code for first enrollment.
2. Turn on **允许 Codas 访问手机**. Allow notifications for the persistent
   session indicator and stop action. Pairing exchanges the enrollment code
   for a per-device token encrypted with Android Keystore; the enrollment code
   is not saved. Backup/device transfer of credentials is excluded.
3. Enable **Codas 测试控制** in Android Accessibility settings for screenshots,
   launch and gestures. Permit installation from Codas when testing APKs.
4. Keep the phone unlocked for visual tests. OEM power management may require
   manually allowing the foreground app to remain active.

Turning access off closes the stream, rejects new actions, rejects jobs created before the current enabled session, invalidates queued
callbacks and cancels pending download/installation work. Already completed
installations remain installed. A gesture already dispatched to Android may
finish its short stroke. Process death/reboot leaves access off; there is no
boot receiver or automatic service restart.

## Cloud AI tool usage

Use device discovery to obtain the **explicit phone device ID**, then:

```json
{"path":"/codas/android","device_id":"<discovered-phone-id>"}
```

with `open_workspace`. The phone returns a stable workspace ID and its tool
instructions. `exec_command` is a compatibility envelope for a native operation
API here, **not an Android shell**. Other DevSpace file/process tools are rejected.
No production Router change is needed where authenticated Agent SSE is already
available. The source-reconciliation checkpoint preserves that existing wire
protocol; older Routers without SSE need a separately tested upgrade.

Use the returned `workspace_id` and one of these `cmd` values:

```text
android info
android apps
android screenshot
android {"action":"launch","package":"com.example.game"}
android {"action":"tap","x":300,"y":600}
android {"action":"swipe","x":200,"y":900,"endX":800,"endY":900,"durationMs":300}
android {"action":"install","url":"https://artifacts.example.com/game.apk","sha256":"<64 hex digits>","package":"com.example.game"}
android install_status
```

Screenshot results contain a JPEG MCP image plus physical display and image
sizes. Scale screenshot coordinates back to physical display coordinates.
Launch returns a request acknowledgement; verify the foreground app with
`info`/a screenshot. Gestures are limited to the app selected by `launch` and
reject known system/settings/installer/permission surfaces. Never automate
system approval prompts. Secure-window screenshots can be denied by Android.

Installation is asynchronous: poll `install_status`. Downloads require HTTPS,
SHA-256 and the expected package name, and are limited to a single APK of
512 MiB (split APK/App Bundle installation is not implemented). Once downloaded,
open Codas, tap **安装收到的测试包**, then **继续系统安装确认** and confirm Android's
installation UI. `installed` reports package-manager success and observed
installed version. The download URL is not sent the Codas Agent credential.
On-device arbitrary shell, system-wide logcat, root, silent installation and
on-phone compilers are outside this preview.

## Build and checks

Use the existing JDK 17 and Android SDK 35; no Android Studio is required:

```sh
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :fixture:assembleDebug :app:lintDebug
sh test/protocol-test.sh
```

APK outputs are under each module's `build/outputs/apk/` directory.
`fixture` is **Codas Test Pad**, a small permission-free app with visible tap
and swipe counters for installation/visual-control acceptance.

Optional USB developer checks (they do not carry Codas network traffic):

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w com.codassol.mobile.test/com.codassol.mobile.PhoneInstrumentation
adb shell am start -n com.codassol.mobile/.MainActivity
```

Run instrumentation only with access stopped. The separate **debug test APK**
also supports `-e setup true`: it consumes/deletes an explicitly supplied private
`files/onboarding-test.json` in the target app (`endpoint`, `pairing`), enrolls
over the phone's own HTTPS network, and saves the device credential encrypted.
It does not grant permissions or turn on access. This is a development setup
helper, not an exported entry in the normal app. Never commit that input or
print credentials. Remove the test APK after testing.

Manual acceptance IDs AND-01…AND-05 are tracked in `docs/todos.md`; automated
checks do not mark user acceptance passed. Final wireless acceptance requires
physically unplugging USB and performing actual Codas operations.
