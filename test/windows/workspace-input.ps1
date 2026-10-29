$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\workspace-input.ps1')
$script:answers=[Collections.Generic.Queue[string]]::new()
foreach($value in @('', 'relative', 'C:\missing', ('"'+$env:TEMP+'"'))){$script:answers.Enqueue($value)}
$result=Read-WorkspaceFolder {param($p) $script:answers.Dequeue()}
if($result -ne [IO.Path]::GetFullPath($env:TEMP)){throw 'Retry did not retain valid path'}
if($script:answers.Count -ne 0){throw 'Input unexpectedly skipped'}
$failed=$false;try{Read-WorkspaceFolder {param($p) 'CANCEL'}}catch{$failed=$true};if(-not $failed){throw 'Cancellation failed'}
Write-Host 'PASS blank/relative/missing retry, quoted path, cancellation'
