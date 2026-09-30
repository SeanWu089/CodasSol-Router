$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $InstallRoot "node\node.exe"
$AgentScript = Join-Path $InstallRoot "app\agent.js"

if (-not (Test-Path $NodeExe)) { throw "Node executable is missing: $NodeExe" }
if (-not (Test-Path $AgentScript)) { throw "Agent script is missing: $AgentScript" }

Set-Location (Join-Path $InstallRoot "app")
& $NodeExe $AgentScript run
exit $LASTEXITCODE
