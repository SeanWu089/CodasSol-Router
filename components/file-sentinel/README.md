# CodasSol File Sentinel

Optional, standalone, **user-scoped** file-integrity evidence collector for Windows.
Does not call network services, require administrator privileges, bypass security
software, or repair files. Intended to record unexpected changes to installed
CodasSol scripts, **not** to identify which process made a change.

## Install / uninstall

From the component's \`windows\` folder in a PowerShell session:

\`\`\`powershell
.\install.ps1
\`\`\`

Or monitor another application by passing permitted absolute paths:

\`\`\`powershell
.\install.ps1 -Roots @('C:\MyApp\bin','D:\Applications\Example')
\`\`\`

Remove its owned scheduled task without deleting logs:

\`\`\`powershell
.\install.ps1 -Uninstall
\`\`\`

Manual verification without persistence:

\`\`\`powershell
.\watch.ps1 -Once
\`\`\`

Logs are under \`%LOCALAPPDATA%\CodasSol\Diagnostics\FileSentinel\`:
\`changes-YYYY-MM-DD.md\`, \`events.jsonl\`, and \`baseline.json\`.
The default watched roots are the extracted Windows Outbound SSE package and
the independent Windows Node's \`app\` and \`runtime\` subfolders. Paths that
are missing at start are recorded, not created.

The installed watcher monitors with FileSystemWatcher and resamples SHA-256
every ten seconds. It logs the complete path and hash, **not file contents**.
Event timing is approximate; transient changes between samples may not have
before/after hashes. FileSystemWatcher does not identify the modifying process.
For attribution, export endpoint security history or obtain administrator
approval for appropriately scoped Windows File System auditing / Sysmon.
Never disable enterprise protections or automatically restore suspicious files.

Autostart is scoped to the signed-in user, with a Scheduled Task (or Startup
shortcut only if Task Scheduler registration is denied). The prior known
\`CodasSol File Sentinel\` task layout is recognized without modifying the
Router/DevSpace/SSE tasks.
