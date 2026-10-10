# CodasSol Mobile Android V0 Design

## Goal

Build a lightweight native Android control client for CodasSol that runs on the user's RedMagic phone and talks to the existing CodasSol Router.

The mobile app is a **control surface**, not an execution node. DevSpace, Node.js, workspace access, and code execution remain on Mac/Windows machines.

## Product principle

**Route the Project, Not Devices.**

The phone should be able to issue requests and inspect Router status without knowing which physical computer ultimately owns a workspace.

## V0 scope

V0 intentionally does only the minimum needed to prove the mobile path end to end:

1. Launch a native Android app.
2. Connect to CodasSol Router.
3. Call `GET /_codassol/health`.
4. Display:
   - Router connection state;
   - Router/backend reachability;
   - active endpoint;
   - last successful check time.
5. Allow manual retry.
6. Correctly transition to disconnected/error state when Router is unavailable.

## Architecture

- Native Android application.
- Kotlin.
- Traditional Android Views/XML to minimize dependencies and binary size.
- No Flutter.
- No Compose.
- No embedded Node.js or DevSpace.
- No Android Studio requirement.
- Gradle wrapper + Android SDK command-line build.
- Direct physical-device testing on the RedMagic phone.

## Development transport

For the first real-device test, USB debugging plus Android Debug Bridge is used.

The Mac keeps CodasSol Router on loopback. During USB testing:

```
adb reverse tcp:17676 tcp:17676
```

The Android app then reaches the Mac Router through:

```
http://127.0.0.1:17676
```

This avoids exposing the Router to the LAN merely for development.

## Security boundary

V0 health probing requires no new mobile credential and does not expose DevSpace credentials.

Future authenticated mobile actions must use a dedicated mobile-control credential or approval flow. The Agent pairing token and per-device Agent token must not be reused as a general mobile-client credential.

## Package layout

The Android application lives under:

```
mobile/android/
```

This keeps the Router implementation and mobile client in one repository while preserving a clean platform boundary.

## Error handling

The app must distinguish at least:

- Router reachable + backend reachable;
- Router reachable + backend unavailable;
- Router unreachable;
- malformed/unexpected Router response.

Network operations must never block the UI thread.

## Verification

V0 is considered proven only when all of the following pass on the physical RedMagic device:

1. macOS detects the phone over USB.
2. `adb devices` reports it as authorized.
3. Debug APK builds successfully.
4. APK installs through ADB.
5. App launches through ADB.
6. USB reverse tunnel is active.
7. App receives a valid CodasSol health response.
8. App shows Connected when healthy.
9. Stopping/removing Router connectivity causes the app to show Disconnected/Error.
10. Restoring connectivity and retrying returns to Connected.

## Explicit non-goals for V0

- Running DevSpace on Android.
- Remote filesystem browsing.
- Shell/terminal UI.
- Project routing UI.
- Push notifications.
- Approval workflows.
- iOS.
- Internet-facing Router exposure.
- Background service.

Those belong to later iterations after the physical Android connectivity path is proven.
