# Interactive rescue. Preflight is read-only; mutations require typing RESTORE.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'recovery-support.ps1')
. (Join-Path $PSScriptRoot 'health-diagnostics.ps1')
$base=Join-Path $env:LOCALAPPDATA 'CodasSol'
$root=Join-Path $base 'NodeV02Standalone'
$names=@('CodasSol Standalone V02 DevSpace','CodasSol Standalone V02 Router','CodasSol Standalone V02 Outbound')
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$handle=$null;$session=$null
try {
    $candidates=@(Get-ChildItem (Join-Path $base 'Backups') -Directory -Filter 'candidate-*' | Where-Object {(Test-Path (Join-Path $_.FullName 'status')) -and (Get-Content (Join-Path $_.FullName 'status') -Raw).Trim() -eq 'PREPARED'})
    if($candidates.Count -ne 1){throw 'Expected exactly one PREPARED backup; manual selection required.'}
    $backup=$candidates[0].FullName;$snapshot=Join-Path $backup 'runtime'
    Assert-NoReparseTree $snapshot
    foreach($file in @('node\node.exe','app\server.js','runtime\supervisor.mjs','runtime\devspace-session-preload.mjs','runtime\session-generations.mjs','devspace\node_modules\@waishnav\devspace\dist\cli.js','devspace\node_modules\@waishnav\devspace\dist\process-sessions.js')) {
        if(-not (Test-Path -LiteralPath (Join-Path $snapshot $file) -PathType Leaf)){throw 'Required old runtime file missing; refusing restore.'}
    }
    $taskFile=Join-Path $backup 'tasks.json'
    if(-not (Test-Path $taskFile)){throw 'Original task definitions missing.'}
    $records=@(Get-Content $taskFile -Raw | ConvertFrom-Json)
    if($records.Count -eq 0){throw 'No previous tasks were saved. Restoring files cannot restore a previous connection.'}
    # XML is data only. Do not register any definition until validated.
    foreach($record in $records) {
        if($record.name -notin $names){throw 'Unexpected saved task name.'}
        $xml=New-Object System.Xml.XmlDocument;$xml.XmlResolver=$null;$xml.LoadXml($record.xml)
        if($xml.DocumentType){throw 'Task XML DTD not permitted.'}
        $ns=New-Object System.Xml.XmlNamespaceManager($xml.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
        $exec=@($xml.SelectNodes('/t:Task/t:Actions/*',$ns))
        $sidNode=$xml.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId',$ns)
        if($exec.Count -ne 1 -or $exec[0].LocalName -ne 'Exec' -or -not $sidNode){throw 'Unsupported saved task definition.'}
        $principal=$sidNode.InnerText
        if($principal -ne $owner){$principal=(New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value}
        $fake=[pscustomobject]@{TaskName=$record.name;TaskPath='\';Principal=[pscustomobject]@{UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name};Actions=@([pscustomobject]@{Execute=$exec[0].Command;Arguments=$exec[0].Arguments})}
        if($principal -ne $owner){throw 'Saved task belongs to another user.'}
        Assert-RuntimeTask $fake $root $owner
    }
    foreach($name in $names){$t=Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue;if($t){Assert-RuntimeTask $t $root $owner}}
    $processes=@(Get-RuntimeProcesses $root);foreach($p in $processes){Assert-RuntimeProcess $p $root $owner}
    $dv=Get-SafeHealth 'devspace' 'http://127.0.0.1:7676/healthz';$rv=Get-SafeHealth 'router' 'http://127.0.0.1:17678/_codassol/health'
    if($dv.ok -and $dv.serviceMatches -and $rv.ok -and $rv.backendReachable){throw 'Local services are healthy now. No restore performed; remote connection needs separate verification.'}
    Write-Host "Backup: $backup"
    Write-Host "Stop/disable only owned tasks: $($names -join ', ')"
    Write-Host "Verified runtime process IDs: $(($processes|ForEach-Object {$_.ProcessId}) -join ', ')"
    Write-Host "Restore runtime to: $root; restore the saved owned tasks. Current runtime will be preserved beside it."
    Write-Host 'Authentication, configuration, roots, identity and generation state will NOT be overwritten.'
    Write-Host 'Required files passed checks; the old backup has no original completeness manifest. Connectivity is not guaranteed.'
    if((Read-Host 'Type RESTORE to authorize the displayed changes; anything else cancels') -cne 'RESTORE'){Write-Host 'Cancelled without changes.';return}
    $handle=[IO.File]::Open((Join-Path $base 'standalone-install.lock'),'OpenOrCreate','ReadWrite','None')
    $session=Join-Path $base ('Backups\rescue-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $session | Out-Null
    Write-RecoveryJournal $session 'QUIESCING' @{source=$backup}
    Stop-OwnedRuntime $root $names $owner
    Switch-RuntimeForRollback $root $session -Snapshot $snapshot
    Write-RecoveryJournal $session 'RESTORING_TASKS'
    foreach($record in $records){Register-ScheduledTask -TaskName $record.name -TaskPath '\' -Xml $record.xml -Force | Out-Null}
    foreach($record in $records){if($record.running){Start-ScheduledTask -TaskName $record.name -TaskPath '\'}}
    Write-RecoveryJournal $session 'RESTORED_UNVERIFIED'
    Write-Host 'Old runtime/tasks restored. Remote connectivity is NOT yet verified.'
} catch {
    if($session){Write-RecoveryJournal $session 'RESCUE_BLOCKED' @{errorType=$_.Exception.GetType().Name}}
    Write-Host ('Stopped safely: '+$_.Exception.Message) -ForegroundColor Red
    Write-Host 'Preserve the original backup, runtime and all sibling .restore-/.failed- directories.'
    exit 1
} finally {if($handle){$handle.Dispose()}}
