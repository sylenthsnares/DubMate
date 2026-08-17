@echo off
title DubMate Multiplayer Studio
cd /d "%~dp0"

echo ===================================================
echo   Starting DubMate Multiplayer Studio
echo ===================================================

:: Free port 8000 from any lingering zombie processes and child workers
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000.*LISTENING"') do (
    taskkill /f /t /pid %%a >nul 2>&1
)
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo   Open your browser at: http://localhost:8000
echo   Share your local IP / room link with friends!
echo ===================================================

start "" "http://localhost:8000"
python app.py
pause
