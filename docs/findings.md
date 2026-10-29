# Findings


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
