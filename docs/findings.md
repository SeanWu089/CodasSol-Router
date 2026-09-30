# Findings

- 2026-09-30 — The first Windows bundle could enroll successfully while an existing DevSpace configuration still enforced different `allowedRoots`. The first real Mac -> Router -> Windows `open_workspace` test exposed the mismatch because DevSpace correctly failed closed.
- 2026-09-30 — DevSpace permission roots and Router-advertised Agent roots are one logical policy and must stay synchronized.
- 2026-09-30 — Successful enrollment is not sufficient end-to-end proof. Verification should include a remote `open_workspace` and a follow-up operation on the returned workspace.
- 2026-09-30 — The original public packager auto-detected the build Mac's LAN IP and embedded it in `router-default.txt`. It was not a credential, but it violated the repository's deployment-boundary policy. `v0.1.2` makes public bundles address-free by default.
- 2026-09-30 — Release verification should also scan installer text/examples
  for test-machine-looking identifiers; v0.1.3 replaces those with neutral
  placeholders.
- 2026-09-30 — A live end-to-end test routed from the Mac Router into a Windows Desktop workspace and moved `SuYou.lnk` to the Windows Recycle Bin.
