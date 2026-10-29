# Acceptance checklist


## Windows standalone rc.1 (local qualification only)
- Integrates standalone packaging/supervision with the current develop SSE lease and exact stream replacement protocol. Source-only previews were consolidated without importing private deployment history.
- Adds bounded stream idle timeouts, stale-heartbeat isolation, duplicate/expired job suppression, explicit HTTPS enrollment origins and singleton supervisors.
- Removes the personal legacy rootless-drive routing exception; explicit device selection and backend allowedRoots remain required.
- Transaction installer keeps private local rollback snapshots; identity/OAuth/session-generation state is never rewound.
- Local qualification: 118 Node checks and 26 Python helper checks on the preceding candidate; rerun Node checks after privacy cleanup. This does not establish Windows execution.
- WIN-01 pending: PowerShell 5.1 parsing, fresh install and authenticated local execution.
- WIN-02 pending: upgrade/failure injection and rollback, including file locks and task restoration.
- WIN-03 pending: reboot, disconnect/reconnect, sleep/wake and real remote execution.
- WIN-04 pending: reversible owned-task disable/uninstall and restore.
- Requires network access to install DevSpace 1.1.0-beta.4. No unattended deployment; no stable claim.


## rc.1 recovery repair — local draft
- Installation health now records only whitelisted status fields and exception type, probing Router and DevSpace independently. Initial backend failure cause remains unknown pending device evidence.
- Recovery validates exact task action, user SID, private Node executable and permitted service command before stopping; disables owned tasks to prevent restart, waits for remaining owned processes, and aborts on ambiguous ownership.
- Verified snapshots, flushed phase journal and same-parent Directory.Move replace recursive Move-Item. Failed renames preserve candidate/backup/staging; unfinished transactions block blind reinstallation. Identity, OAuth and generation ledgers are never restored backward.
- Added DIAGNOSE.cmd for read-only metadata/error-marker collection, omitting command lines, raw logs and credentials.
- Local Node tests: 118 passed. Windows fault-injection tests authored for CI, NOT executed yet (no local PowerShell). No rc.2 publication or physical repair performed.

## Isolated clean reinstall candidate
- Fresh NodeCleanR1 uses private DevSpace config/auth/storage and node state. Legacy owned tasks are verified and disabled; inaccessible runtime remains preserved. Shared configuration and user projects are not deleted or reused.
- Explicit CLEAN, INIT and optional PAIR gates; bounded worker operations, visible progress, sanitized health checks, exact authenticated identity verification.
- Windows automated isolation/fault tests added; physical clean install, backend startup, pairing, reboot and sleep acceptance remain pending. No claim that the original backend failure is diagnosed.
