param([string]$Roots = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$s) { Write-Host "`n==> $s" -ForegroundColor Cyan }

$bundle = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = Join-Path $bundle 'payload'
$base = Join-Path $env:LOCALAPPDATA 'CodasSol'
$root = Join-Path $base 'NodeV02Standalone'
$state = Join-Path $env:USERPROFILE '.codassol-node-v02'
$node = Join-Path $root 'node\node.exe'
$npm = Join-Path $root 'node\npm.cmd'
$cli = Join-Path $root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
$setup = Join-Path $root 'runtime\configure-devspace-root.mjs'
$devspaceConfig = Join-Path $env:USERPROFILE '.devspace\config.jsonc'
$auth = Join-Path $env:USERPROFILE '.devspace\auth.json'
$taskDevspace = 'CodasSol Standalone V02 DevSpace'
$taskRouter = 'CodasSol Standalone V02 Router'

Write-Host 'CodasSol Windows Standalone Node v0.2 — independent of Mac' -ForegroundColor Green
Write-Host 'This installation uses normal user permissions and does not modify antivirus policy.'

if ([string]::IsNullOrWhiteSpace($Roots)) { $Roots = $env:USERPROFILE }
if ([string]::IsNullOrWhiteSpace($Roots)) { throw 'An allowed workspace root is required.' }
foreach ($path in @($Roots -split '\|')) {
    if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path)) {
        throw "Workspace root must exist and be an absolute path: $path"
    }
}
if (([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) -or ([string]::IsNullOrWhiteSpace($env:USERPROFILE))) {
    throw 'USERPROFILE/LOCALAPPDATA is unavailable.'
}
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { throw "This build requires Windows x64; detected $arch." }
foreach ($component in @('node\node.exe', 'node\npm.cmd', 'app\server.js',
                       'runtime\start-devspace.ps1', 'runtime\start-router.ps1',
                       'runtime\configure-devspace-root.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $payload $component))) {
        throw "Archive is incomplete: payload\$component"
    }
}

Step 'Stage new v0.2 files without touching old Agent, NodeV02 or Rescue directories'
New-Item -ItemType Directory -Force -Path $root, $state | Out-Null
if (-not (Test-Path -LiteralPath $node)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'node') | Out-Null
    Copy-Item -Path (Join-Path $payload 'node\*') -Destination (Join-Path $root 'node') -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $root 'app'), (Join-Path $root 'runtime') | Out-Null
Copy-Item -Path (Join-Path $payload 'app\*') -Destination (Join-Path $root 'app') -Force
Copy-Item -Path (Join-Path $payload 'runtime\*') -Destination (Join-Path $root 'runtime') -Force
$env:PATH = "$(Join-Path $root 'node');$env:PATH"
$version = (& $node --version)
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v22\.') { throw "Invalid private Node.js: $version" }
Write-Host "Node verified: $version"

Step 'Install published DevSpace in a separate, private directory'
$prefix = Join-Path $root 'devspace'
if (-not (Test-Path -LiteralPath $cli)) {
    # A partial npm tree can misleadingly say "up to date" despite missing
    # the CLI. Preserve it for diagnostics, then install into an empty tree.
    $modules = Join-Path $prefix 'node_modules'
    if (Test-Path -LiteralPath $modules) {
        $failed = Join-Path $prefix ('failed-node-modules-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Move-Item -LiteralPath $modules -Destination $failed
    }
    New-Item -ItemType Directory -Force -Path $prefix | Out-Null
    $registries = @('https://registry.npmmirror.com', 'https://registry.npmjs.org')
    foreach ($registry in $registries) {
        Write-Host "Installing @waishnav/devspace@1.1.0-beta.4 from $registry"
        # npm logs registry failures to stderr. Do not let PowerShell 5.1
        # treat that diagnostic output as a terminating exception before
        # the official registry can be tried.
        $preference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $npm install --prefix $prefix --no-audit --no-fund '--registry' $registry '@waishnav/devspace@1.1.0-beta.4'
        } finally {
            $ErrorActionPreference = $preference
        }
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $cli)) { break }
    }
}
if (-not (Test-Path -LiteralPath $cli)) {
    throw 'DevSpace dist/cli.js is absent after installing the official package. Installation STOPPED; an organization-managed security restriction or damaged package may be responsible. Do not bypass endpoint protection.'
}
$devspaceVersion = (& $node $cli --version)
if ($LASTEXITCODE -ne 0 -or ($devspaceVersion -notmatch '1\.1\.0-beta\.4')) {
    throw "DevSpace version verification failed: $devspaceVersion"
}
Write-Host "DevSpace verified: $devspaceVersion"

Step 'Preserve authentication and permitted workspace roots'
if (-not (Test-Path -LiteralPath $auth)) {
    Write-Host 'One-time DevSpace initialization is required. Select Coding Agents.'
    & $node $cli init
    if ($LASTEXITCODE -ne 0) { throw 'DevSpace initialization failed.' }
}
if (-not (Test-Path -LiteralPath $auth) -or -not (Test-Path -LiteralPath $devspaceConfig)) {
    throw 'DevSpace authentication/configuration is missing.'
}
$backup = Join-Path $state ('config-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.jsonc')
Copy-Item -LiteralPath $devspaceConfig -Destination $backup
& $node $setup $prefix $devspaceConfig $Roots
if ($LASTEXITCODE -ne 0) { throw 'Could not align DevSpace allowedRoots with node workspace permissions.' }
[IO.File]::WriteAllText((Join-Path $state 'roots.txt'), $Roots, (New-Object Text.UTF8Encoding($false)))
$identityPath = Join-Path $state 'device-id.txt'
if (-not (Test-Path -LiteralPath $identityPath)) {
    $identity = 'device-' + ([guid]::NewGuid().ToString('D'))
    [IO.File]::WriteAllText($identityPath, $identity, (New-Object Text.UTF8Encoding($false)))
}
if (([string](Get-Content $identityPath -Raw)).Trim() -notmatch '^device-[0-9a-f-]{36}$') {
    throw 'Invalid persisted node identity. Refusing to overwrite it.'
}

Step 'Create local-only independent Windows Router and DevSpace supervision tasks'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$devspaceAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -File "' + (Join-Path $root 'runtime\start-devspace.ps1') + '"')
$routerAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -File "' + (Join-Path $root 'runtime\start-router.ps1') + '"')
Register-ScheduledTask -TaskName $taskDevspace -Action $devspaceAction -Trigger $trigger -Settings $settings -Description 'Mac-independent CodasSol Windows DevSpace supervisor (v0.2)' -Force | Out-Null
Register-ScheduledTask -TaskName $taskRouter -Action $routerAction -Trigger $trigger -Settings $settings -Description 'Mac-independent CodasSol Windows Router (v0.2)' -Force | Out-Null
Start-ScheduledTask -TaskName $taskDevspace
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName $taskRouter

Step 'Verify actual backend health and authenticated Router identity'
$verified = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $dv = Invoke-RestMethod 'http://127.0.0.1:7676/healthz' -TimeoutSec 2
        $rv = Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 2
        if ($dv.ok -eq $true -and $dv.name -eq 'devspace' -and
            $rv.ok -eq $true -and $rv.backendReachable -eq $true) {
            $verified = $true
            break
        }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $verified) {
    throw 'Local Windows node not backend-ready. Old CodasSol files/tasks were NOT deleted; inspect NodeV02Standalone/logs and VERIFY.cmd.'
}
powershell.exe -NoLogo -NoProfile -File (Join-Path $bundle 'verify.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Authenticated Windows Router identity verification failed.' }

Write-Host "`nWINDOWS NODE READY: http://127.0.0.1:17678" -ForegroundColor Green
Write-Host 'This Router runs locally even when Mac is off.'
Write-Host 'Cross-network clients still require their OWN authorized HTTPS ingress and trusted peer configuration.'
Write-Host 'Optional next step: CLEANUP-OLD.cmd backs up and retires old CodasSol installations.'
