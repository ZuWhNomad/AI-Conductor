@echo off
setlocal
REM Conductor 2.0 installer for Windows: checks Node, installs dependencies, creates a launcher.
cd /d "%~dp0.."
where node >nul 2>nul || (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org and run this again.
  pause & exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo Node.js %NODEMAJOR% found; Conductor needs 22 or newer. Install it from https://nodejs.org
  pause & exit /b 1
)
echo Installing dependencies...
call npm install --no-fund --no-audit || (echo npm install failed & pause & exit /b 1)

> "%USERPROFILE%\Desktop\Conductor.cmd" (
  echo @echo off
  echo cd /d "%CD%"
  echo node bin\conductor.mjs start
)
echo.
echo Installed. A "Conductor.cmd" launcher is on your Desktop. (Or just double-click Conductor.exe in this folder.)
echo.
echo One-time logins (each in this terminal):
echo   claude auth login      (Claude subscription; installs Claude Code if missing: npm i -g @anthropic-ai/claude-code)
echo   npm i -g @openai/codex ^&^& codex login   (ChatGPT subscription, for GPT-6 Astra)
echo   Optional: install Ollama from https://ollama.com for free local models (local models are off by default:
echo     turn them on in Settings with providers.ollama.enabled = true).
echo   Optional: a /conductor skill for Claude Code - see docs\DRIVE-CONDUCTOR.md, "Optional: a /conductor skill".
echo.
echo Then run:  node bin\conductor.mjs doctor
pause
