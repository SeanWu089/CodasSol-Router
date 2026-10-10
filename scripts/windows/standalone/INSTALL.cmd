@echo off
setlocal
title CodasSol Windows Standalone Node v0.2
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -File "%~dp0install.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Installation was NOT verified. Read the error above; do not disable endpoint protection.
) else (
  echo Windows independent node verified. Run CLEANUP-OLD.cmd to archive legacy installations.
)
echo.
pause
exit /b %RC%
