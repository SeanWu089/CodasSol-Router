$ErrorActionPreference = "Stop"

$InstallRoot = Join-Path $env:LOCALAPPDATA "CodasSol\Agent"
$NodeExe = Join-Path $InstallRoot "node\node.exe"
$DevSpaceDir = Join-Path $InstallRoot "devspace"
$ConfigPath = Join-Path $env:USERPROFILE ".devspace\config.jsonc"
$AgentConfigPath = Join-Path $env:USERPROFILE ".codassol\agent.json"
$Helper = Join-Path $PSScriptRoot "configure-devspace-root.mjs"

foreach ($path in @($NodeExe, $DevSpaceDir, $ConfigPath, $AgentConfigPath, $Helper)) {
  if (-not (Test-Path $path)) { throw "Required file is missing: $path" }
}

function Get-FixedNonSystemDrives {
  try {
    return @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
      Where-Object { $_.DeviceID -and $_.DeviceID -ne $env:SystemDrive } |
      ForEach-Object { "$($_.DeviceID)\" })
  } catch {
    return @(Get-PSDrive -PSProvider FileSystem |
      Where-Object {
        $_.Root -and
        $_.Root -match '^[A-Za-z]:\\$' -and
        -not $_.Root.StartsWith($env:SystemDrive, [System.StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { $_.Root })
  }
}

function Get-AccessRoots {
  $otherDrives = @(Get-FixedNonSystemDrives | Sort-Object -Unique)
  Write-Host ""
  Write-Host "Choose CodasSol workspace access:" -ForegroundColor Cyan
  Write-Host "  1. User profile only: $env:USERPROFILE"
  Write-Host "  2. RECOMMENDED: user profile + all fixed non-system drives"
  Write-Host "  3. All fixed non-system drives only (do not expose C: user profile)"
  Write-Host "  4. Custom roots"
  if ($otherDrives.Count -gt 0) {
    Write-Host "     Fixed non-system drives detected: $($otherDrives -join ', ')"
  } else {
    Write-Host "     No fixed non-system drives detected."
  }
  Write-Host ""
  $choice = (Read-Host "Choice [2]").Trim()
  if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "2" }

  switch ($choice) {
    "1" { return @($env:USERPROFILE) }
    "2" { return @($env:USERPROFILE) + $otherDrives }
    "3" {
      if ($otherDrives.Count -eq 0) { throw "No fixed non-system drives were detected." }
      return $otherDrives
    }
    "4" {
      $custom = (Read-Host "Enter roots separated by | (example C:\Users\USER|D:\|E:\PROJECTS)").Trim()
      $roots = @($custom.Split("|") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($roots.Count -eq 0) { throw "At least one root is required." }
      return $roots
    }
    default { throw "Unknown choice: $choice" }
  }
}

$Roots = @(Get-AccessRoots)
$RootsArg = $Roots -join "|"

Write-Host ""
Write-Host "Applying allowed roots:" -ForegroundColor Cyan
$Roots | ForEach-Object { Write-Host "  $_" }

& $NodeExe $Helper $DevSpaceDir $ConfigPath $RootsArg $AgentConfigPath
if ($LASTEXITCODE -ne 0) { throw "Unable to update CodasSol/DevSpace roots." }

Write-Host ""
Write-Host "Restarting CodasSol services ..."
Stop-ScheduledTask -TaskName "CodasSol Agent" -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName "CodasSol DevSpace" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$portOwner = Get-NetTCPConnection -LocalPort 7676 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($portOwner) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($portOwner.OwningProcess)" -ErrorAction SilentlyContinue
  $commandLine = [string]$process.CommandLine
  if ($commandLine -like "*CodasSol\Agent*" -or $commandLine -like "*@waishnav\devspace*") {
    Stop-Process -Id $portOwner.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

$stillBusy = Get-NetTCPConnection -LocalPort 7676 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($stillBusy) {
  Write-Host ""
  Write-Host "Port 7676 is still owned by another DevSpace process." -ForegroundColor Yellow
  Write-Host "The new access policy is saved. Restart Windows once to activate it safely."
  exit 0
}

Start-ScheduledTask -TaskName "CodasSol DevSpace"
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch {}
}
if (-not $ready) { throw "CodasSol DevSpace did not restart successfully." }

Start-ScheduledTask -TaskName "CodasSol Agent"
Write-Host ""
Write-Host "Access policy updated successfully." -ForegroundColor Green
Write-Host "DevSpace and Agent roots are synchronized."
