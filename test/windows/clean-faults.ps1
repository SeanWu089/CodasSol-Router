$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\clean-support.ps1')
. (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\recovery-support.ps1')
. (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\health-diagnostics.ps1')
function Assert($c,$m){if(-not $c){throw $m}}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('codas-clean-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp|Out-Null
try{
 $plan=Get-CleanPlan $temp
 Assert ($plan.newRoot -eq (Join-Path $temp 'NodeCleanR1')) 'Wrong clean root'
 Assert ($plan.oldStatePreserved -and $plan.sharedDevspaceUntouched) 'Shared data must remain untouched'
 Assert ((Move-OldRuntimeBestEffort $plan.oldRoot (Join-Path $temp 'q')) -eq 'ABSENT') 'Fresh install requires no backup'
 New-Item -ItemType Directory -Path $plan.oldRoot|Out-Null
 Set-Content (Join-Path $plan.oldRoot 'held') 'old-state'
 Set-Content (Join-Path $temp 'project.txt') 'project-sentinel'
 foreach($mode in @('denied','locked')){
  $move={param($s,$d) if($mode -eq 'denied'){throw [UnauthorizedAccessException]::new('injected')}else{throw [IO.IOException]::new('injected')}}
  $result=Move-OldRuntimeBestEffort $plan.oldRoot (Join-Path $temp 'q') $move
  Assert ($result -match '^PRESERVED_') 'Denied/locked runtime must be preserved'
  Assert ((Get-Content (Join-Path $plan.oldRoot 'held')) -eq 'old-state') 'Old state damaged'
 }
 # Actual Windows file handle lock, independent new root remains usable.
 $held=[IO.File]::Open((Join-Path $plan.oldRoot 'held'),'Open','Read','None')
 try{Assert ((Move-OldRuntimeBestEffort $plan.oldRoot (Join-Path $temp 'q')) -match '^PRESERVED_') 'Lock not preserved'}finally{$held.Dispose()}
 New-Item -ItemType Directory -Path $plan.newRoot|Out-Null
 Assert (-not(Test-Path (Join-Path $plan.newRoot 'held'))) 'Old state reused'
 Assert ((Get-Content (Join-Path $temp 'project.txt')) -eq 'project-sentinel') 'Project touched'
 # Partially restored sibling and backup must not be enumerated as cleanup targets.
 New-Item -ItemType Directory -Path (Join-Path $temp 'NodeV02Standalone.restore-fixture'),(Join-Path $temp 'Backups')|Out-Null
 Assert ((Move-OldRuntimeBestEffort $plan.oldRoot (Join-Path $temp 'q')) -eq 'QUARANTINED') 'Quarantine failed'
 Assert (Test-Path (Join-Path $temp 'NodeV02Standalone.restore-fixture')) 'Restore sibling touched'
 function Invoke-CimMethod {param($InputObject,$MethodName) @{ReturnValue=0;Sid='owner'}}
 $p=[pscustomobject]@{ExecutablePath=(Join-Path $plan.oldRoot 'node\node.exe');CommandLine='unknown-job'}
 $rejected=$false;try{Assert-RuntimeProcess $p $plan.oldRoot 'owner'}catch{$rejected=$true};Assert $rejected 'Unknown process accepted'
 function Invoke-RestMethod {param($Uri,$TimeoutSec,$ErrorAction) if($Uri -eq 'good'){@{ok=$true;name='devspace';backendReachable=$true}}else{throw 'PRIVATE_ERROR_SENTINEL'}}
 Assert (Get-SafeHealth 'devspace' 'good').ok 'Good health rejected'
 $h=Get-SafeHealth 'devspace' 'bad';Assert (-not $h.ok) 'Failed health accepted';Assert (($h|ConvertTo-Json) -notmatch 'PRIVATE_ERROR_SENTINEL') 'Diagnostic leaked'
 Write-Host 'PASS: clean/no backup, access denial, actual file lock, independent state, partial recovery, project preservation, ownership and redacted health.'
}finally{Remove-Item -LiteralPath $temp -Recurse -Force}
