<#
  Independently reusable, per-user File Sentinel installer.
  With no -Roots, it watches the default CodasSol Windows runtime.
  Does not stop SSE, Router, DevSpace, antivirus, or touch security settings.
#>
param(
  [string[]]$Roots = @(),
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$taskName = 'CodasSol File Sentinel'
$dir = Join-Path $env:LOCALAPPDATA 'CodasSol\Diagnostics'
$script = Join-Path $dir 'watch-codassol-files.ps1'
$source = Join-Path $PSScriptRoot 'watch.ps1'
$executable = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoLogo -NoProfile -WindowStyle Hidden -File "' + $script + '"'
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'CodasSol File Sentinel.lnk'
$oldTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$owned = $oldTask -and $oldTask.Actions.Count -eq 1 -and
  $oldTask.Actions[0].Arguments -eq $arguments -and
  $oldTask.Actions[0].Execute -eq $executable
if ($oldTask -and -not $owned) { throw 'Existing task ownership differs; refusing to modify it.' }

if ($Uninstall) {
  if ($oldTask) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  if (Test-Path -LiteralPath $startupLink) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($startupLink)
    if ($link.TargetPath -ne $executable -or $link.Arguments -ne $arguments) {
      throw 'Startup link ownership mismatch; refusing to remove it.'
    }
    Remove-Item -LiteralPath $startupLink
  }
  Write-Host ('Sentinel autostart removed. Existing logs preserved at ' + (Join-Path $dir 'FileSentinel'))
  exit 0
}

if (-not (Test-Path -LiteralPath $source)) { throw 'Bundled watcher missing' }
New-Item -Path $dir -ItemType Directory -Force | Out-Null
if ($Roots.Count -gt 0) {
  foreach ($root in $Roots) {
    if (-not [IO.Path]::IsPathRooted($root)) { throw ('Root must be absolute: ' + $root) }
  }
  @{ roots = @($Roots) } | ConvertTo-Json -Depth 3 |
    Set-Content -LiteralPath (Join-Path $dir 'sentinel-roots.json') -Encoding UTF8
}
if (Test-Path -LiteralPath $script) {
  if ((Get-FileHash -LiteralPath $script).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
    Copy-Item -LiteralPath $script -Destination ($script + '.backup-' + (Get-Date -Format yyyyMMdd-HHmmss))
  }
}
Copy-Item -LiteralPath $source -Destination $script -Force
& $executable -NoProfile -File $script -Once
if ($LASTEXITCODE -ne 0) { throw 'Initial checksum scan failed' }

if ($oldTask) {
  if ($oldTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName }
  Start-ScheduledTask -TaskName $taskName
  Write-Host 'Updated and restarted previously owned File Sentinel task.'
} else {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $dir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Read-only, user-approved file-integrity evidence collector' -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Installed user-scoped File Sentinel scheduled task.'
  } catch {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw }
    # Fallback only for the current account, never machine-wide autoruns.
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $startupLink) {
      $existingLink = $shell.CreateShortcut($startupLink)
      if ($existingLink.TargetPath -ne $executable -or $existingLink.Arguments -ne $arguments) {
        throw 'Existing Startup shortcut ownership differs; refusing to overwrite it.'
      }
    }
    $link = $shell.CreateShortcut($startupLink)
    $link.TargetPath = $executable
    $link.Arguments = $arguments
    $link.WorkingDirectory = $dir
    $link.Description = 'Read-only CodasSol File Sentinel'
    $link.Save()
    Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden
    Write-Host 'Task Scheduler denied registration; installed current-user Startup shortcut.'
  }
}
Write-Host ('Logs: ' + (Join-Path $dir 'FileSentinel'))
