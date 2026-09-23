param(
  [Parameter(Mandatory = $true)]
  [string]$RouterUrl,

  [string]$PairingToken = "",

  [string]$DeviceId = $env:COMPUTERNAME,
  [string]$Label = $env:COMPUTERNAME,
  [string]$Roots = $env:USERPROFILE
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($PairingToken)) {
  $SecurePairingToken = Read-Host "Paste the CodasSol Router pairing token" -AsSecureString
  $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecurePairingToken)
  try {
    $PairingToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
  }
}

function Require-Command([string]$Name, [string]$InstallHint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $InstallHint"
  }
}

Require-Command "node" "Install Node.js 22 or newer first."
Require-Command "npm" "Install Node.js 22 or newer first."
Require-Command "git" "Install Git for Windows first."

if (-not (Get-Command "devspace" -ErrorAction SilentlyContinue)) {
  Write-Host "Installing DevSpace..."
  npm install -g "@waishnav/devspace"
}

$RepoDir = Join-Path $env:USERPROFILE "CodasSol-Router"
if (-not (Test-Path $RepoDir)) {
  git clone "https://github.com/SeanWu089/CodasSol-Router.git" $RepoDir
} else {
  git -C $RepoDir pull --ff-only
}

$DevSpaceAuth = Join-Path $env:USERPROFILE ".devspace\auth.json"
if (-not (Test-Path $DevSpaceAuth)) {
  Write-Host ""
  Write-Host "DevSpace needs first-time initialization."
  Write-Host "When asked where you will use DevSpace, choose Coding Agents only."
  Write-Host "No public URL or second tunnel is needed for this Windows machine."
  Write-Host ""
  devspace init
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
} catch {
  Write-Host "Starting Windows DevSpace from $env:USERPROFILE ..."
  $Args = @("-NoProfile", "-Command", "Set-Location '$env:USERPROFILE'; devspace serve")
  Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList $Args
  $Ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:7676/healthz" -TimeoutSec 2 | Out-Null
      $Ready = $true
      break
    } catch {}
  }
  if (-not $Ready) {
    throw "Windows DevSpace did not become ready on 127.0.0.1:7676."
  }
}

Push-Location $RepoDir
try {
  & node "src/agent.js" "enroll" "--router" $RouterUrl "--pairing-token" $PairingToken "--device-id" $DeviceId "--label" $Label "--roots" $Roots
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Enrollment complete."
Write-Host "For the first test, run:"
Write-Host ('  cd "' + $RepoDir + '"')
Write-Host "  node src/agent.js run"

