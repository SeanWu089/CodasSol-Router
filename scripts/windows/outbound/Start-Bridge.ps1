$ErrorActionPreference='Stop'
$node=Join-Path $env:LOCALAPPDATA 'CodasSol\NodeV02Standalone\node\node.exe'
if(-not (Test-Path $node)){throw 'Installed private Node runtime missing'}
$script=Join-Path $PSScriptRoot 'bridge.mjs'
$config=Join-Path $env:USERPROFILE '.codassol-node-v02\outbound-agent.json'
if(-not (Test-Path $config)){
 $secure=Read-Host 'Paste Mac Router pairing token (hidden)' -AsSecureString
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
 try {
  $token=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $token | & $node $script --enroll
  if($LASTEXITCODE -ne 0){throw 'Pairing failed; no bridge was started'}
 }finally{
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $token=$null;$secure=$null
 }
}
 $reload=Join-Path $env:USERPROFILE '.codassol-node-v02\outbound-router-reload-required'
 if(Test-Path $reload){
  $task=Get-ScheduledTask -TaskName 'CodasSol Standalone V02 Router'
  $root=Join-Path $env:LOCALAPPDATA 'CodasSol\NodeV02Standalone'
  $expected='-NoLogo -NoProfile -File "'+(Join-Path $root 'runtime\start-router.ps1')+'"'
  $account=New-Object Security.Principal.NTAccount($task.Principal.UserId)
  if($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne 'powershell.exe' -or $task.Actions[0].Arguments -ne $expected -or $account.Translate([Security.Principal.SecurityIdentifier]).Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Router task ownership mismatch; no task stopped'}
  Stop-ScheduledTask -TaskName $task.TaskName
  Start-Sleep -Seconds 2
  $listener=Get-NetTCPConnection -LocalPort 17678 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if($listener){
   $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
   $ownerSid=Invoke-CimMethod -InputObject $owner -MethodName GetOwnerSid
   if($owner.ExecutablePath -ne $node -or $owner.CommandLine -notlike ('*'+(Join-Path $root 'app\server.js')+'*') -or $ownerSid.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Router listener ownership mismatch; no listener killed'}
   Stop-Process -Id $listener.OwningProcess
  }
  Start-ScheduledTask -TaskName $task.TaskName
  $ready=$false
  for($i=0;$i -lt 15;$i++){
   Start-Sleep -Seconds 2
   try{$h=Invoke-RestMethod 'http://127.0.0.1:17678/_codassol/health' -TimeoutSec 2;if($h.ok -and $h.backendReachable){$ready=$true;break}}catch{}
  }
  if(-not $ready){throw 'Windows Router not ready; keep backups and inspect its supervisor log'}
  Remove-Item -LiteralPath $reload
 }
$ErrorActionPreference='Continue'
& $node $script
if($LASTEXITCODE -ne 0){throw 'Outbound bridge stopped with an error'}
