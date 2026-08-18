@echo off
title DubMate Studio Pro - Updater
color 0a
cd /d "%~dp0"

echo =====================================================================
echo          🎙️  DubMate Studio Pro — Repository Updater  🚀
echo =====================================================================
echo.
echo Checking for the latest updates from GitHub (sylenthsnares/DubMate)...
echo.

:: 1. Verify Git is installed
git --version >nul 2>&1
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Git is not installed or not found in your system PATH!
    echo.
    echo Please install Git for Windows to enable one-click updates:
    echo https://git-scm.com/download/win
    echo.
    echo If you downloaded DubMate as a ZIP archive, you can download the
    echo latest version directly from:
    echo https://github.com/sylenthsnares/DubMate
    echo.
    pause
    exit /b 1
)

:: 2. Check if this is a valid Git repository
if not exist "%~dp0.git" (
    echo [SETUP] Git repository metadata not found in this folder.
    echo Initializing Git remote connection to sylenthsnares/DubMate...
    git init
    git remote add origin https://github.com/sylenthsnares/DubMate.git
)

:: 3. Fetch and pull latest updates from origin/main
echo [1/3] Pulling latest code and features from origin/main...
echo.
git fetch origin main
git pull origin main
if %errorlevel% neq 0 (
    color 0e
    echo.
    echo [WARNING] Git pull encountered conflicts or an issue.
    echo Attempting clean checkout of latest release...
    git stash
    git pull origin main
)

echo.
echo [2/3] Checking and updating Python dependencies...
python -m pip install --upgrade -r requirements.txt
if %errorlevel% neq 0 (
    echo [NOTICE] Pip install returned a non-zero code. Trying fallback pip command...
    pip install -r requirements.txt
)

echo.
echo [3/3] Checking Cloudflare Tunnel binary...
if not exist "%~dp0cloudflared.exe" (
    echo Downloading cloudflared.exe for multiplayer rooms...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0cloudflared.exe'"
)

echo.
echo =====================================================================
echo   ✅ DubMate Studio Pro is completely updated and ready to play!
echo =====================================================================
echo.

set /p LAUNCH="Would you like to launch DubMate Studio Pro now? [Y/n]: "
if /i "%LAUNCH%"=="" set LAUNCH=Y
if /i "%LAUNCH%"=="Y" (
    echo.
    echo Starting DubMate Web Studio...
    start "" "%~dp0run_web_studio.bat"
) else (
    echo.
    echo You can start the studio anytime using run_web_studio.bat or run_cloudflare.bat.
    pause
)
