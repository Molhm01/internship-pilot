@echo off
REM Safe stop for Internship Pilot. Calls the repository's local:stop, which
REM stops ONLY the processes this repo started (recorded in its lockfile) and
REM never kills unrelated Node processes.

cd /d "%~dp0"
call npm.cmd run local:stop
pause
