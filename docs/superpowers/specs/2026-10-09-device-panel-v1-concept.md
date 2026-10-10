# CodasSol Device Panel — cross-platform UX concept

## Goal

Present one consistent, Tailscale-style device switcher on macOS (menu bar),
Windows (system tray), Android (app/quick access) and later iOS (app/widget).
The icon is a lightweight entry point, not a replacement for DevSpace, and the
menu must distinguish registration, connectivity and ability to execute.

## Navigation and layout

Opening the icon immediately shows the **local device** pinned first. Beneath
it, show **Other Devices** with all known devices, including offline ones.
Inside each section sort by status (online / degraded / offline / unknown) and
then alphabetical display name. No hidden devices just because they are
offline. A stale or unknown status must never be rendered as online.

The default view is a small native panel, not a full app window:

```text
  CodasSol                          ↻
  YOUR DEVICE
  ● Sean's Mac                       Connected ›

  OTHER DEVICES
  ● Home GPU                         Online    ›
  ● Office Windows                   Degraded  ›
  ○ RedMagic                         Offline   ›

  Last synchronized 9 seconds ago
  Preferences · Sign out
```

Clicking any row opens device detail in the same panel. Show device name and
rename affordance; platform and immutable installation ID (copyable); last
known online time; Router reachability and backend reachability. For the local
device additionally show DevSpace lifecycle (managed/externally started),
current Router state, start/stop/restart controls, diagnosis/log shortcut.
For a remote device, don't show dangerous actions if the execution permission
has not been explicitly granted; rename permission does not imply terminal or
filesystem access.

## Data and UX safety

- Model: Device Catalog v1 + current Router presence; never use a hostname
  or user-editable label as identity.
- Local changes appear immediately and persist before a success indication.
  Include a small synchronization state (e.g. “Saved locally · syncing peers”)
  when recipients are offline; no false promise of global instant agreement.
- Client pairing must use a dedicated permission grant/token stored in
  Keychain/Windows Credential Manager/Android Keystore/iOS Keychain, and must
  not copy Router peer tokens or unrestricted DevSpace OAuth to the UI.
- For responsiveness: authenticated push/SSE when the node supports it,
  periodic foreground refresh as fallback, and proactive refresh on panel open.
  Current Registry v1 backend implements snapshot polling and peer pushes;
  client event streaming/pairing remain future implementation work.
- When any Router goes offline, the panel retains its last-known record with a
  timestamp and makes clear whether state is **offline** vs **unknown**.
- Device color/brand: retain the original blue app icon; use the user's
  black-and-white Sean artwork only for the macOS menu-bar icon.

## Rollout (not yet implemented)

1. Mac menu v1 list/detail/rename using the Registry v1 API; validate network
   status and error handling locally before changing live Router versions.
2. Windows tray and Android app reuse the same schema, with secure pairing.
3. Implement full UI state-stream subscriptions, multi-device onboarding,
   iOS experience, and explicit removal/revocation with tombstones.

The current document is a product design concept, not a claim that the
cross-platform device switcher is already installed.
