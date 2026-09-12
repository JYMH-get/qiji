@echo off
chcp 65001 >nul
setlocal
call "%~dp0打包可分享应用.bat" %*
exit /b %ERRORLEVEL%
