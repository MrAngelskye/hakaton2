@echo off
setlocal
cd /d "%~dp0"
echo Education portal: http://127.0.0.1:4173
echo Keep this window open. Press Ctrl+C to stop.
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "%~dp0server.py"
  goto end
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%~dp0server.py"
  goto end
)
where python >nul 2>nul
if not errorlevel 1 (
  python "%~dp0server.py"
  goto end
)
echo Python 3.10 or newer is required. Install Python and run this file again.
:end
pause
endlocal
