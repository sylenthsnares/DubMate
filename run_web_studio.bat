@echo off
chcp 65001 >nul
title DubMate Multiplayer Studio
cd /d "%~dp0"

echo ===================================================
echo   🎙️  Starting DubMate Multiplayer Studio  🎬
echo ===================================================

:: 1. Self-Healing: Verify local .venv and tools exist
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo [SETUP] Project-local environment ^(.venv^) not found.
    echo Running 1-click dependency installer...
    echo.
    call "%~dp0setup_dubmate_win.bat"
    if not exist "%~dp0.venv\Scripts\python.exe" (
        echo [ERROR] Setup could not be completed.
        pause
        exit /b 1
    )
)

:: Determine Python runner (prefer isolated .venv)
set "PY_RUNNER=%~dp0.venv\Scripts\python.exe"
if not exist "%PY_RUNNER%" set "PY_RUNNER=python"

:: 2. Free port 8000 from any lingering zombie processes and child workers
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000.*LISTENING"') do (
    taskkill /f /t /pid %%a >nul 2>&1
)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo   Open your browser at: http://localhost:8000
echo   Share your local IP / room link with friends!
echo ===================================================
echo.

start "" "http://localhost:8000"
start /high /wait cmd /c ""%PY_RUNNER%" app.py"
pause
