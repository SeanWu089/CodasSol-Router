function Read-WorkspaceFolder($Read={param($prompt) Read-Host $prompt},$Exists={param($path) Test-Path -LiteralPath $path -PathType Container}) {
 while($true){
  $value=& $Read 'Project folder (example C:\Users\YourName\Desktop; type DESKTOP for your actual Desktop, or CANCEL)'
  if($null -eq $value){throw 'CONSOLE_INPUT_UNAVAILABLE: open this command in an interactive PowerShell window'}
  $value=([string]$value).Trim().Trim('"')
  if($value -ieq 'CANCEL'){throw 'WORKSPACE_SELECTION_CANCELLED: installed files preserved'}
  if($value -ieq 'DESKTOP'){$value=[Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)}
  if([string]::IsNullOrWhiteSpace($value)){Write-Host 'No folder entered. Enter an absolute folder path, or DESKTOP. Pressing Enter alone does not continue.';continue}
  if(-not [IO.Path]::IsPathRooted($value) -or $value.Contains('|') -or -not(& $Exists $value)){Write-Host 'Folder must exist. Example: C:\Users\YourName\Desktop or D:\Projects. You can also enter DESKTOP.';continue}
  return [IO.Path]::GetFullPath($value)
 }
}
