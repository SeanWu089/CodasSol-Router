$ErrorActionPreference='Stop'
$bundle=$PSScriptRoot
. (Join-Path $bundle 'clean-support.ps1')
. (Join-Path $bundle 'recovery-support.ps1')
. (Join-Path $bundle 'health-diagnostics.ps1')
$base=Join-Path $env:LOCALAPPDATA 'CodasSol'
$plan=Get-CleanPlan $base
$root=$plan.newRoot
$names=@('CodasSol Standalone V02 DevSpace','CodasSol Standalone V02 Router','CodasSol Standalone V02 Outbound')
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$lock=$null;$phase='PREFLIGHT'
function Step($value){$script:phase=$value;Write-Host "`n==> $value" -ForegroundColor Cyan;if($script:journal){[IO.File]::AppendAllText($script:journal,((@{phase=$value;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress)+[Environment]::NewLine))}}
try {
 Set-Location -LiteralPath $env:TEMP
 [Environment]::CurrentDirectory=$env:TEMP
 if(($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') -and ($env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')){throw 'WINDOWS_X64_REQUIRED'}
 if(Test-Path -LiteralPath $root){& (Join-Path $bundle 'resume-workspace.ps1');exit $LASTEXITCODE}
 if($bundle.StartsWith($plan.oldRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $bundle -eq $plan.oldRoot){throw 'EXTRACT_PACKAGE_OUTSIDE_OLD_RUNTIME'}
 Assert-NoReparseTree $bundle
 if((Test-Path -LiteralPath $base) -and ((Get-Item -LiteralPath $base).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'REPARSE_BASE_REQUIRES_REVIEW'}
 $manifest=Get-Content -LiteralPath (Join-Path $bundle 'release-manifest.json') -Raw|ConvertFrom-Json
 Write-Host 'Checking package checksums...'
 $checked=0
 foreach($entry in $manifest.files.PSObject.Properties){$checked++;if($checked % 100 -eq 0){Write-Host "Verified $checked package files"};$file=Join-Path $bundle $entry.Name;if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value){throw 'PACKAGE_CHECKSUM_MISMATCH'}}
 Invoke-CleanWorker 'inspect' $plan.oldRoot $names $owner
 Write-Host "Old owned tasks to disable/stop: $($names -join ', ')"
 Write-Host "Old runtime to quarantine if movable: $($plan.oldRoot)"
 Write-Host "Fresh private installation/configuration: $root"
 Write-Host 'Old backups, shared .devspace, old pairing state and project files remain untouched and will NOT be read by this installation.'
 Write-Host 'If the old directory is locked or access denied, retain it and use the new path. No ACL or security policy changes.'
 if((Read-Host 'Type CLEAN to perform exactly this plan') -cne 'CLEAN'){throw 'CANCELLED_NO_CHANGES'}
 New-Item -ItemType Directory -Force -Path $base|Out-Null
 $lock=[IO.File]::Open((Join-Path $base 'standalone-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 $journal=Join-Path $base ('clean-'+[guid]::NewGuid().ToString('N')+'.jsonl')
 Step 'QUIESCING_OLD_OWNED_RUNTIME'
 Invoke-CleanWorker 'stop' $plan.oldRoot $names $owner
 Step 'CHECKING_PORTS'
 Invoke-CleanWorker 'ports' $root @() $owner
 Step 'QUARANTINING_OLD_RUNTIME'
 $quarantine=Join-Path $base ('NodeV02Standalone.quarantine-'+[guid]::NewGuid().ToString('N'))
 Write-Host (Move-OldRuntimeBestEffort $plan.oldRoot $quarantine)
 Step 'STAGING_FRESH_FILES'
 New-Item -ItemType Directory -Path $root|Out-Null
 Invoke-CleanWorker 'stage' $root @() $owner @($bundle) 180
 $node=Join-Path $root 'node\node.exe'
 $env:PATH=(Join-Path $root 'node')+';'+$env:PATH
 $env:DEVSPACE_CONFIG_DIR=Join-Path $root 'devspace-config'
 $env:CODASSOL_DEVSPACE_AUTH_FILE=Join-Path $env:DEVSPACE_CONFIG_DIR 'auth.json'
 $env:CODASSOL_STATE_DIR=Join-Path $root 'state'
 Remove-Item Env:DEVSPACE_OAUTH_OWNER_TOKEN -ErrorAction SilentlyContinue
 foreach($dir in @('state','logs','devspace-config','devspace-state','worktrees','devspace')){New-Item -ItemType Directory -Path (Join-Path $root $dir) -Force|Out-Null}
 Step 'INSTALLING_PINNED_DEVSPACE_UP_TO_600_SECONDS'
 & $node (Join-Path $root 'runtime\install-dependency.mjs')
 if($LASTEXITCODE -ne 0){throw 'DEPENDENCY_INSTALL_FAILED: preserved new directory; no service tasks created.'}
 $cli=Join-Path $root 'devspace\node_modules\@waishnav\devspace\dist\cli.js'
 & $node $cli --version
 if($LASTEXITCODE -ne 0){throw 'DEVSPACE_CLI_FAILED'}
 Step 'SELECTING_NEW_WORKSPACE_PERMISSION'
 . (Join-Path $bundle 'workspace-input.ps1')
 $roots=Read-WorkspaceFolder
 Write-Host "Selected workspace: $roots (and descendants)"
 [IO.File]::WriteAllText((Join-Path $root 'state\roots.txt'),$roots,(New-Object Text.UTF8Encoding($false)))
 [IO.File]::WriteAllText((Join-Path $root 'state\device-id.txt'),('device-'+[guid]::NewGuid().ToString('D')),(New-Object Text.UTF8Encoding($false)))
 # Configure private storage BEFORE init can create any database/worktree state.
 & $node (Join-Path $root 'runtime\isolate-config.mjs')
 if($LASTEXITCODE -ne 0){throw 'CONFIG_ISOLATION_FAILED'}
 Step 'AWAITING_EXPLICIT_NEW_INITIALIZATION'
 if((Read-Host 'Type INIT to initialize NEW private DevSpace authentication') -cne 'INIT'){throw 'INITIALIZATION_NOT_AUTHORIZED'}
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
