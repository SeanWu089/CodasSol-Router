@echo off
setlocal
title CodasSol Windows Standalone Node v0.2
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -Command "Get-ChildItem -LiteralPath . -Recurse -File | Unblock-File; & './transaction.ps1' -SkipSentinelPrompt"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Installation was NOT verified. Read the error above; do not disable endpoint protection.
) else (
  echo Installation completed. See the verified local and registration status above.
)
echo.
pause
exit /b %RC%
