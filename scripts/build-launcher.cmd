@echo off
REM Builds Conductor.exe (repo root) from scripts\launcher\Conductor.cs using the C# compiler that
REM ships with Windows (.NET Framework 4.x). No SDK or internet needed.
setlocal
set ROOT=%~dp0..
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo C# compiler not found at %CSC%. Install .NET Framework 4.x ^(Windows Update^) and retry.
  exit /b 1
)
if not exist "%~dp0launcher\conductor.ico" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\make-icon.ps1"
set ICON=
if exist "%~dp0launcher\conductor.ico" set ICON=/win32icon:"%~dp0launcher\conductor.ico"
"%CSC%" /nologo /target:winexe /optimize+ /out:"%ROOT%\Conductor.exe" %ICON% /r:System.Windows.Forms.dll /r:System.Drawing.dll "%~dp0launcher\Conductor.cs"
if errorlevel 1 exit /b 1
echo Built %ROOT%\Conductor.exe
