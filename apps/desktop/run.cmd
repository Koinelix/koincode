@echo off
setlocal
cd /d "%~dp0"

set "NETWORK=%~1"
if "%NETWORK%"=="" set "NETWORK=testnet"
if not "%~2"=="" goto usage
if /i not "%NETWORK%"=="testnet" if /i not "%NETWORK%"=="mainnet" goto usage

call "%~dp0scripts\windows-env.cmd"
if errorlevel 1 exit /b 1
if not exist "node_modules\typescript\bin\tsc" (
  echo [ERROR] Dependencies are missing. Run build.cmd first.
  exit /b 1
)

call "%PNPM_CMD%" dev:desktop:test --network %NETWORK%
exit /b %errorlevel%

:usage
echo [ERROR] Usage: run.cmd [testnet^|mainnet]
exit /b 1
