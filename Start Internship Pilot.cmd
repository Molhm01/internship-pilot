@echo off
REM Safe Windows launcher for Internship Pilot.
REM - Opens this repo in VS Code (reusing an existing window)
REM - Starts the ONE canonical local command (npm run local)
REM - npm run local itself refuses to start a second copy if one is healthy,
REM   and opens the browser only after health checks pass.
REM No secrets are stored in this file.

cd /d "%~dp0"

REM Open the folder in VS Code, reusing the current window if one is open.
where code >nul 2>nul && code -r .

REM Start the canonical local stack. This handles port checks, migrations,
REM starting exactly one worker, waiting for health, and opening the browser.
call npm.cmd run local

REM Keep the window open if npm exited immediately (e.g. already running).
if errorlevel 1 pause
