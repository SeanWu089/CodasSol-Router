@echo off
setlocal
set "CODASSOL_RESCUE_DIR=%~dp0"
powershell.exe -NoLogo -NoProfile -Command "@('rescue.ps1','recovery-support.ps1','health-diagnostics.ps1') | ForEach-Object { Unblock-File -LiteralPath (Join-Path $env:CODASSOL_RESCUE_DIR $_) -ErrorAction Stop }; & (Join-Path $env:CODASSOL_RESCUE_DIR 'rescue.ps1')"
echo.
pause
