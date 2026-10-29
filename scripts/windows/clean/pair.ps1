$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'clean-support.ps1')
$root=Join-Path $env:LOCALAPPDATA 'CodasSol\NodeCleanR1'
$node=Join-Path $root 'node\node.exe'
$env:CODASSOL_STATE_DIR=Join-Path $root 'state'
$env:DEVSPACE_CONFIG_DIR=Join-Path $root 'devspace-config'
$env:CODASSOL_DEVSPACE_AUTH_FILE=Join-Path $root 'devspace-config\auth.json'
Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
if((Read-Host 'Type PAIR to authorize remote registration now; Enter for local-only') -cne 'PAIR'){Write-Host 'LOCAL ONLY. Use PAIR.cmd later.';return}
$url=Read-Host 'Explicit HTTPS Router origin'
$secure=Read-Host 'Pairing token (hidden)' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try{
 $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 @{routerUrl=$url;pairingToken=$token}|ConvertTo-Json -Compress|& $node (Join-Path $root 'runtime\enrollment.mjs') enroll
 if($LASTEXITCODE -ne 0){throw 'REMOTE_REGISTRATION_FAILED'}
}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$token=$null;$secure=$null}
Invoke-CleanWorker 'tasks' $root @() ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) @('Outbound')
Write-Host 'Registered. A real remote execution test is still required.'
