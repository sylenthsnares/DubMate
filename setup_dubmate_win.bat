@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title DubMate Studio Pro — 1-Click Dependency Installer
color 0b
cd /d "%~dp0"

echo =====================================================================
echo       🎙️  DubMate Studio Pro — 1-Click Dependency Installer 🚀
echo =====================================================================
echo.
echo   This installer sets up all dependencies strictly inside this folder:
echo   - Local Python virtual environment (.venv)
echo   - Local audio/video engine (tools\ffmpeg.exe, tools\ffprobe.exe)
echo   - Local multiplayer tunnel (tools\cloudflared.exe)
echo.
echo   [!] NO packages or binaries are installed globally on your system.
echo =====================================================================
echo.

:: -------------------------------------------------------------------
:: 1. Locate System Python
:: -------------------------------------------------------------------
echo [1/3] Checking Python installation...
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY ( where python3 >nul 2>&1 && set "PY=python3" )

if not defined PY (
    color 0c
    echo [ERROR] Python 3.9+ was not found on your system!
    echo.
    echo Please install Python 3.10+ from python.org or via Windows Terminal:
    echo   winget install -e --id Python.Python.3.12
    echo.
    pause
    exit /b 1
)

%PY% -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3, 9) else 1)"
if %errorlevel% neq 0 (
    color 0c
    echo [ERROR] Python 3.9 or newer is required.
    echo Detected version is older. Please update Python.
    pause
    exit /b 1
)
echo       Python detected successfully.

:: -------------------------------------------------------------------
:: 2. Create Project-Local Virtual Environment (.venv)
:: -------------------------------------------------------------------
echo.
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo [2/3] Creating project-local virtual environment ^(.venv^)...
    %PY% -m venv "%~dp0.venv"
    if not exist "%~dp0.venv\Scripts\python.exe" (
        color 0c
        echo [ERROR] Failed to create .venv virtual environment.
        pause
        exit /b 1
    )
    echo       Virtual environment created at .venv\
) else (
    echo [2/3] Virtual environment already exists ^(.venv\^).
)

echo       Installing/updating requirements into local .venv...
"%~dp0.venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
"%~dp0.venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
if %errorlevel% neq 0 (
    color 0e
    echo [WARNING] Pip install had issues. Retrying...
    "%~dp0.venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
)
echo       Python dependencies verified in .venv\

:: -------------------------------------------------------------------
:: 3. Setup Project-Local Tools (FFmpeg, FFprobe, Cloudflared)
:: -------------------------------------------------------------------
echo.
echo [3/3] Checking project-local tools (tools\)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\download_tools.ps1"

:: -------------------------------------------------------------------
:: 4. Verification & Completion
:: -------------------------------------------------------------------
color 0a
echo.
echo =====================================================================
echo   ✅ DubMate Studio Pro Environment Ready!
echo =====================================================================
echo   • Python Virtualenv: .venv\ (Isolated)
echo   • Audio/Video Engine: tools\ffmpeg.exe, tools\ffprobe.exe (Isolated)
echo   • Multiplayer Engine: tools\cloudflared.exe (Isolated)
echo   • Global System State: UNTOUCHED (Zero global pollution)
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
