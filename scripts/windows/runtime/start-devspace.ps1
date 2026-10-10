$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeDir = Join-Path $InstallRoot "node"
$NodeExe = Join-Path $NodeDir "node.exe"
$DevSpaceCli = Join-Path $InstallRoot "devspace\node_modules\@waishnav\devspace\dist\cli.js"

if (-not (Test-Path $NodeExe)) {
  throw "Node executable is missing: $NodeExe"
}
if (-not (Test-Path $DevSpaceCli)) {
  throw "DevSpace CLI is missing: $DevSpaceCli"
}

$env:PATH = "$NodeDir;$env:PATH"

# Keep the Scheduled Task alive even if another process is currently serving
# DevSpace. Exiting on an initially healthy backend leaves Windows with no
# recovery path when that process eventually dies.
while ($true) {
  $healthy = $false
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 3
    $healthy = ($health.ok -eq $true -and $health.name -eq "devspace")
  } catch {
    # Backend is absent or unhealthy; start the private published CLI below.
  }

  if ($healthy) {
    Start-Sleep -Seconds 5
    continue
  }

  try {
    Set-Location $env:USERPROFILE
    & $NodeExe $DevSpaceCli serve
  } catch {
    Write-Warning "DevSpace unexpectedly exited: $($_.Exception.Message)"
  }

  # Keep a bounded delay if DevSpace exits quickly (missing dependency,
  # occupied port, process crash); never delete credentials or allowedRoots.
  Start-Sleep -Seconds 5
}
