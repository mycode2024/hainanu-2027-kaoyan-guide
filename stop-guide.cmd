@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
set "guide_exit=%errorlevel%"
if not "%guide_exit%"=="0" pause
exit /b %guide_exit%
