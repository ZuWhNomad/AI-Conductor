@echo off
rem Double-click to run Conductor 2.0 in its own titled window.
rem The window appears on the taskbar; closing it (or Ctrl+C) stops the server.
title Conductor 2.0
cd /d "%~dp0"
node bin\conductor.mjs
echo.
echo Conductor stopped. Press any key to close this window.
pause >nul
