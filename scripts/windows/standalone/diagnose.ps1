# Read-only collector. No process termination, task changes, writes or credential reads.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'health-diagnostics.ps1')
$base = Join-Path $env:LOCALAPPDATA 'CodasSol'
$root = Join-Path $base 'NodeV02Standalone'
$names = @('CodasSol Standalone V02 DevSpace','CodasSol Standalone V02 Router','CodasSol Standalone V02 Outbound')
$tasks = @(); foreach ($name in $names) {
    $t = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    $tasks += [pscustomobject]@{name=$name; present=[bool]$t; state=([string]$t.State)}
}
$processes = @(); $hidden = 0
foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
    if (-not $p.ExecutablePath) {$hidden++; continue}
    if ($p.ExecutablePath.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) {
        $processes += [pscustomobject]@{pid=$p.ProcessId; parentPid=$p.ParentProcessId; executable=$p.ExecutablePath; created=$p.CreationDate}
    }
}
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in @(7676,17678,17679,17680,17681)} | Select-Object LocalAddress,LocalPort,OwningProcess)
$backups = @(); $logRoots = @((Join-Path $root 'logs'))
foreach ($b in (Get-ChildItem (Join-Path $base 'Backups') -Directory -Filter 'candidate-*' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
    $status='MISSING'; if (Test-Path (Join-Path $b.FullName 'status')) {
        $raw=(Get-Content (Join-Path $b.FullName 'status') -Raw).Trim()
        $status=if($raw -match '^[A-Z_]{1,50}$'){$raw}else{'UNRECOGNIZED'}
    }
    $entries=@(); foreach($n in @('runtime','failed-runtime','state','tasks.json','config.jsonc','journal.jsonl')) {$entries += @{name=$n; exists=(Test-Path (Join-Path $b.FullName $n))}}
    $backups += @{name=$b.Name; status=$status; entries=$entries}
    $logRoots += (Join-Path $b.FullName 'failed-runtime\logs')
}
$logs=@(); foreach($dir in $logRoots) {
    foreach($f in (Get-ChildItem -LiteralPath $dir -File -Filter '*.log' -ErrorAction SilentlyContinue)) {
        $tail=(Get-Content -LiteralPath $f.FullName -Tail 80)-join "`n"
        $markers=@([regex]::Matches($tail,'ERR_[A-Z_]+|EADDRINUSE|EACCES|EPERM|ENOENT|EEXIST|MODULE_NOT_FOUND|SyntaxError|TypeError|Invalid session generation ledger|Missing Node or DevSpace CLI|Missing or invalid identity|spawn failed|exited [0-9]+') | ForEach-Object {$_.Value} | Select-Object -Unique)
        $logs += @{file=$f.Name; modified=$f.LastWriteTimeUtc; bytes=$f.Length; errors=$markers}
    }
}
$required=@(); foreach($n in @('node\node.exe','app\server.js','devspace\node_modules\@waishnav\devspace\dist\cli.js','devspace\node_modules\@waishnav\devspace\dist\process-sessions.js','runtime\supervisor.mjs')) {$required+=@{file=$n; exists=(Test-Path (Join-Path $root $n))}}
@{version=1; hostName=[Environment]::MachineName; tasks=$tasks; runtimeProcesses=$processes; nodeProcessesWithUnreadablePath=$hidden; listeners=$ports; health=@((Get-SafeHealth 'devspace' 'http://127.0.0.1:7676/healthz'),(Get-SafeHealth 'router' 'http://127.0.0.1:17678/_codassol/health')); requiredFiles=$required; backups=$backups; logErrorMarkers=$logs; note='Empty process list does not prove no open directory handles. Raw logs, command lines, task XML and credentials are omitted.'} | ConvertTo-Json -Depth 8
