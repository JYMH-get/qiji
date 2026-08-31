@echo off
cd /d "%~dp0.."
title Qiji Server :8787
set "QIJI_DEV_MARKER=QijiDevServer"
call npm --prefix server run dev
echo.
echo Qiji server process exited with code %ERRORLEVEL%.

