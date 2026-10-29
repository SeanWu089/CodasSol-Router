@echo off
setlocal
title CodasSol legacy cleanup (after successful v0.2 verification)
powershell.exe -NoLogo -NoProfile -File "%~dp0cleanup-old.ps1"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
