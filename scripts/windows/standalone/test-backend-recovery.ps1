param([switch]$PerformCrashTest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'CodasSol\NodeV02Standalone'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$node = Join-Path $root 'node\node.exe'
$cli = Join-Path $root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
$probe = Join-Path $PSScriptRoot 'probe-mcp.mjs'
$logs = Join-Path $root 'logs'
$resultPath = Join-Path $logs 'backend-recovery-check.json'
$stage = 'preflight'

if (-not $PerformCrashTest) {
    Write-Output 'No process was stopped. Opt in with -PerformCrashTest for the owned backend recovery test.'
    exit 0
}
New-Item -ItemType Directory -Force -Path $logs | Out-Null
try {
    foreach ($file in @($node, $cli, $probe)) {
        if (-not (Test-Path -LiteralPath $file)) { throw 'Required installed runtime or local MCP probe is missing.' }
    }
    $task = Get-ScheduledTask -TaskName 'CodasSol Standalone V02 DevSpace'
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskAccount = New-Object Security.Principal.NTAccount($task.Principal.UserId)
    if ($taskAccount.Translate([Security.Principal.SecurityIdentifier]).Value -ne $currentSid) {
        throw 'The installed supervisor belongs to a different Windows account.'
    }
    $expectedAction = '-NoLogo -NoProfile -File "' + (Join-Path $root 'runtime\start-devspace.ps1') + '"'
    if ($task.State -ne 'Running' -or $task.Actions.Count -ne 1 -or
        $task.Actions[0].Execute -ne 'powershell.exe' -or $task.Actions[0].Arguments -ne $expectedAction) {
        throw 'The expected installed DevSpace supervisor is not running.'
    }
    $devspaceBefore = (Get-NetTCPConnection -LocalPort 7676 -State Listen).OwningProcess | Select-Object -First 1
    $routerBefore = (Get-NetTCPConnection -LocalPort 17678 -State Listen).OwningProcess | Select-Object -First 1
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$devspaceBefore"
    $ownerSid = Invoke-CimMethod -InputObject $owner -MethodName GetOwnerSid
    if ($ownerSid.ReturnValue -ne 0 -or $ownerSid.Sid -ne $currentSid) {
        throw 'The active backend belongs to a different Windows account.'
    }
    if ($owner.ExecutablePath -ne $node -or $owner.CommandLine -notlike ('*' + $cli + '*serve*')) {
        throw 'The active backend is not owned by this installed CodasSol runtime.'
    }
    $private = Get-Content -LiteralPath (Join-Path $state 'router.json') -Raw | ConvertFrom-Json
    $installedId = ([string](Get-Content -LiteralPath (Join-Path $state 'device-id.txt') -Raw)).Trim()
    $headers = @{ Authorization = ('Bearer ' + $private.peerToken) }
    $identityBefore = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/peer/info' -Headers $headers -TimeoutSec 3
    if ($identityBefore.protocol -ne 2 -or $identityBefore.id -ne $installedId -or
        $identityBefore.installationId -ne $private.installationId) { throw 'Installed Router identity mismatch.' }

    $stage = 'owned-backend-crash'
    $started = Get-Date
    Stop-Process -Id $devspaceBefore
    $stage = 'supervisor-recovery'
    $healthy = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 2
        try {
            $dv = Invoke-RestMethod 'http://127.0.0.1:7676/healthz' -TimeoutSec 2
            $rv = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 2
            if ($dv.ok -eq $true -and $dv.name -eq 'devspace' -and $rv.ok -eq $true -and $rv.backendReachable -eq $true) {
                $healthy = $true; break
            }
        } catch { }
    }
    if (-not $healthy) { throw 'The installed supervisor did not restore backend health.' }
    $devspaceAfter = (Get-NetTCPConnection -LocalPort 7676 -State Listen).OwningProcess | Select-Object -First 1
    $routerAfter = (Get-NetTCPConnection -LocalPort 17678 -State Listen).OwningProcess | Select-Object -First 1
    $identityAfter = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/peer/info' -Headers $headers -TimeoutSec 3
    if ($devspaceBefore -eq $devspaceAfter -or $routerBefore -ne $routerAfter -or
        $identityBefore.id -ne $identityAfter.id -or $identityBefore.installationId -ne $identityAfter.installationId) {
        throw 'Recovery changed Router process/identity or did not replace the backend.'
    }
    $stage = 'workspace-execution'
    & $node $probe
    if ($LASTEXITCODE -ne 0) { throw 'Recovered backend failed the real workspace execution probe.' }
    @{ result = 'PASS'; recoverySeconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1);
       backendPidBefore = $devspaceBefore; backendPidAfter = $devspaceAfter;
       routerPidPreserved = $routerAfter; identityPreserved = $true; workspaceExecutionVerified = $true } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding utf8
    Write-Output 'PASS: owned backend recovered; Router identity and workspace execution verified.'
} catch {
    @{ result = 'FAIL'; stage = $stage; exceptionType = $_.Exception.GetType().Name } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding utf8
    throw
}
