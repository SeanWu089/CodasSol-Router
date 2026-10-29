$ErrorActionPreference='Stop'
$bundle=$PSScriptRoot
. (Join-Path $bundle 'clean-support.ps1')
. (Join-Path $bundle 'recovery-support.ps1')
. (Join-Path $bundle 'health-diagnostics.ps1')
$base=Join-Path $env:LOCALAPPDATA 'CodasSol'
$plan=Get-CleanPlan $base
$root=$plan.newRoot

$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$lock=$null;$phase='PREFLIGHT'
function Step($value){$script:phase=$value;Write-Host "`n==> $value" -ForegroundColor Cyan;if($script:journal){[IO.File]::AppendAllText($script:journal,((@{phase=$value;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress)+[Environment]::NewLine))}}
try {
 Set-Location -LiteralPath $env:TEMP
 [Environment]::CurrentDirectory=$env:TEMP
 if(-not(Test-Path -LiteralPath $root -PathType Container)){throw 'INSTALLED_RUNTIME_MISSING'}
 $lock=[IO.File]::Open((Join-Path $base 'standalone-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 foreach($file in @('state\device-id.txt','state\roots.txt','state\router.json','devspace-config\auth.json')){if(Test-Path -LiteralPath (Join-Path $root $file)){throw 'CHECKPOINT_ALREADY_ADVANCED: existing state preserved'}}
 foreach($mode in @('DevSpace','Router','Outbound')){if(Get-ScheduledTask -TaskName ('CodasSol Clean R1 '+$mode) -TaskPath '\' -ErrorAction SilentlyContinue){throw 'NEW_TASK_ALREADY_EXISTS'}}
 Step 'VERIFYING_EXISTING_RC2_FILES'
 $manifest=Get-Content -LiteralPath (Join-Path $bundle 'installed-files.json') -Raw|ConvertFrom-Json
 $count=0
 foreach($entry in $manifest.PSObject.Properties){$count++;if($count % 200 -eq 0){Write-Host "Verified $count installed files"};if((Get-FileHash -LiteralPath (Join-Path $root $entry.Name) -Algorithm SHA256).Hash -ne $entry.Value){throw 'INSTALLED_FILE_CHECKSUM_MISMATCH'}}
 $node=Join-Path $root 'node\node.exe'
 $env:PATH=(Join-Path $root 'node')+';'+$env:PATH
 $env:DEVSPACE_CONFIG_DIR=Join-Path $root 'devspace-config'
 $env:CODASSOL_DEVSPACE_AUTH_FILE=Join-Path $env:DEVSPACE_CONFIG_DIR 'auth.json'
 $env:CODASSOL_STATE_DIR=Join-Path $root 'state'
 Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
 $cli=Join-Path $root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
 & $node $cli --version
 if($LASTEXITCODE -ne 0){throw 'DEVSPACE_CLI_FAILED'}
 . (Join-Path $bundle 'workspace-input.ps1')
 $roots=Read-WorkspaceFolder
 Write-Host "ONLY authorized workspace: $roots (and descendants)" -ForegroundColor Cyan
 Write-Host 'Continue existing installation. No cleanup, runtime copy, or dependency download.'
 if((Read-Host 'Type INIT to authorize this selected folder and initialize NEW private authentication') -cne 'INIT'){throw 'INITIALIZATION_NOT_AUTHORIZED'}
 $journal=Join-Path $base ('resume-'+[guid]::NewGuid().ToString('N')+'.jsonl')
 Step 'INITIALIZING_DESKTOP_SCOPE'
 [IO.File]::WriteAllText((Join-Path $root 'state\roots.txt'),$roots,(New-Object Text.UTF8Encoding($false)))
 [IO.File]::WriteAllText((Join-Path $root 'state\device-id.txt'),('device-'+[guid]::NewGuid().ToString('D')),(New-Object Text.UTF8Encoding($false)))
 # Configure private storage BEFORE init can create any database/worktree state.
 & $node (Join-Path $root 'runtime\isolate-config.mjs')
 if($LASTEXITCODE -ne 0){throw 'CONFIG_ISOLATION_FAILED'}
 Step 'AWAITING_EXPLICIT_NEW_INITIALIZATION'
 & $node $cli init
 if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $env:CODASSOL_DEVSPACE_AUTH_FILE)){throw 'NEW_AUTHENTICATION_MISSING'}
 & $node (Join-Path $root 'runtime\isolate-config.mjs')
 if($LASTEXITCODE -ne 0){throw 'CONFIG_ISOLATION_FAILED'}
 Step 'STARTING_NEW_PRIVATE_SERVICES'
 Invoke-CleanWorker 'ports' $root @() $owner
 Invoke-CleanWorker 'tasks' $root @() $owner @('DevSpace','Router')
 Step 'VERIFYING_LOCAL_BACKEND'
 $ready=$false
 for($i=0;$i -lt 30;$i++){
  $dv=Get-SafeHealth 'devspace' 'http://127.0.0.1:7676/healthz';$rv=Get-SafeHealth 'router' 'http://127.0.0.1:17678/_codassol/health'
  @{devspace=$dv;router=$rv;attempt=($i+1)}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $root 'logs\health-diagnostic.json') -Encoding UTF8
  Write-Host "Health $($i+1)/30: DevSpace=$($dv.ok) Router=$($rv.ok) Backend=$($rv.backendReachable)"
  if($dv.ok -and $dv.serviceMatches -and $rv.ok -and $rv.backendReachable){$ready=$true;break};Start-Sleep -Seconds 2
 }
 if(-not $ready){Get-Content (Join-Path $root 'logs\health-diagnostic.json')|Write-Host;throw 'BACKEND_NOT_READY: see sanitized health-diagnostic.json; no automatic rollback.'}
 $token=(& $node (Join-Path $root 'app\router-cli.js') peer-token).Trim()
 if($LASTEXITCODE -ne 0 -or -not $token){throw 'LOCAL_PEER_TOKEN_MISSING'}
 $info=Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/peer/info' -Headers @{Authorization="Bearer $token"} -TimeoutSec 4
 $token=$null
 if($info.protocol -ne 2 -or $info.id -ne ([IO.File]::ReadAllText((Join-Path $root 'state\device-id.txt')))){throw 'LOCAL_IDENTITY_MISMATCH'}
 Step 'LOCAL_READY_REMOTE_PAIRING_OPTIONAL'
 & (Join-Path $bundle 'pair.ps1')
 Step 'COMPLETE'
 Write-Host 'Local backend and identity verified. Remote execution/reboot/sleep still require physical acceptance.' -ForegroundColor Green
}catch {
 Write-Host "STOPPED at $phase : $($_.Exception.Message)" -ForegroundColor Red
 Write-Host 'Files and journal preserved. Do not rerun over NodeCleanR1. Do not disable protection or change permissions.'
 exit 1
}finally{if($lock){$lock.Dispose()}}
