$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\windows\clean\resume-support.ps1')
$temp=Join-Path $env:TEMP ('redirected desktop '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $temp|Out-Null
try{
 if((Get-ResumeDesktop {$temp}) -ne [IO.Path]::GetFullPath($temp).TrimEnd('\')){throw 'Redirected Desktop lost'}
 foreach($bad in @('', 'relative', $env:USERPROFILE, [IO.Path]::GetPathRoot($temp))){$failed=$false;try{Get-ResumeDesktop {$bad}}catch{$failed=$true};if(-not $failed){throw 'Unsafe Desktop accepted'}}
 Write-Host 'PASS redirected folder, empty/relative/profile/disk rejection'
}finally{Remove-Item -LiteralPath $temp}
