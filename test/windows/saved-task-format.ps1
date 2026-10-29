$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\standalone\recovery-support.ps1')
function Assert($b,$m){if(-not $b){throw $m}}
function MustFail($body){$failed=$false;try{& $body}catch{$failed=$true};Assert $failed 'Unsafe record accepted'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('codas-task-format-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $temp | Out-Null
try {
 $root='C:\Example\NodeV02Standalone';$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $file=Join-Path $temp 'tasks.json';$records=@()
 foreach($mode in @('DevSpace','Router','Outbound')){
  $xml='<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal><UserId>'+ $owner +'</UserId></Principal></Principals><Actions><Exec><Command>'+ $root +'\node\node.exe</Command><Arguments>"'+ $root +'\runtime\supervisor.mjs" '+$mode.ToLower()+'</Arguments></Exec></Actions></Task>'
  $records+=@{name=('CodasSol Standalone V02 '+$mode);running=$true;xml=$xml}
 }
 # Exact rc.1 write expression: singleton object vs multi-record JSON array.
 foreach($count in @(1,2,3)) {
  $fixture=@($records|Select-Object -First $count)
  $fixture | ConvertTo-Json -Depth 8 | Set-Content $file -Encoding UTF8
  $loaded=@(Read-SavedTasks $file $root $owner)
  Assert ($loaded.Count -eq $count) "rc.1 round-trip count $count failed"
  for($i=0;$i -lt $count;$i++){Assert ($loaded[$i].name -eq $fixture[$i].name) 'Name changed';Assert ($loaded[$i].xml -eq $fixture[$i].xml) 'XML changed'}
 }
 # Reproduce the old rescue expression on Windows PowerShell 5.1.
 $old=@(Get-Content $file -Raw | ConvertFrom-Json)
 if($PSVersionTable.PSVersion.Major -eq 5){Assert ($old.Count -eq 1 -and $old[0] -is [array]) 'Expected legacy wrapped-array reproduction';Assert ($old[0].name -notin @($records|ForEach-Object {$_.name})) 'Expected old saved-name check failure'}
 ConvertTo-Json -InputObject @() | Set-Content $file;Assert (@(Read-SavedTasks $file $root $owner).Count -eq 0) 'Empty list rejected'
 foreach($kind in @('name','duplicate','running','xmlpath','owner','taskpath','nested')){
  $bad=@{name=$records[0].name;running=$true;xml=$records[0].xml}
  switch($kind){
   name {$bad.name='Unrelated Application'}
   running {$bad.running='false'}
   xmlpath {$bad.xml=$bad.xml.Replace($root,'C:\Unrelated')}
   owner {$bad.xml=$bad.xml.Replace($owner,'S-1-5-18')}
   taskpath {$bad.TaskPath='\Other\'}
  }
  if($kind -eq 'duplicate'){ConvertTo-Json -InputObject @($bad,$bad) -Depth 8 | Set-Content $file}
  elseif($kind -eq 'nested'){Set-Content $file ('[['+($bad|ConvertTo-Json -Depth 8)+']]')}
  else{$bad|ConvertTo-Json -Depth 8|Set-Content $file}
  MustFail {Read-SavedTasks $file $root $owner}
 }
 Write-Host 'PASS: exact rc.1 single/multiple task format, legacy failure reproduced, identity/path/name rejection'
} finally {Remove-Item -LiteralPath $temp -Recurse -Force}
