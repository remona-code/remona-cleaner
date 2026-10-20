@echo off
rem ===========================================================================
rem  reMona (AICleaner) - desktop launcher
rem  Double-click it; it installs any missing dependencies itself.
rem ===========================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_EXE=node_modules\electron\dist\electron.exe"

if exist "%ELECTRON_EXE%" goto run

echo.
echo  First run - installing dependencies.
echo  This may take a few minutes, please wait...
echo.

where node >nul 2>nul
if errorlevel 1 goto nodemissing

call npm install --no-audit --no-fund
if errorlevel 1 goto installfail

if not exist "%ELECTRON_EXE%" (
  echo.
  echo  Downloading the Electron binary...
  call node "node_modules\electron\install.js"
  if errorlevel 1 goto installfail
)

:run
start "" "%ELECTRON_EXE%" .
exit /b 0

:nodemissing
echo.
echo  ERROR: Node.js was not found.
echo  Install the LTS release from https://nodejs.org and try again.
echo.
pause
exit /b 1

:installfail
echo.
echo  ERROR: Dependencies could not be installed.
echo  Check your internet connection and run this file again.
echo.
pause
exit /b 1
