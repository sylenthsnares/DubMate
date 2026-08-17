@echo off
setlocal enabledelayedexpansion
title DubForge und DubStage - Einrichtung
cd /d "%~dp0"

echo ============================================================
echo   DubForge und DubStage - Einrichtung
echo   Das dauert beim ersten Mal ein paar Minuten.
echo ============================================================
echo.

rem ---------------------------------------------------------- Python finden
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )

if not defined PY (
  echo [!] Python wurde nicht gefunden.
  echo.
  echo     Ich versuche es ueber winget zu installieren ...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  echo.
  echo     Bitte dieses Fenster schliessen und Setup.bat NEU starten.
  pause
  exit /b 1
)

echo [1/4] Python:
%PY% -c "import sys;print('      ',sys.version)"
%PY% -c "import sys;sys.exit(0 if sys.version_info[:2]>=(3,9) else 1)" || (
  echo [!] Python 3.9 oder neuer wird gebraucht. Bitte aktualisieren.
  pause & exit /b 1
)
echo.

rem ---------------------------------------------------------- Pakete
echo [2/4] Python-Pakete installieren ^(numpy, yt-dlp, pillow, sounddevice^) ...
%PY% -m pip install --upgrade pip --quiet
%PY% -m pip install --upgrade numpy yt-dlp pillow sounddevice || (
  echo [!] Installation fehlgeschlagen. Internet pruefen.
  pause & exit /b 1
)
echo       ok
echo       ^(pillow und sounddevice werden fuer DubStage gebraucht^)
echo.

echo [3/4] Demucs fuer die Stimmen-Trennung ...
echo       Achtung: laedt PyTorch, das sind mehrere hundert MB bis ~2 GB.
choice /c JN /n /m "       Jetzt installieren? [J/N] "
if errorlevel 2 (
  echo       uebersprungen - die App laeuft dann ohne Stimmen-Trennung.
) else (
  %PY% -m pip install --upgrade demucs soundfile
  if errorlevel 1 (
    echo [!] Demucs konnte nicht installiert werden.
    echo     Die App funktioniert trotzdem, nur ohne Vocal-Trennung.
  ) else (
    echo       ok
  )
)
echo.

rem ---------------------------------------------------------- ffmpeg
echo [4/4] ffmpeg pruefen ...
set "FFOK="
if exist "tools\ffmpeg.exe" set "FFOK=1"
if not defined FFOK ( where ffmpeg >nul 2>&1 && set "FFOK=system" )

if "%FFOK%"=="1"      echo       ffmpeg liegt schon in tools\. ok
if "%FFOK%"=="system" echo       System-ffmpeg gefunden. ok

if not defined FFOK (
  echo       Kein ffmpeg da - ich lade einen herunter ^(~100 MB^).
  if not exist tools mkdir tools
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$urls=@('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip','https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip');" ^
    "foreach($u in $urls){ try{" ^
    "  Write-Host ('       -> '+$u);" ^
    "  $z=Join-Path $env:TEMP 'dubforge_ffmpeg.zip';" ^
    "  Invoke-WebRequest -Uri $u -OutFile $z -UseBasicParsing;" ^
    "  $x=Join-Path $env:TEMP 'dubforge_ffmpeg_x'; if(Test-Path $x){Remove-Item $x -Recurse -Force};" ^
    "  Expand-Archive -Path $z -DestinationPath $x -Force;" ^
    "  $exe=Get-ChildItem -Path $x -Recurse -Filter ffmpeg.exe | Select-Object -First 1;" ^
    "  if(-not $exe){continue};" ^
    "  Get-ChildItem -Path $exe.Directory -Filter *.exe | Copy-Item -Destination 'tools' -Force;" ^
    "  Remove-Item $z,$x -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "  Write-Host '       ffmpeg installiert.'; exit 0" ^
    "} catch { Write-Host ('       Fehlgeschlagen: '+$_.Exception.Message) } };" ^
    "exit 1"
  if exist "tools\ffmpeg.exe" set "FFOK=1"
)

echo.
if not defined FFOK (
  echo [!] Es konnte kein ffmpeg eingerichtet werden. Ohne ffmpeg
  echo     laeuft weder DubForge noch DubStage.
  echo.
  echo     Manueller Weg:
  echo       1. https://www.gyan.dev/ffmpeg/builds/  ^-^>  "release full" herunterladen
  echo       2. entpacken, aus dem bin-Ordner ffmpeg.exe, ffprobe.exe, ffplay.exe
  echo       3. in den Ordner "tools" neben dieser Setup.bat legen
  echo.
) else (
  echo ============================================================
  echo   Fertig.
  echo     Packs bauen : "Start DubForge.bat"
  echo     Einsprechen : "Start DubStage.bat"
  echo ============================================================
)
echo.
pause
