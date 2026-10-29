function Invoke-CleanWorker($Mode,$Root,$Names,$Owner,$Modes=@(),$Seconds=60) {
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{mode=$Mode;root=$Root;names=$Names;owner=$Owner;modes=$Modes}|ConvertTo-Json -Compress)))
 $worker=Join-Path $PSScriptRoot 'worker.ps1'
 # Own the process handle from creation; Start-Process -PassThru on Windows
 # PowerShell 5.1 can leave ExitCode unavailable after its wait helper releases it.
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=Join-Path $PSHOME 'powershell.exe'
 $start.Arguments='-NoLogo -NoProfile -File "'+$worker+'" -Encoded '+$encoded
 $start.UseShellExecute=$false
 $process=New-Object Diagnostics.Process
 $process.StartInfo=$start
 if(-not $process.Start()){throw 'WORKER_START_FAILED'}
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while(-not $process.WaitForExit(1000)){if($clock.Elapsed.TotalSeconds -ge $Seconds){$process.Kill();throw "TIMEOUT_$Mode : stopped this worker only; task state may be partial. No further steps executed."};if([int]$clock.Elapsed.TotalSeconds % 5 -eq 0){Write-Host "[$Mode] still working ($([int]$clock.Elapsed.TotalSeconds)s)"}}
 $process.WaitForExit();$exitCode=$process.ExitCode;$process.Dispose();if($null -eq $exitCode -or $exitCode -ne 0){throw "FAILED_$Mode (exit $exitCode); no further steps executed."}
}
function Get-CleanPlan($Base) {
 [pscustomobject]@{oldRoot=(Join-Path $Base 'NodeV02Standalone');newRoot=(Join-Path $Base 'NodeCleanR1');oldStatePreserved=$true;sharedDevspaceUntouched=$true}
}
function Move-OldRuntimeBestEffort($Source,$Destination,$Move={param($s,$d)[IO.Directory]::Move($s,$d)}) {
 if(-not(Test-Path -LiteralPath $Source)){return 'ABSENT'}
 try{& $Move $Source $Destination;return 'QUARANTINED'}catch [UnauthorizedAccessException]{return 'PRESERVED_ACCESS_DENIED'}catch [IO.IOException]{return 'PRESERVED_LOCKED_OR_IO_ERROR'}
}
