$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\clean-support.ps1')
$temp=Join-Path $env:TEMP ('codas process fixture '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp|Out-Null
try {
 $bundle=Join-Path $temp 'bundle';$root=Join-Path $temp 'runtime'
 New-Item -ItemType Directory -Path $root|Out-Null
 foreach($part in @('node','app','runtime')){New-Item -ItemType Directory -Path (Join-Path $bundle ('payload\'+$part)) -Force|Out-Null;Set-Content (Join-Path $bundle ('payload\'+$part+'\fixture.txt')) 'test'}
 # Actual shipped wrapper and worker, real PowerShell 5.1 subprocess, spaced paths.
 Invoke-CleanWorker 'stage' $root @() 'fixture-owner' @($bundle) 15
 if(-not(Test-Path (Join-Path $root 'app\fixture.txt'))){throw 'STAGE_NOT_EXECUTED'}
 $failed=$false;try{Invoke-CleanWorker 'invalid-mode' $root @() 'fixture-owner' @() 15}catch{$failed=$true;if($_.Exception.Message -notmatch 'exit 1'){throw}}
 if(-not $failed){throw 'NONZERO_CHILD_ACCEPTED'}
 # Controlled real child for timeout; no live tasks/process scanning or mutation.
 $copy=Join-Path $temp 'timeout';New-Item -ItemType Directory -Path $copy|Out-Null
 Copy-Item (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\clean-support.ps1') $copy
 Set-Content (Join-Path $copy 'worker.ps1') 'param($Encoded); Start-Sleep -Seconds 30'
 . (Join-Path $copy 'clean-support.ps1')
 $failed=$false;try{Invoke-CleanWorker 'timeout-fixture' $root @() 'fixture-owner' @() 1}catch{$failed=$true;if($_.Exception.Message -notmatch 'TIMEOUT_'){throw}}
 if(-not $failed){throw 'TIMEOUT_NOT_ENFORCED'}
 Write-Host 'PASS actual PS5 worker: zero exit, nonzero exit, spaced arguments, timeout'
}finally{Remove-Item -LiteralPath $temp -Recurse -Force}
