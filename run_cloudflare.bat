@echo off
title DubMate Multiplayer Studio Launcher
color 0b

echo ===================================================
echo     🎙️  DubMate Multiplayer Studio Launcher  🎬
echo ===================================================
echo.

:: 1. Free port 8000 from any lingering zombie processes
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)

:: 2. Verify Python Installation
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3.10+ and try again.
    pause
    exit /b 1
)

:: 3. Verify / Auto-Download Cloudflared
if not exist "%~dp0cloudflared.exe" (
    echo [SETUP] cloudflared.exe not found in %~dp0
    echo Downloading official cloudflared binary from Cloudflare...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0cloudflared.exe'"
    if not exist "%~dp0cloudflared.exe" (
        echo [ERROR] Failed to auto-download cloudflared.exe. Please download it manually.
        pause
        exit /b 1
    )
    echo [SETUP] cloudflared.exe installed successfully.
)

:: 4. Start Python FastAPI Server on port 8000
echo [1/2] Starting DubMate Backend Server on port 8000...
start "DubMate Backend Server" /min cmd /c "cd /d "%~dp0" && python app.py"

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

"%~dp0cloudflared.exe" tunnel --url http://127.0.0.1:8000

echo.
echo Tunnel closed. Stopping server...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)
pause
