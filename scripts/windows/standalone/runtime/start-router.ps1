$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Join-Path $root 'node\node.exe'
$server = Join-Path $root 'app\server.js'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$identity = Join-Path $state 'device-id.txt'
$roots = Join-Path $state 'roots.txt'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
function Write-SupervisorLog([string]$message) {
    ('{0} {1}' -f (Get-Date -Format o), $message) |
        Out-File -LiteralPath (Join-Path $logDir 'router-supervisor.log') -Append -Encoding utf8
}
$env:CODASSOL_STATE_DIR = $state
$env:CODASSOL_LOCAL_DEVICE_LABEL = $env:COMPUTERNAME
$env:CODASSOL_LISTEN_HOST = '127.0.0.1'
$env:CODASSOL_LISTEN_PORT = '17678'
$env:CODASSOL_BACKEND_HOST = '127.0.0.1'
$env:CODASSOL_BACKEND_PORT = '7676'

# Remain alive when an already running Router serves the loopback port. If it
# later exits, this Scheduled Task must be able to start its own private Router.
# Backend readiness is deliberately NOT required here: DevSpace can be down
# while the existing Router is still healthy and should not be duplicated.
while ($true) {
    $routerHealthy = $false
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 3
        $routerHealthy = ($health.ok -eq $true)
    } catch { }
    if ($routerHealthy) {
        Start-Sleep -Seconds 5
        continue
    }

    if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $server) -or
        -not (Test-Path -LiteralPath $identity) -or -not (Test-Path -LiteralPath $roots)) {
        Write-SupervisorLog 'Node, Router, identity, or allowed roots missing. Retrying without changing state.'
        Start-Sleep -Seconds 20
        continue
    }
    try {
        $env:CODASSOL_LOCAL_DEVICE_ID = ([string](Get-Content -LiteralPath $identity -Raw)).Trim()
        $env:CODASSOL_LOCAL_ROOTS = ([string](Get-Content -LiteralPath $roots -Raw)).Trim()
        if (-not $env:CODASSOL_LOCAL_DEVICE_ID -or -not $env:CODASSOL_LOCAL_ROOTS) {
            throw 'Empty installed device identity or allowed roots.'
        }
        Set-Location (Join-Path $root 'app')
        $oldPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $node $server 2>&1 |
                Out-File -LiteralPath (Join-Path $logDir 'router.log') -Append -Encoding utf8
            $routerExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $oldPreference
        }
        Write-SupervisorLog "Router exited with code $routerExit. Restarting after cooldown."
    } catch {
        Write-SupervisorLog "Router failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 5
}
