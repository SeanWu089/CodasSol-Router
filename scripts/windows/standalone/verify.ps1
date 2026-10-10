$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'CodasSol\NodeV02Standalone'
$node = Join-Path $root 'node\node.exe'
$cli = Join-Path $root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$env:CODASSOL_STATE_DIR = $state
$idFile = Join-Path $state 'device-id.txt'
$good = $true
Write-Host '=== CodasSol Windows independent node ===' -ForegroundColor Cyan
foreach ($item in @($node, $cli, (Join-Path $root 'app\server.js'), $idFile)) {
    $exists = Test-Path -LiteralPath $item
    Write-Host "$exists $item"
    if (-not $exists) { $good = $false }
}
if ($good) {
    try {
        $dv = Invoke-RestMethod 'http://127.0.0.1:7676/healthz' -TimeoutSec 4
        $rv = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 4
        $good = ($dv.ok -eq $true -and $dv.name -eq 'devspace' -and
                 $rv.ok -eq $true -and $rv.backendReachable -eq $true)
        Write-Host "DevSpace: $($dv.ok), Router: $($rv.ok), backend: $($rv.backendReachable)"
        $token = (& $node (Join-Path $root 'app\router-cli.js') peer-token).Trim()
        if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Missing peer token' }
        $info = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/peer/info' -Headers @{Authorization="Bearer $token"} -TimeoutSec 4
        $id = ([string](Get-Content -LiteralPath $idFile -Raw)).Trim()
        if ($info.protocol -ne 2 -or $info.id -ne $id) { throw 'Router identity mismatch' }
        Write-Host "Node ID: $id; Protocol: $($info.protocol)"
        $token = $null
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        $good = $false
    }
}
if ($good) { Write-Host 'PASS: Mac-independent local node verified.' -ForegroundColor Green; exit 0 }
Write-Host 'FAIL: not execution-ready. Do not claim remote connectivity.' -ForegroundColor Red
exit 1
