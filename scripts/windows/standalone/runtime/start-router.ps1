$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Join-Path $root 'node\node.exe'
$server = Join-Path $root 'app\server.js'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$identity = Join-Path $state 'device-id.txt'
$roots = Join-Path $state 'roots.txt'
if (-not (Test-Path $node) -or -not (Test-Path $server) -or
    -not (Test-Path $identity) -or -not (Test-Path $roots)) {
    throw 'Windows Node v0.2 is incomplete. Run VERIFY.cmd and inspect install log.'
}
$env:CODASSOL_STATE_DIR = $state
$env:CODASSOL_LOCAL_DEVICE_ID = ([string](Get-Content -LiteralPath $identity -Raw)).Trim()
$env:CODASSOL_LOCAL_DEVICE_LABEL = $env:COMPUTERNAME
$env:CODASSOL_LOCAL_ROOTS = ([string](Get-Content -LiteralPath $roots -Raw)).Trim()
$env:CODASSOL_LISTEN_HOST = '127.0.0.1'
$env:CODASSOL_LISTEN_PORT = '17678'
$env:CODASSOL_BACKEND_HOST = '127.0.0.1'
$env:CODASSOL_BACKEND_PORT = '7676'
if (-not $env:CODASSOL_LOCAL_DEVICE_ID -or -not $env:CODASSOL_LOCAL_ROOTS) {
    throw 'Missing device identity or authorized roots.'
}
Set-Location (Join-Path $root 'app')
& $node $server
exit $LASTEXITCODE
