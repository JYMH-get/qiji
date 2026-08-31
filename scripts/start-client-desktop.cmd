@echo off
cd /d "%~dp0.."
title Qiji Desktop Client
set "QIJI_DEV_MARKER=QijiDevClient"
call npm run dev:desktop
echo.
echo Qiji desktop client process exited with code %ERRORLEVEL%.

