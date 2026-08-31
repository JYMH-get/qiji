@echo off
setlocal

cd /d "%~dp0"
title Qiji Dev Environment Controller

set "QijiPwsh=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%QijiPwsh%" (
  echo PowerShell 7 was not found: %QijiPwsh%
  echo Install Microsoft.PowerShell first.
  pause
  exit /b 1
)

"%QijiPwsh%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1" %*
set "QijiExitCode=%ERRORLEVEL%"

if not "%QijiExitCode%"=="0" (
  echo.
  echo Qiji development environment failed. Exit code: %QijiExitCode%
  echo Review the error above.
  pause
)

exit /b %QijiExitCode%
