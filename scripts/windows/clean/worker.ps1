param([string]$Encoded)
$ErrorActionPreference='Stop'
$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded))|ConvertFrom-Json
. (Join-Path $PSScriptRoot 'recovery-support.ps1')
switch($a.mode){
 'inspect' {foreach($mode in @('DevSpace','Router','Outbound')){if(Get-ScheduledTask -TaskName ('CodasSol Clean R1 '+$mode) -TaskPath '\' -ErrorAction SilentlyContinue){throw 'NEW_TASK_NAME_ALREADY_EXISTS'}};foreach($n in $a.names){$t=Get-ScheduledTask -TaskName $n -TaskPath '\' -ErrorAction SilentlyContinue;if($t){Assert-RuntimeTask $t $a.root $a.owner}};foreach($p in (Get-RuntimeProcesses $a.root)){Assert-RuntimeProcess $p $a.root $a.owner};Write-Host 'PASS: old tasks/processes are absent or strictly owned.'}
 'stop' {Stop-OwnedRuntime $a.root $a.names $a.owner;Write-Host 'PASS: owned old runtime quiesced.'}
 'ports' {foreach($port in @(7676,17678,17679,17680,17681)){if(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue){throw "PORT_OCCUPIED_$port"}};Write-Host 'PASS: private service ports are free.'}
 'stage' {
  $payload=Join-Path $a.modes[0] 'payload'
  foreach($part in @('node','app','runtime')){Write-Host "Copying $part";Copy-Item -LiteralPath (Join-Path $payload $part) -Destination $a.root -Recurse}
 }
 'tasks' {
  $node=Join-Path $a.root 'node\node.exe';$script=Join-Path $a.root 'runtime\supervisor.mjs'
  $settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  foreach($mode in $a.modes){$name='CodasSol Clean R1 '+$mode;if(Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue){throw 'NEW_TASK_NAME_ALREADY_EXISTS'};$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+$script+'" '+$mode.ToLower()) -WorkingDirectory $a.root;Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -Description 'CodasSol clean isolated runtime' | Out-Null;Start-ScheduledTask -TaskName $name -TaskPath '\';Write-Host "Started $name"}
 }
 default {throw 'UNKNOWN_WORKER_MODE'}
}
