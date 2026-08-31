@echo off
setlocal
cd /d "%~dp0"

set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%PWSH%" (
  echo PowerShell 7 was not found:
  echo %PWSH%
  echo.
  pause
  exit /b 1
)

"%PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package-client.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Packaging failed. Review the error above.
) else (
  echo Packaging completed successfully.
)
pause
exit /b %EXIT_CODE%
