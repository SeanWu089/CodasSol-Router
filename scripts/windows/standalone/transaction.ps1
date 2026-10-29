param([string]$Roots = '', [string]$RouterUrl = '', [switch]$LocalOnly,
      [switch]$SkipSentinelPrompt, [switch]$InstallFileSentinel)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'recovery-support.ps1')
$base = Join-Path $env:LOCALAPPDATA 'CodasSol'
$root = Join-Path $base 'NodeV02Standalone'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$config = Join-Path $env:USERPROFILE '.devspace\config.jsonc'
$tasks = @('CodasSol Standalone V02 DevSpace','CodasSol Standalone V02 Router','CodasSol Standalone V02 Outbound')
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($InstallFileSentinel) {throw 'Install optional Sentinel separately after candidate acceptance.'}
New-Item -ItemType Directory -Force $base | Out-Null
Assert-NoReparseTree $root
$handle = [IO.File]::Open((Join-Path $base 'standalone-install.lock'),'OpenOrCreate','ReadWrite','None')
$backup = $null
try {
    # Unfinished or legacy PREPARED attempts require inspection, never another blind reinstall.
    foreach ($previous in (Get-ChildItem (Join-Path $base 'Backups') -Directory -Filter 'candidate-*' -ErrorAction SilentlyContinue)) {
        $status = Join-Path $previous.FullName 'status'
        if (-not (Test-Path $status) -or (Get-Content $status -Raw).Trim() -notin @('VERIFIED_LOCAL','ROLLED_BACK')) {throw 'INCOMPLETE_PRIOR_TRANSACTION_REQUIRES_REVIEW'}
    }
    $backup = Join-Path $base ('Backups\candidate-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    $records = @()
    foreach ($name in $tasks) {
        $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
        if ($task) {Assert-RuntimeTask $task $root $owner; $records += @{name=$name; running=($task.State -eq 'Running'); xml=(Export-ScheduledTask -TaskName $name -TaskPath '\')}}
    }
    ConvertTo-Json -InputObject $records -Depth 8 | Set-Content (Join-Path $backup 'tasks.json') -Encoding UTF8
    Write-RecoveryJournal $backup 'QUIESCING'
    Stop-OwnedRuntime $root $tasks $owner
    Write-RecoveryJournal $backup 'QUIESCED'
    foreach ($entry in @(@($root,'runtime'),@($state,'state'))) {
        if (Test-Path -LiteralPath $entry[0]) {Copy-VerifiedTree $entry[0] (Join-Path $backup $entry[1])}
    }
    if (Test-Path -LiteralPath $config) {Copy-Item -LiteralPath $config -Destination (Join-Path $backup 'config.jsonc')}
    Write-RecoveryJournal $backup 'PREPARED'
    try {
        Write-RecoveryJournal $backup 'INSTALLING'
        $arguments = @('-NoLogo','-NoProfile','-File',(Join-Path $PSScriptRoot 'install.ps1'),'-TransactionManaged')
        if ($Roots) {$arguments += @('-Roots',$Roots)}
        if ($RouterUrl) {$arguments += @('-RouterUrl',$RouterUrl)}
        if ($LocalOnly) {$arguments += '-LocalOnly'}
        $arguments += '-SkipSentinelPrompt'
        & powershell.exe @arguments
        if ($LASTEXITCODE -ne 0) {throw 'INSTALLER_FAILED'}
        Write-RecoveryJournal $backup 'VERIFIED_LOCAL'
        Write-Host "Private recovery snapshot: $backup"
    } catch {
        Write-RecoveryJournal $backup 'ROLLBACK_QUIESCING'
        try {
            Stop-OwnedRuntime $root $tasks $owner
            Switch-RuntimeForRollback $root $backup
            # Never rewind identity, tokens, OAuth or monotonic generation ledgers.
            $oldRoots = Join-Path $backup 'state\roots.txt'
            if (Test-Path $oldRoots) {Copy-Item -LiteralPath $oldRoots -Destination (Join-Path $state 'roots.txt') -Force}
            if (Test-Path (Join-Path $backup 'config.jsonc')) {Copy-Item -LiteralPath (Join-Path $backup 'config.jsonc') -Destination $config -Force}
            Write-RecoveryJournal $backup 'RESTORING_TASKS'
            foreach ($name in $tasks) {
                $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
                if ($task) {Assert-RuntimeTask $task $root $owner; Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false}
            }
            foreach ($record in $records) {Register-ScheduledTask -TaskName $record.name -TaskPath '\' -Xml $record.xml -Force | Out-Null}
            foreach ($record in $records) {if ($record.running) {Start-ScheduledTask -TaskName $record.name -TaskPath '\'}}
            Write-RecoveryJournal $backup 'ROLLED_BACK'
        } catch {
            Write-RecoveryJournal $backup 'ROLLBACK_BLOCKED' @{errorType=$_.Exception.GetType().Name}
            throw "ROLLBACK_BLOCKED. Preserve runtime and sibling .restore-/.failed- directories. Private journal: $backup"
        }
        throw "INSTALLER_FAILED_ROLLBACK_COMPLETE. Inspect health-diagnostic.json in the preserved runtime logs. Snapshot: $backup"
    }
} finally {$handle.Dispose()}
