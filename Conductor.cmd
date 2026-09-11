@echo off
REM Fallback launcher (Conductor.exe is the friendly one). Starts the app and opens your browser.
cd /d "%~dp0"
title Conductor 2.0
node bin\conductor.mjs start
pause
