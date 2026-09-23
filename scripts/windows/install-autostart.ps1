param(
  [string]$RepoDir = (Join-Path $env:USERPROFILE "CodasSol-Router")
)

$ErrorActionPreference = "Stop"
$TaskName = "CodasSol Agent"
$Node = (Get-Command node -ErrorAction Stop).Source
$AgentScript = Join-Path $RepoDir "src\agent.js"

if (-not (Test-Path $AgentScript)) {
  throw "CodasSol-Router was not found at $RepoDir"
}

$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $AgentScript + '" run') -WorkingDirectory $RepoDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Connect this computer to CodasSol Router." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "CodasSol Agent autostart task installed and started."

