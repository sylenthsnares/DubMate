@echo off
title DubMate Multiplayer Studio Launcher
color 0b
cd /d "%~dp0"

echo ===================================================
echo     🎙️  DubMate Multiplayer Studio Launcher  🎬
echo ===================================================
echo.

:: 1. Self-Healing: Verify local .venv exists
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo [SETUP] Project-local environment (.venv) not found.
    echo Running 1-click dependency installer...
    echo.
    call "%~dp0setup_dubmate_win.bat"
    if not exist "%~dp0.venv\Scripts\python.exe" (
        echo [ERROR] Setup could not be completed.
        pause
        exit /b 1
    )
)

set "PY_RUNNER=%~dp0.venv\Scripts\python.exe"
if not exist "%PY_RUNNER%" set "PY_RUNNER=python"

:: 2. Free port 8000 from any lingering zombie processes
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)

:: 3. Verify / Auto-Download Cloudflared in tools\
if not exist "%~dp0tools" mkdir "%~dp0tools"
set "CF_BIN="
if exist "%~dp0tools\cloudflared.exe" set "CF_BIN=%~dp0tools\cloudflared.exe"
if not defined CF_BIN (
    if exist "%~dp0cloudflared.exe" (
        copy /y "%~dp0cloudflared.exe" "%~dp0tools\cloudflared.exe" >nul 2>&1
        set "CF_BIN=%~dp0tools\cloudflared.exe"
    )
)

if not defined CF_BIN (
    echo [SETUP] cloudflared.exe not found in tools\
    echo Downloading official cloudflared binary from Cloudflare into tools\...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
        "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0tools\cloudflared.exe' -UseBasicParsing"
    if not exist "%~dp0tools\cloudflared.exe" (
        echo [ERROR] Failed to auto-download cloudflared.exe. Please run setup_dubmate_win.bat.
        pause
        exit /b 1
    )
    set "CF_BIN=%~dp0tools\cloudflared.exe"
    echo [SETUP] cloudflared.exe installed successfully in tools\
)

:: 4. Start Python FastAPI Server on port 8000 using isolated .venv
echo [1/2] Starting DubMate Backend Server on port 8000...
start "DubMate Backend Server" /min cmd /c "cd /d "%~dp0" && "%PY_RUNNER%" app.py"

:: Give the server a moment to bind to port 8000
timeout /t 3 /nobreak >nul

:: 5. Start Cloudflare Tunnel and display public URL
echo [2/2] Starting Cloudflare Public Tunnel...
echo.
echo ===================================================
echo   Look for your public URL below:
echo   https://xxxx-xxxx-xxxx.trycloudflare.com
echo ===================================================
echo.

"%CF_BIN%" tunnel --url http://127.0.0.1:8000

echo.
echo Tunnel closed. Stopping server...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)
pause
