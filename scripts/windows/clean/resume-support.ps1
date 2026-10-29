function Get-ResumeDesktop($Resolve={ [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory) }) {
 # .NET resolves the current user's Windows shell known folder, including redirection.
 $path=& $Resolve
 if([string]::IsNullOrWhiteSpace($path) -or -not [IO.Path]::IsPathRooted($path) -or -not(Test-Path -LiteralPath $path -PathType Container) -or $path.Contains('|')){throw 'DESKTOP_KNOWN_FOLDER_UNAVAILABLE'}
 $full=[IO.Path]::GetFullPath($path).TrimEnd('\')
 if($full -ieq $env:USERPROFILE.TrimEnd('\') -or $full -ieq [IO.Path]::GetPathRoot($full).TrimEnd('\')){throw 'DESKTOP_SCOPE_TOO_BROAD'}
 return $full
}
