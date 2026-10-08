param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot
)

$ErrorActionPreference = "Stop"

$NodeExe = Join-Path $InstallRoot "node\node.exe"
$AgentScript = Join-Path $InstallRoot "app\agent.js"
$StartDevSpace = Join-Path $InstallRoot "runtime\start-devspace.ps1"
$StartRouter = Join-Path $InstallRoot "runtime\start-router.ps1"
$AgentConfig = Join-Path $env:USERPROFILE ".codassol\agent.json"

foreach ($path in @($NodeExe, $AgentScript, $StartDevSpace, $StartRouter)) {
  if (-not (Test-Path $path)) { throw "Autostart prerequisite is missing: $path" }
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$devspaceAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $StartDevSpace + '"')
$agentAction = New-ScheduledTaskAction -Execute $NodeExe -Argument ('"' + $AgentScript + '" run') -WorkingDirectory (Join-Path $InstallRoot "app")
$routerAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $StartRouter + '"')

Register-ScheduledTask -TaskName "CodasSol DevSpace" -Action $devspaceAction -Trigger $trigger -Settings $settings -Description "Run the private DevSpace backend for CodasSol on this PC." -Force | Out-Null
Register-ScheduledTask -TaskName "CodasSol Router" -Action $routerAction -Trigger $trigger -Settings $settings -Description "Run a local independent CodasSol Router on this PC." -Force | Out-Null
if (Test-Path $AgentConfig) {
  Register-ScheduledTask -TaskName "CodasSol Agent" -Action $agentAction -Trigger $trigger -Settings $settings -Description "Connect this PC to a remote CodasSol Router." -Force | Out-Null
}

Start-ScheduledTask -TaskName "CodasSol DevSpace"
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "CodasSol Router"
if (Test-Path $AgentConfig) { Start-ScheduledTask -TaskName "CodasSol Agent" }

Write-Host "Autostart tasks installed and started."
