$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $InstallRoot "node\node.exe"
$RouterScript = Join-Path $InstallRoot "app\server.js"
$StateDir = Join-Path $env:USERPROFILE ".codassol"
$RootsFile = Join-Path $StateDir "roots.txt"
$SettingsFile = Join-Path $StateDir "router-node.json"

if (-not (Test-Path $NodeExe) -or -not (Test-Path $RouterScript)) {
  throw "CodasSol Router runtime is missing."
}
if (-not (Test-Path $RootsFile)) { throw "CodasSol Router roots file is missing: $RootsFile" }
$Roots = ([string](Get-Content $RootsFile -Raw)).Trim()
if ([string]::IsNullOrWhiteSpace($Roots)) { throw "CodasSol Router roots are empty." }

$env:CODASSOL_STATE_DIR = $StateDir
$env:CODASSOL_LOCAL_DEVICE_ID = $env:COMPUTERNAME
$env:CODASSOL_LOCAL_DEVICE_LABEL = $env:COMPUTERNAME
$env:CODASSOL_LOCAL_ROOTS = $Roots
$env:CODASSOL_LISTEN_HOST = "127.0.0.1"
$env:CODASSOL_LISTEN_PORT = "17676"

# Explicit, local-only by default. A trusted private overlay may supply a
# listener setting; never automatically expose the Router on the public LAN.
if (Test-Path $SettingsFile) {
  $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json
  if ($settings.listenHost -in @("127.0.0.1", "0.0.0.0", "::1")) {
    $env:CODASSOL_LISTEN_HOST = $settings.listenHost
  }
  if ($settings.allowInsecurePeers -eq $true) {
    $env:CODASSOL_ALLOW_INSECURE_PEERS = "1"
  }
}

Set-Location (Join-Path $InstallRoot "app")
& $NodeExe $RouterScript
exit $LASTEXITCODE
