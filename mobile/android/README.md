# CodasSol Mobile — Android V0

**Route the Project, Not Devices.**

Lightweight native Android control client that checks the CodasSol Router and its local DevSpace backend. The mobile client does not execute commands, host DevSpace, or store Router/Agent pairing credentials.

## Build (macOS, no Android Studio)

Requires JDK 17, Android SDK platform 35, build-tools 35.0.0, and Android platform-tools (`adb`). Set `JAVA_HOME` and `ANDROID_HOME` to the existing installations.

```sh
cd mobile/android
./gradlew :app:assembleDebug
```

Debug APK: `app/build/outputs/apk/debug/app-debug.apk`.

Only debug builds allow cleartext HTTP to loopback. Production connectivity must use authenticated HTTPS and a separate mobile-control credential; the Agent pairing token is not an app credential.

## Test on a physical Android phone

Enable USB debugging and **USB installation permission (if the manufacturer requires it)** on the phone, and accept the computer's debugging authorization.

```sh
adb devices -l
adb reverse tcp:17676 tcp:17676
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.codassol.mobile/.MainActivity
```

The Router must be listening locally on the Mac at `127.0.0.1:17676`. The Android app uses the USB reverse tunnel to reach `http://127.0.0.1:17676/_codassol/health` without exposing the Router to the LAN.

On some RedMagic/nubia firmware versions `adb shell pm install-create` may report an invalid session ID `[-1]`; then `adb install` reports `Caller has no access to session -1`. This blocks automated ADB installation, **not** the APK build or USB transfer. Check the phone's USB installation permission or open the APK from the device's Downloads folder using its own file manager and approve installation locally.

Confirmed on RedMagic 11 Pro, Android 16: enabling the phone's USB installation permission and rerunning `adb install -r` resolved this specific error. The installed app was verified to display `Connected / Reachable`; manually disabling the USB reverse tunnel produced `Disconnected / Unavailable`, and restoring it then retrying produced `Connected / Reachable`.

The app displays Router **Connected/Disconnected**, execution backend **Reachable/Unavailable**, and the last check result. A failed or missing Router response is not counted as a successful connection.

## V0 boundaries

- Android only; Kotlin + platform Views, no Compose/Flutter.
- No Android Studio or emulator needed.
- No file access, background agent, command execution, or shell UI.
- For USB physical-device verification only; not yet a remotely usable secure mobile control plane.
