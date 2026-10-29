param(
    [switch]$TransactionManaged,
    [string]$Roots = '',
    [string]$RouterUrl = '',
    [switch]$LocalOnly,
    [switch]$InstallFileSentinel,
    [switch]$SkipSentinelPrompt
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $TransactionManaged) { throw 'Run transaction.ps1 or INSTALL.cmd so upgrade rollback is available.' }

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

function Select-OptionalFileSentinel {
    if (-not [Environment]::UserInteractive) { return $false }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'CodasSol - Optional Components'
        $form.Size = New-Object System.Drawing.Size(450, 175)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $box = New-Object System.Windows.Forms.CheckBox
        $box.Text = 'Install File Sentinel (optional, read-only)'
        $box.SetBounds(20, 15, 400, 28)
        $box.Checked = $false
        $label = New-Object System.Windows.Forms.Label
        $label.Text = 'Logs file changes locally. No admin rights or automatic repair.'
        $label.SetBounds(20, 48, 410, 25)
        $button = New-Object System.Windows.Forms.Button
        $button.Text = 'Continue'
        $button.SetBounds(325, 84, 96, 28)
        $button.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Controls.AddRange(@($box, $label, $button))
        $form.AcceptButton = $button
        $result = $form.ShowDialog()
        $selected = $result -eq [System.Windows.Forms.DialogResult]::OK -and $box.Checked
        $form.Dispose()
        return $selected
    } catch {
        Write-Warning ('Optional component selection unavailable; skipping: ' + $_.Exception.Message)
        return $false
    }
}

Write-Host 'CodasSol Windows Standalone Node v0.2 — independent of Mac' -ForegroundColor Green
Write-Host 'This installation uses normal user permissions and does not modify antivirus policy.'

if ([string]::IsNullOrWhiteSpace($Roots)) {
    $savedRoots = Join-Path $state 'roots.txt'
    if (Test-Path $savedRoots) { $Roots = ([string](Get-Content $savedRoots -Raw)).Trim() }
    else { $Roots = $env:USERPROFILE }
}
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
foreach ($component in @('node\node.exe', 'node\npm.cmd', 'app\server.js', 'app\agent.js', 'app\agent-sse.js',
                       'runtime\supervisor.mjs', 'runtime\enrollment.mjs',
                       'runtime\configure-devspace-root.mjs',
                       'runtime\session-generations.mjs', 'runtime\devspace-session-preload.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $payload $component))) {
        throw "Archive is incomplete: payload\$component"
    }
}

# Stop only this installation's verified user-owned tasks before switching runtimes.
foreach ($taskName in @($taskDevspace, $taskRouter, 'CodasSol Standalone V02 Outbound')) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        $account = New-Object Security.Principal.NTAccount($existing.Principal.UserId)
        $sid = $account.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
            $existing.Actions.Count -ne 1 -or
            $existing.Actions[0].Arguments -notlike ('*' + $root + '\runtime\*')) {
            throw "Task ownership/path mismatch: $taskName. No unrelated task was stopped."
        }
        Stop-ScheduledTask -TaskName $taskName
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
$devspaceAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $root 'runtime\supervisor.mjs') + '" devspace')
$routerAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $root 'runtime\supervisor.mjs') + '" router')
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
& (Join-Path $bundle 'verify.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Authenticated Windows Router identity verification failed.' }

if (-not $LocalOnly) {
    Step 'Register this device with the fixed HTTPS Router'
    $enrollment = Join-Path $root 'runtime\enrollment.mjs'
    $outboundConfig = Join-Path $state 'outbound-agent.json'
    if (-not (Test-Path $outboundConfig)) {
        if ([string]::IsNullOrWhiteSpace($RouterUrl)) { $RouterUrl = Read-Host 'Explicit HTTPS Router origin (Cloudflare or legacy ngrok)' }
        $secure = Read-Host 'Router pairing token (hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            @{routerUrl=$RouterUrl; pairingToken=$token} | ConvertTo-Json -Compress | & $node $enrollment enroll
            if ($LASTEXITCODE -ne 0) { throw 'Registration failed. Local node retained; rerun INSTALL.cmd to retry.' }
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $token = $null; $secure = $null
        }
    }
    & $node $enrollment verify
    if ($LASTEXITCODE -ne 0) { throw 'Remote registration not verified. Existing credentials retained.' }
    $outboundAction = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $root 'runtime\supervisor.mjs') + '" outbound')
    Register-ScheduledTask -TaskName 'CodasSol Standalone V02 Outbound' -Action $outboundAction -Trigger $trigger -Settings $settings -Description 'CodasSol authenticated outbound HTTPS SSE' -Force | Out-Null
    Start-ScheduledTask -TaskName 'CodasSol Standalone V02 Outbound'
    Write-Host 'INSTALLATION COMPLETE: local backend verified and device registered.' -ForegroundColor Green
    Write-Host 'Remote command execution requires a follow-up test through ChatGPT.'
} else {
    Write-Host 'LOCAL ONLY: device has NOT been registered for ChatGPT access.' -ForegroundColor Yellow
}

# Optional components never interrupt the remote SSE, Router or DevSpace tasks.
$selected = [bool]$InstallFileSentinel
if (-not $selected -and -not $SkipSentinelPrompt) {
    $selected = $false # Optional components are installed separately after acceptance
}
if ($selected) {
    $sentinel = Join-Path $bundle 'components\file-sentinel\windows\install.ps1'
    if (-not (Test-Path -LiteralPath $sentinel)) {
        throw 'File Sentinel was selected but its installer is missing from the package.'
    }
    & $sentinel
    Write-Host 'Optional File Sentinel installation finished.'
} else {
    Write-Host 'File Sentinel not selected (disabled by default).'
}
