@echo off
chcp 65001 >nul
title DubMate Desktop App Launcher
color 0b
cd /d "%~dp0"

set "PATH=%PATH%;%USERPROFILE%\.cargo\bin"

echo ===================================================
echo     🎙️  DubMate Desktop Application Launcher  🎬
echo ===================================================
echo.

cd tauri
call npm run tauri dev
pause
