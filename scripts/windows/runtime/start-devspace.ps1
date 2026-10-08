$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeDir = Join-Path $InstallRoot "node"
$NodeExe = Join-Path $NodeDir "node.exe"
$DevSpaceCli = Join-Path $InstallRoot "devspace\node_modules\@waishnav\devspace\dist\cli.js"

$env:PATH = "$NodeDir;$env:PATH"

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
  exit 0
} catch {}

if (-not (Test-Path $NodeExe)) {
  throw "Node executable is missing: $NodeExe"
}
if (-not (Test-Path $DevSpaceCli)) {
  throw "DevSpace CLI is missing: $DevSpaceCli"
}

Set-Location $env:USERPROFILE
& $NodeExe $DevSpaceCli serve
exit $LASTEXITCODE
