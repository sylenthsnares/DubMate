@echo off
cd /d "%~dp0"

echo Checking for Python...
where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found on PATH.
    echo Install it from https://python.org/downloads ^(tick "Add python.exe to PATH"^)
    echo then run this Setup.bat again.
    pause
    exit /b 1
)
echo   OK.

echo Checking for ffmpeg...
if exist "tools\ffmpeg.exe" (
    echo   Found in tools\ffmpeg.exe
) else if exist "..\tools\ffmpeg.exe" (
    echo   Found in ..\tools\ffmpeg.exe ^(reusing DubForge's copy^)
) else (
    where ffmpeg >nul 2>nul
    if errorlevel 1 (
        echo   Not found. If you already set up DubForge, copy its "tools" folder
        echo   next to this script. Otherwise grab ffmpeg from gyan.dev/ffmpeg/builds
        echo   and place ffmpeg.exe in a "tools" folder here.
    ) else (
        echo   Found on PATH.
    )
)

if not exist "input" mkdir "input"
echo.
echo Setup check complete. Drop pack .zip files into "input", then run Convert.bat.
pause
