function Invoke-CleanWorker($Mode,$Root,$Names,$Owner,$Modes=@(),$Seconds=60) {
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{mode=$Mode;root=$Root;names=$Names;owner=$Owner;modes=$Modes}|ConvertTo-Json -Compress)))
 $worker=Join-Path $PSScriptRoot 'worker.ps1'
 $process=Start-Process powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-File',('"'+$worker+'"'),'-Encoded',$encoded) -NoNewWindow -PassThru
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while(-not $process.WaitForExit(1000)){if($clock.Elapsed.TotalSeconds -ge $Seconds){$process.Kill();throw "TIMEOUT_$Mode : stopped this worker only; task state may be partial. No further steps executed."};if([int]$clock.Elapsed.TotalSeconds % 5 -eq 0){Write-Host "[$Mode] still working ($([int]$clock.Elapsed.TotalSeconds)s)"}}
 $process.WaitForExit();if($process.ExitCode -ne 0){throw "FAILED_$Mode (exit $($process.ExitCode)); no further steps executed."}
}
function Get-CleanPlan($Base) {
 [pscustomobject]@{oldRoot=(Join-Path $Base 'NodeV02Standalone');newRoot=(Join-Path $Base 'NodeCleanR1');oldStatePreserved=$true;sharedDevspaceUntouched=$true}
}
function Move-OldRuntimeBestEffort($Source,$Destination,$Move={param($s,$d)[IO.Directory]::Move($s,$d)}) {
 if(-not(Test-Path -LiteralPath $Source)){return 'ABSENT'}
 try{& $Move $Source $Destination;return 'QUARANTINED'}catch [UnauthorizedAccessException]{return 'PRESERVED_ACCESS_DENIED'}catch [IO.IOException]{return 'PRESERVED_LOCKED_OR_IO_ERROR'}
}
