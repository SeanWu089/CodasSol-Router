$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'CodasSol'
$new = Join-Path $base 'NodeV02Standalone'
$verify = Join-Path $new 'runtime\start-router.ps1'
$node = Join-Path $new 'node\node.exe'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
if (-not (Test-Path -LiteralPath $verify) -or -not (Test-Path -LiteralPath $node)) {
    throw 'New standalone node is not installed. Legacy cleanup refused.'
}
$devspace = Invoke-RestMethod 'http://127.0.0.1:7676/healthz' -TimeoutSec 3
$router = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 3
if ($devspace.ok -ne $true -or $devspace.name -ne 'devspace' -or
    $router.ok -ne $true -or $router.backendReachable -ne $true) {
    throw 'New independent Windows Router/DevSpace are not healthy; old files were NOT touched.'
}
$env:CODASSOL_STATE_DIR = $state
$token = (& $node (Join-Path $new 'app\router-cli.js') peer-token).Trim()
$info = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/peer/info' -Headers @{Authorization="Bearer $token"} -TimeoutSec 3
$id = ([string](Get-Content (Join-Path $state 'device-id.txt') -Raw)).Trim()
$token = $null
if ($info.protocol -ne 2 -or $info.id -ne $id) { throw 'New node identity mismatch; cleanup refused.' }

$backup = Join-Path $base ('LegacyBackup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$taskNames = @('CodasSol Agent', 'CodasSol DevSpace', 'CodasSol Router',
    'CodasSol V02 Peer TLS', 'CodasSol V02 Router')
$failedTask = $false
foreach ($name in $taskNames) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    try {
        $xml = Export-ScheduledTask -TaskName $name -ErrorAction Stop
        $safeName = ($name -replace '[^A-Za-z0-9 -]', '_')
        [IO.File]::WriteAllText((Join-Path $backup "$safeName.xml"), $xml)
        if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name -ErrorAction Stop }
        Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
        Write-Host "Disabled old task (XML backed up): $name" -ForegroundColor Green
    } catch {
        $failedTask = $true
        Write-Warning "Could not safely archive/disable $name; leaving old binaries intact: $($_.Exception.Message)"
    }
}

if ($failedTask) {
    Write-Warning 'Some old tasks could not be disabled. No legacy directories were moved.'
} else {
    foreach ($name in @('Agent', 'NodeV02', 'DevSpaceRescue')) {
        $src = Join-Path $base $name
        if (-not (Test-Path -LiteralPath $src)) { continue }
        try {
            Move-Item -LiteralPath $src -Destination (Join-Path $backup $name) -ErrorAction Stop
            Write-Host "Archived $name into $backup"
        } catch {
            Write-Warning "Could not move $name (possibly locked); left in place: $($_.Exception.Message)"
        }
    }
}

$stillHealthy = $false
for ($i = 0; $i -lt 15; $i++) {
    try {
        $dv = Invoke-RestMethod 'http://127.0.0.1:7676/healthz' -TimeoutSec 2
        $rv = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 2
        if ($dv.ok -eq $true -and $dv.name -eq 'devspace' -and
            $rv.ok -eq $true -and $rv.backendReachable -eq $true) {
            $stillHealthy = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $stillHealthy) {
    Write-Warning 'New backend did not recover after old tasks were disabled. Use saved scheduled-task XML to restore old startup if necessary.'
    throw 'Legacy binaries were preserved in the backup, but post-cleanup health verification FAILED.'
}

Write-Host "`nLegacy cleanup done. Backup location: $backup"
Write-Host 'No user profile, .devspace authentication, or .codassol pairing secrets were deleted.'
Write-Host 'The new Router listens on 127.0.0.1:17678; it still needs remote HTTPS ingress and peer setup.'
