param(
  [string]$RouterUrl = "",
  [string]$PairingToken = "",
  [string]$Roots = "",
  [switch]$SkipEnrollment
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Test-Router([string]$Url) {
  try {
    $health = Invoke-RestMethod -Uri "$Url/_codassol/health" -TimeoutSec 5
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Resolve-RouterUrl([string]$Initial) {
  $candidate = $Initial.Trim().TrimEnd("/")
  while ($true) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      $candidate = (Read-Host "Router URL (example: http://ROUTER-HOST:17676)").Trim().TrimEnd("/")
    }
    if (Test-Router $candidate) {
      return $candidate
    }
    Write-Host "Cannot reach $candidate/_codassol/health from this Windows PC." -ForegroundColor Yellow
    $candidate = (Read-Host "Enter another Router URL").Trim().TrimEnd("/")
  }
}

function Install-DevSpace([string]$Npm, [string]$Prefix, [string]$Version) {
  $package = "@waishnav/devspace@$Version"
  $mirror = "https://registry.npmmirror.com"
  $official = "https://registry.npmjs.org"

  Write-Host "Trying npmmirror (temporary per-command registry)..."
  & $Npm install --prefix $Prefix --no-audit --no-fund $package "--registry=$mirror"
  if ($LASTEXITCODE -eq 0) { return }

  Write-Host "Mirror install failed. Trying the machine's existing npm/proxy configuration..." -ForegroundColor Yellow
  & $Npm install --prefix $Prefix --no-audit --no-fund $package
  if ($LASTEXITCODE -eq 0) { return }

  Write-Host "Existing npm configuration failed. Trying official npm registry..." -ForegroundColor Yellow
  & $Npm install --prefix $Prefix --no-audit --no-fund $package "--registry=$official"
  if ($LASTEXITCODE -eq 0) { return }

  throw "Unable to install DevSpace from mirror, existing npm configuration, or official npm registry."
}

function Get-FixedNonSystemDrives {
  try {
    return @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
      Where-Object { $_.DeviceID -and $_.DeviceID -ne $env:SystemDrive } |
      ForEach-Object { "$($_.DeviceID)\" })
  } catch {
    return @(Get-PSDrive -PSProvider FileSystem |
      Where-Object {
        $_.Root -and
        $_.Root -match '^[A-Za-z]:\\$' -and
        -not $_.Root.StartsWith($env:SystemDrive, [System.StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { $_.Root })
  }
}

function Resolve-AccessRoots([string]$RequestedRoots) {
  if (-not [string]::IsNullOrWhiteSpace($RequestedRoots)) {
    return $RequestedRoots
  }

  $otherDrives = @(Get-FixedNonSystemDrives | Sort-Object -Unique)
  Write-Host ""
  Write-Host "Choose CodasSol workspace access:" -ForegroundColor Cyan
  Write-Host "  1. User profile only: $env:USERPROFILE"
  Write-Host "  2. RECOMMENDED: user profile + all fixed non-system drives"
  Write-Host "  3. All fixed non-system drives only"
  Write-Host "  4. Custom roots"
  if ($otherDrives.Count -gt 0) {
    Write-Host "     Fixed non-system drives detected: $($otherDrives -join ', ')"
  } else {
    Write-Host "     No fixed non-system drives detected."
  }
  $choice = (Read-Host "Choice [2]").Trim()
  if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "2" }

  switch ($choice) {
    "1" { return $env:USERPROFILE }
    "2" { return (@($env:USERPROFILE) + $otherDrives) -join "|" }
    "3" {
      if ($otherDrives.Count -eq 0) { throw "No fixed non-system drives were detected." }
      return $otherDrives -join "|"
    }
    "4" {
      $custom = (Read-Host "Enter roots separated by | (example C:\Users\USER|D:\|E:\PROJECTS)").Trim()
      if ([string]::IsNullOrWhiteSpace($custom)) { throw "At least one root is required." }
      return $custom
    }
    default { throw "Unknown choice: $choice" }
  }
}

Write-Host ""
Write-Host "CodasSol Windows Router + Agent" -ForegroundColor Green
Write-Host "Independent local routing: no Mac connection or administrator install required."

$Roots = Resolve-AccessRoots $Roots

$BundleDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadDir = Join-Path $BundleDir "payload"
$NodeSource = Join-Path $PayloadDir "node"
$AppSource = Join-Path $PayloadDir "app"
$InstallRoot = Join-Path $env:LOCALAPPDATA "CodasSol\Agent"
$NodeDir = Join-Path $InstallRoot "node"
$AppDir = Join-Path $InstallRoot "app"
$DevSpaceDir = Join-Path $InstallRoot "devspace"
$RuntimeDir = Join-Path $InstallRoot "runtime"
$NodeExe = Join-Path $NodeDir "node.exe"
$NpmCmd = Join-Path $NodeDir "npm.cmd"
$AgentScript = Join-Path $AppDir "agent.js"
$DevSpaceCli = Join-Path $DevSpaceDir "node_modules\@waishnav\devspace\dist\cli.js"
$DevSpaceVersion = "1.1.0-beta.4"
$ConfigureRoots = Join-Path $RuntimeDir "configure-devspace-root.mjs"

$DetectedArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($DetectedArch -ne "AMD64") {
  throw "This bundle contains the x64 Node runtime. Detected architecture: $DetectedArch"
}
if (-not (Test-Path $NodeSource)) { throw "Bundle payload is incomplete: payload\node is missing." }
if (-not (Test-Path $AppSource)) { throw "Bundle payload is incomplete: payload\app is missing." }

Write-Step "Preparing a safe in-place upgrade"
# Never overwrite the private Node executable while existing CodasSol tasks
# are using it. Other Node installations and unrelated processes are untouched.
foreach ($taskName in @("CodasSol Agent", "CodasSol Router", "CodasSol DevSpace")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName
  }
}
if (Test-Path $NodeExe) {
  $oldProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.ExecutablePath -eq $NodeExe })
  foreach ($oldProcess in $oldProcesses) {
    Write-Host "Stopping prior private CodasSol runtime (PID $($oldProcess.ProcessId))."
    Stop-Process -Id $oldProcess.ProcessId -Force -ErrorAction Stop
  }
}

Write-Step "Installing the private CodasSol runtime"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
Copy-Item -Recurse -Force (Join-Path $NodeSource "*") $NodeDir
Copy-Item -Recurse -Force (Join-Path $AppSource "*") $AppDir
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
Copy-Item -Force (Join-Path $PayloadDir "runtime\start-devspace.ps1") $RuntimeDir
Copy-Item -Force (Join-Path $PayloadDir "runtime\start-agent.ps1") $RuntimeDir
Copy-Item -Force (Join-Path $PayloadDir "runtime\start-router.ps1") $RuntimeDir
Copy-Item -Force (Join-Path $PayloadDir "runtime\configure-devspace-root.mjs") $RuntimeDir

$env:PATH = "$NodeDir;$env:PATH"
$nodeVersion = & $NodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') {
  throw "Bundled Node verification failed. Expected Node 22.x, got '$nodeVersion'."
}
Write-Host "Node verified: $nodeVersion"

Write-Step "Installing DevSpace locally"
$needsDevSpace = $true
if (Test-Path $DevSpaceCli) {
  $currentVersion = (& $NodeExe $DevSpaceCli --version 2>$null)
  if ($LASTEXITCODE -eq 0 -and $currentVersion -match [regex]::Escape($DevSpaceVersion)) {
    $needsDevSpace = $false
    Write-Host "DevSpace already present: $currentVersion"
  }
}
if ($needsDevSpace) {
  New-Item -ItemType Directory -Force -Path $DevSpaceDir | Out-Null
  Install-DevSpace -Npm $NpmCmd -Prefix $DevSpaceDir -Version $DevSpaceVersion
}
if (-not (Test-Path $DevSpaceCli)) { throw "DevSpace CLI is missing after installation: $DevSpaceCli" }
$devspaceVersionActual = & $NodeExe $DevSpaceCli --version
if ($LASTEXITCODE -ne 0) { throw "DevSpace verification failed." }
Write-Host "DevSpace verified: $devspaceVersionActual"

Write-Step "Initializing DevSpace"
$DevSpaceAuth = Join-Path $env:USERPROFILE ".devspace\auth.json"
if (-not (Test-Path $DevSpaceAuth)) {
  Write-Host "One interactive DevSpace setup is required."
  Write-Host "When asked where DevSpace will be used, choose: Coding Agents."
  Write-Host "Do not create a second public tunnel for this Windows machine."
  Write-Host ""
  & $NodeExe $DevSpaceCli init
  if ($LASTEXITCODE -ne 0) { throw "DevSpace initialization failed." }
}
if (-not (Test-Path $DevSpaceAuth)) {
  throw "DevSpace did not create $DevSpaceAuth."
}

$DevSpaceConfig = Join-Path $env:USERPROFILE ".devspace\config.jsonc"
if (-not (Test-Path $DevSpaceConfig)) {
  throw "DevSpace did not create $DevSpaceConfig."
}
& $NodeExe $ConfigureRoots $DevSpaceDir $DevSpaceConfig $Roots
if ($LASTEXITCODE -ne 0) { throw "Unable to align DevSpace allowed roots with CodasSol Agent roots." }

$StateDir = Join-Path $env:USERPROFILE ".codassol"
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$RootsFile = Join-Path $StateDir "roots.txt"
[System.IO.File]::WriteAllText($RootsFile, $Roots, [System.Text.UTF8Encoding]::new($false))

Write-Step "Starting local DevSpace"
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
} catch {
  $startDevSpace = Join-Path $RuntimeDir "start-devspace.ps1"
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $startDevSpace + '"'))
}
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch {}
}
if (-not $ready) { throw "DevSpace did not become ready on 127.0.0.1:7676." }
Write-Host "DevSpace health check passed."

Write-Step "Optional connection to another CodasSol Router"
$DefaultRouterFile = Join-Path $BundleDir "router-default.txt"
if ([string]::IsNullOrWhiteSpace($RouterUrl) -and (Test-Path $DefaultRouterFile)) {
  # A zero-byte router-default.txt returns $null in PowerShell 5.1. Never
  # call Trim() on the result before normalizing to a string.
  $prefill = Get-Content $DefaultRouterFile -Raw
  $RouterUrl = ([string]$prefill).Trim()
  if (-not [string]::IsNullOrWhiteSpace($RouterUrl)) {
    Write-Host "Trying packaged Router URL: $RouterUrl"
  }
}
$AgentConfig = Join-Path $env:USERPROFILE ".codassol\agent.json"
$ShouldEnroll = -not $SkipEnrollment
if ($ShouldEnroll -and [string]::IsNullOrWhiteSpace($RouterUrl)) {
  $choice = (Read-Host "Connect to another Router now? [y/N]").Trim()
  $ShouldEnroll = $choice -match '^[yY]$'
}
if ($ShouldEnroll -and -not [string]::IsNullOrWhiteSpace($RouterUrl) -and -not (Test-Router $RouterUrl)) {
  Write-Host "Remote Router is offline. Continuing with the independent local Router." -ForegroundColor Yellow
  $ShouldEnroll = $false
}
if ($ShouldEnroll) {
  $RouterUrl = Resolve-RouterUrl $RouterUrl
  if ([string]::IsNullOrWhiteSpace($PairingToken)) {
    $PairingToken = Read-Secret "One-time pairing token from the remote Router"
  }
  if ([string]::IsNullOrWhiteSpace($PairingToken)) { throw "Pairing token cannot be empty." }
  & $NodeExe $AgentScript enroll --router $RouterUrl --pairing-token $PairingToken --device-id $env:COMPUTERNAME --label $env:COMPUTERNAME --roots $Roots
  $PairingToken = $null
  if ($LASTEXITCODE -ne 0) { throw "CodasSol Agent enrollment failed." }
}

if (Test-Path $AgentConfig) {
  # Reinstalling offline must not leave Agent-advertised roots different from
  # DevSpace's effective allowedRoots on this machine.
  $existingAgent = Get-Content $AgentConfig -Raw | ConvertFrom-Json
  $newRoots = @($Roots -split '\|')
  if (($existingAgent.device.roots -join '|') -ne ($newRoots -join '|')) {
    Copy-Item -Force $AgentConfig "$AgentConfig.v0.2.bak"
    $existingAgent.device.roots = $newRoots
    $updated = $existingAgent | ConvertTo-Json -Depth 15
    [System.IO.File]::WriteAllText($AgentConfig, $updated, [System.Text.UTF8Encoding]::new($false))
  }
}

Write-Step "Installing current-user autostart"
$AutoScript = Join-Path $BundleDir "install-autostart.ps1"
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $AutoScript -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { throw "Autostart installation failed." }

Write-Step "Final verification"
if ($ShouldEnroll) {
  $agentConfigJson = Get-Content $AgentConfig -Raw | ConvertFrom-Json
  if ($agentConfigJson.routerUrl -ne $RouterUrl) {
    throw "Agent config Router URL verification failed."
  }
}
if (-not (Get-ScheduledTask -TaskName "CodasSol DevSpace" -ErrorAction SilentlyContinue)) {
  throw "CodasSol DevSpace scheduled task is missing."
}
if (-not (Get-ScheduledTask -TaskName "CodasSol Router" -ErrorAction SilentlyContinue)) {
  throw "CodasSol Router scheduled task is missing."
}
if ((Test-Path $AgentConfig) -and -not (Get-ScheduledTask -TaskName "CodasSol Agent" -ErrorAction SilentlyContinue)) {
  throw "CodasSol Agent scheduled task is missing."
}
$localRouterReady = $false
for ($i = 0; $i -lt 15; $i++) {
  if (Test-Router "http://127.0.0.1:17676") { $localRouterReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $localRouterReady) { throw "Local independent Router did not become ready." }

# A stale pre-v0.2 process might still own port 17676. Verify that the
# responding Router is this machine's actual protocol-v2 node, not just any
# service returning a health response.
$RouterCli = Join-Path $AppDir "router-cli.js"
$LocalPeerToken = (& $NodeExe $RouterCli peer-token).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($LocalPeerToken)) {
  throw "Unable to load this node's local Router identity."
}
try {
  $LocalInfo = Invoke-RestMethod -Uri "http://127.0.0.1:17676/_codassol/peer/info" -TimeoutSec 5 -Headers @{
    Authorization = "Bearer $LocalPeerToken"
  }
  if ($LocalInfo.protocol -ne 2 -or $LocalInfo.id -ne $env:COMPUTERNAME) {
    throw "Wrong Router identity or protocol on 127.0.0.1:17676."
  }
} finally { $LocalPeerToken = $null }

Write-Host ""
Write-Host "Installed successfully." -ForegroundColor Green
Write-Host "Local Router: http://127.0.0.1:17676"
if ($ShouldEnroll) { Write-Host "Remote Agent target: $RouterUrl" }
elseif (Test-Path $AgentConfig) { Write-Host "Existing remote Agent configuration preserved." }
else { Write-Host "Remote Agent: not enrolled (optional)." }
Write-Host "Node ID:    $env:COMPUTERNAME"
Write-Host "Project root advertised to Router: $Roots"
Write-Host "Runtime:    $InstallRoot"
Write-Host "Private config: $AgentConfig"
Write-Host ""
Write-Host "The independent Router and DevSpace will start at Windows logon; Agent starts if configured."
