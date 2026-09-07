@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo Installation did not finish. Keep this window and give the error to Codex.
  pause
  exit /b 1
)
echo Installation complete. Open a new Codex task to use the Skills.
if "%~1"=="" pause
