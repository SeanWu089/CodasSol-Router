$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeDir = Join-Path $InstallRoot "node"
$DevSpaceCmd = Join-Path $InstallRoot "devspace\node_modules\.bin\devspace.cmd"

$env:PATH = "$NodeDir;$env:PATH"

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
  exit 0
} catch {}

if (-not (Test-Path $DevSpaceCmd)) {
  throw "DevSpace executable is missing: $DevSpaceCmd"
}

Set-Location $env:USERPROFILE
& $DevSpaceCmd serve
exit $LASTEXITCODE
