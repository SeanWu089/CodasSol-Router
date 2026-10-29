$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\standalone\recovery-support.ps1')
. (Join-Path $PSScriptRoot '..\..\scripts\windows\standalone\health-diagnostics.ps1')
function Assert($Condition,$Message) {if(-not $Condition){throw $Message}}
function MustFail($Action) {$caught=$false;try{& $Action}catch{$caught=$true};Assert $caught 'Expected failure'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('codas-recovery-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $temp | Out-Null
try {
 foreach($mode in @('success','first-rename-fails','second-rename-fails')) {
    $base=Join-Path $temp $mode; $root=Join-Path $base 'runtime';$backup=Join-Path $base 'backup'
    New-Item -ItemType Directory -Force $root,(Join-Path $backup 'runtime') | Out-Null
    Set-Content (Join-Path $root 'value.txt') 'candidate'
    Set-Content (Join-Path $backup 'runtime\value.txt') 'old'
    $script:renameCount=0
    $rename={param($a,$b) $script:renameCount++; if(($mode -eq 'first-rename-fails' -and $script:renameCount -eq 1) -or ($mode -eq 'second-rename-fails' -and $script:renameCount -eq 2)){throw 'Injected lock'};[IO.Directory]::Move($a,$b)}
    if($mode -eq 'success'){Switch-RuntimeForRollback $root $backup $rename;Assert ((Get-Content "$root\value.txt") -eq 'old') 'Restore failed'}
    else{MustFail {Switch-RuntimeForRollback $root $backup $rename};Assert ((Get-Content "$root\value.txt") -eq 'candidate') 'Candidate lost on rename failure'}
    Assert ((Get-Content "$backup\runtime\value.txt") -eq 'old') 'Backup damaged'
    Assert (Test-Path "$backup\journal.jsonl") 'Missing journal'
 }
 # Wrong executable / owner / command must fail before any termination.
 function Invoke-CimMethod {param($InputObject,$MethodName) @{ReturnValue=0;Sid=$InputObject.TestSid}}
 $root='C:\Test\Runtime'; $p=[pscustomobject]@{ExecutablePath='C:\Other\node.exe';CommandLine='';TestSid='owner'}
 MustFail {Assert-RuntimeProcess $p $root 'owner'}
 $p.ExecutablePath='C:\Test\Runtime\node\node.exe'; $p.CommandLine='"C:\Test\Runtime\node\node.exe" "C:\Test\Runtime\app\server.js"'
 $p.TestSid='foreign';MustFail {Assert-RuntimeProcess $p $root 'owner'}
 $p.TestSid='owner';Assert-RuntimeProcess $p $root 'owner'
 $p.CommandLine='"C:\Test\Runtime\node\node.exe" arbitrary-user-job.js';MustFail {Assert-RuntimeProcess $p $root 'owner'}
 # Sensitive exception text must not appear in the diagnostic object.
 function Invoke-RestMethod {throw 'SECRET_SENTINEL_DO_NOT_EXPORT'}
 $h=Get-SafeHealth 'devspace' 'http://example.invalid';Assert (-not $h.reachable) 'Failure hidden'
 Assert (($h|ConvertTo-Json) -notmatch 'SECRET_SENTINEL') 'Exception leaked'
 Write-Host 'PASS: rollback rename faults, backup preservation, ownership/command guards, diagnostic redaction'
} finally {Remove-Item -LiteralPath $temp -Recurse -Force}
