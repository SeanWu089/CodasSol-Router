param(
  [string]$RouterUrl = "",
  [string]$PairingToken = "",
  [string]$Roots = $env:USERPROFILE
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
      $candidate = (Read-Host "Router URL (example: http://192.168.1.10:17676)").Trim().TrimEnd("/")
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

Write-Host ""
Write-Host "CodasSol Windows Agent" -ForegroundColor Green
Write-Host "Self-contained installer: no Git, no global Node/npm changes, no admin install required."

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
$DevSpaceCmd = Join-Path $DevSpaceDir "node_modules\.bin\devspace.cmd"
$DevSpaceVersion = "1.1.0-beta.4"

$DetectedArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($DetectedArch -ne "AMD64") {
  throw "This bundle contains the x64 Node runtime. Detected architecture: $DetectedArch"
}
if (-not (Test-Path $NodeSource)) { throw "Bundle payload is incomplete: payload\node is missing." }
if (-not (Test-Path $AppSource)) { throw "Bundle payload is incomplete: payload\app is missing." }

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

$env:PATH = "$NodeDir;$env:PATH"
$nodeVersion = & $NodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.') {
  throw "Bundled Node verification failed. Expected Node 22.x, got '$nodeVersion'."
}
Write-Host "Node verified: $nodeVersion"

Write-Step "Installing DevSpace locally"
$needsDevSpace = $true
if (Test-Path $DevSpaceCmd) {
  $currentVersion = (& $DevSpaceCmd --version 2>$null)
  if ($LASTEXITCODE -eq 0 -and $currentVersion -match [regex]::Escape($DevSpaceVersion)) {
    $needsDevSpace = $false
    Write-Host "DevSpace already present: $currentVersion"
  }
}
if ($needsDevSpace) {
  New-Item -ItemType Directory -Force -Path $DevSpaceDir | Out-Null
  Install-DevSpace -Npm $NpmCmd -Prefix $DevSpaceDir -Version $DevSpaceVersion
}
$devspaceVersionActual = & $DevSpaceCmd --version
if ($LASTEXITCODE -ne 0) { throw "DevSpace verification failed." }
Write-Host "DevSpace verified: $devspaceVersionActual"

Write-Step "Initializing DevSpace"
$DevSpaceAuth = Join-Path $env:USERPROFILE ".devspace\auth.json"
if (-not (Test-Path $DevSpaceAuth)) {
  Write-Host "One interactive DevSpace setup is required."
  Write-Host "When asked where DevSpace will be used, choose: Coding Agents."
  Write-Host "Do not create a second public tunnel for this Windows machine."
  Write-Host ""
  & $DevSpaceCmd init
  if ($LASTEXITCODE -ne 0) { throw "DevSpace initialization failed." }
}
if (-not (Test-Path $DevSpaceAuth)) {
  throw "DevSpace did not create $DevSpaceAuth."
}

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

Write-Step "Connecting this PC to CodasSol Router"
$DefaultRouterFile = Join-Path $BundleDir "router-default.txt"
if ([string]::IsNullOrWhiteSpace($RouterUrl) -and (Test-Path $DefaultRouterFile)) {
  $RouterUrl = (Get-Content $DefaultRouterFile -Raw).Trim()
  if (-not [string]::IsNullOrWhiteSpace($RouterUrl)) {
    Write-Host "Trying packaged Router URL: $RouterUrl"
  }
}
$RouterUrl = Resolve-RouterUrl $RouterUrl

if ([string]::IsNullOrWhiteSpace($PairingToken)) {
  Write-Host ""
  Write-Host "Paste the one-time pairing token from the Mac Router." -ForegroundColor Yellow
  $PairingToken = Read-Secret "Pairing token"
}
if ([string]::IsNullOrWhiteSpace($PairingToken)) { throw "Pairing token cannot be empty." }

& $NodeExe $AgentScript enroll --router $RouterUrl --pairing-token $PairingToken --device-id $env:COMPUTERNAME --label $env:COMPUTERNAME --roots $Roots
$PairingToken = $null
if ($LASTEXITCODE -ne 0) { throw "CodasSol Agent enrollment failed." }

$AgentConfig = Join-Path $env:USERPROFILE ".codassol\agent.json"
if (-not (Test-Path $AgentConfig)) { throw "Agent config was not created at $AgentConfig." }

Write-Step "Installing current-user autostart"
$AutoScript = Join-Path $BundleDir "install-autostart.ps1"
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $AutoScript -InstallRoot $InstallRoot
if ($LASTEXITCODE -ne 0) { throw "Autostart installation failed." }

Write-Step "Final verification"
$agentConfigJson = Get-Content $AgentConfig -Raw | ConvertFrom-Json
if ($agentConfigJson.routerUrl -ne $RouterUrl) {
  throw "Agent config Router URL verification failed."
}
if (-not (Get-ScheduledTask -TaskName "CodasSol DevSpace" -ErrorAction SilentlyContinue)) {
  throw "CodasSol DevSpace scheduled task is missing."
}
if (-not (Get-ScheduledTask -TaskName "CodasSol Agent" -ErrorAction SilentlyContinue)) {
  throw "CodasSol Agent scheduled task is missing."
}

Write-Host ""
Write-Host "Installed successfully." -ForegroundColor Green
Write-Host "Router:     $RouterUrl"
Write-Host "Agent ID:   $env:COMPUTERNAME"
Write-Host "Project root advertised to Router: $Roots"
Write-Host "Runtime:    $InstallRoot"
Write-Host "Private config: $AgentConfig"
Write-Host ""
Write-Host "The Agent and DevSpace will start automatically when this Windows user logs in."
