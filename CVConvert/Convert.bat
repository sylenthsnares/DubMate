@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if "%~1"=="" (
    if not exist "input" mkdir "input"
    echo No files were dropped onto this .bat.
    echo.
    echo Put your Choicer Voicer pack .zip files ^(or extracted folders^) into the
    echo "input" folder next to this script, then run this again.
    echo.
    set "found=0"
    for %%F in ("input\*.zip") do set "found=1"
    for /d %%D in ("input\*") do set "found=1"
    if "!found!"=="1" (
        python "%~dp0convert_cv_pack.py" "input"
    )
) else (
    python "%~dp0convert_cv_pack.py" %*
)

echo.
echo Done. Converted packs are in the "output" folder.
echo Copy them into DubStage's "packs" folder ^(or use Add folder in DubStage^).
pause
