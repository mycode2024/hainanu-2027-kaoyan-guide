@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer was not found. Install it first:
  echo https://nodejs.org/
  pause
  exit /b 1
)

echo Starting the Hainan University 2027 guide...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"
set "guide_exit=%errorlevel%"
if not "%guide_exit%"=="0" (
  echo.
  echo Launch failed. Review the message above or the error log in data.
  pause
)
exit /b %guide_exit%
