@echo off
setlocal
title CodasSol Windows Node verification
powershell.exe -NoLogo -NoProfile -File "%~dp0verify.ps1"
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
