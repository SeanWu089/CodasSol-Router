@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -Command "Get-ChildItem -LiteralPath . -Recurse -File | Unblock-File; & './pair.ps1'"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
