# stage-sidecars.ps1 - Stages Python, FFmpeg, and cloudflared sidecars for Windows x64 build
param(
    [string]$Triple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$ProjectRoot = Split-Path (Split-Path $ScriptDir -Parent) -Parent
$SidecarDir = Join-Path $ScriptDir "..\src-tauri\sidecar"

New-Item -ItemType Directory -Force $SidecarDir | Out-Null
$PyRuntimeDir = Join-Path $SidecarDir "python-runtime"
New-Item -ItemType Directory -Force $PyRuntimeDir | Out-Null

Write-Host "========================================================="
Write-Host "  🎙️ Staging DubMate Desktop Sidecars ($Triple)"
Write-Host "========================================================="

# 1. Python 3.12 Embeddable Runtime
$PyZip = Join-Path $env:TEMP "python-3.12.4-embed-amd64.zip"
if (-not (Test-Path $PyZip)) {
    Write-Host "[1/4] Downloading CPython 3.12 Embeddable Runtime..."
    Invoke-WebRequest "https://www.python.org/ftp/python/3.12.4/python-3.12.4-embed-amd64.zip" -OutFile $PyZip -UseBasicParsing
}
Write-Host "[1/4] Extracting Python Embeddable Package..."
Expand-Archive $PyZip $PyRuntimeDir -Force

# Rename python.exe to triple-suffixed binary name required by Tauri sidecars
$PySourceExe = Join-Path $PyRuntimeDir "python.exe"
$PyTargetExe = Join-Path $PyRuntimeDir "python-$Triple.exe"
if (Test-Path $PySourceExe) {
    Copy-Item $PySourceExe $PyTargetExe -Force
}

# Enable 'import site' in ._pth file so embedded python supports pip and site-packages
$PthFiles = Get-ChildItem $PyRuntimeDir -Filter "*._pth"
foreach ($pth in $PthFiles) {
    $pthContent = Get-Content $pth.FullName -Raw
    $pthContent = $pthContent -replace "#import site", "import site"
    if ($pthContent -notmatch "Lib\\site-packages") {
        $pthContent = $pthContent + "`r`nLib\site-packages`r`n.`r`n.."
    }
    Set-Content -Path $pth.FullName -Value $pthContent -Encoding ASCII
}
$Py312Pth = Join-Path $PyRuntimeDir "python312._pth"
$TriplePth = Join-Path $PyRuntimeDir "python-$Triple._pth"
if (Test-Path $Py312Pth) {
    Copy-Item $Py312Pth $TriplePth -Force
}

# 2. Bootstrap PIP & Install Dependencies into Embedded Python
Write-Host "[2/4] Bootstrapping pip into embedded Python..."
$GetPipPy = Join-Path $env:TEMP "get-pip.py"
if (-not (Test-Path $GetPipPy)) {
    Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPipPy -UseBasicParsing
}
& $PyTargetExe $GetPipPy --no-warn-script-location --quiet

$ReqFile = Join-Path $ProjectRoot "requirements.txt"
if (Test-Path $ReqFile) {
    Write-Host "[2/4] Installing Python requirements into embedded runtime..."
    & $PyTargetExe -m pip install -r $ReqFile --target (Join-Path $PyRuntimeDir "Lib\site-packages") --no-warn-script-location --quiet
}

# 3. FFmpeg Static Windows Binary
$FfmpegTarget = Join-Path $SidecarDir "ffmpeg-$Triple.exe"
$LocalFfmpeg = Join-Path $ProjectRoot "tools\ffmpeg.exe"
if (Test-Path $LocalFfmpeg) {
    Write-Host "[3/4] Copying local FFmpeg from tools\..."
    Copy-Item $LocalFfmpeg $FfmpegTarget -Force
} else {
    Write-Host "[3/4] Downloading FFmpeg static build..."
    $FfmpegZip = Join-Path $env:TEMP "ffmpeg-release-essentials.zip"
    Invoke-WebRequest "https://github.com/GyanD/codexffmpeg/releases/download/7.0.2/ffmpeg-7.0.2-essentials_build.zip" -OutFile $FfmpegZip -UseBasicParsing
    Expand-Archive $FfmpegZip (Join-Path $env:TEMP "ffmpeg-extract") -Force
    $FoundFfmpeg = Get-ChildItem (Join-Path $env:TEMP "ffmpeg-extract") -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    Copy-Item $FoundFfmpeg.FullName $FfmpegTarget -Force
}

# 4. cloudflared Windows Binary
$CfTarget = Join-Path $SidecarDir "cloudflared-$Triple.exe"
$LocalCf = Join-Path $ProjectRoot "tools\cloudflared.exe"
if (Test-Path $LocalCf) {
    Write-Host "[4/5] Copying local cloudflared from tools\..."
    Copy-Item $LocalCf $CfTarget -Force
} else {
    Write-Host "[4/5] Downloading cloudflared binary..."
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $CfTarget -UseBasicParsing
}

# 5. Application Resources (app.py, audio_processor, pack_loader, static, VERSION, python-runtime)
$ResourceDir = Join-Path $ScriptDir "..\src-tauri\resources"
New-Item -ItemType Directory -Force $ResourceDir | Out-Null
Write-Host "[5/5] Staging application Python files and static assets into resources..."
$FilesToCopy = @("app.py", "audio_processor.py", "pack_loader.py", "pack_builder.py", "VERSION", "requirements.txt")
foreach ($file in $FilesToCopy) {
    $src = Join-Path $ProjectRoot $file
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $ResourceDir $file) -Force
    }
}
$StaticSrc = Join-Path $ProjectRoot "static"
if (Test-Path $StaticSrc) {
    Copy-Item $StaticSrc (Join-Path $ResourceDir "static") -Recurse -Force
}

$PyTargetResource = Join-Path $ResourceDir "python-runtime"
Write-Host "[5/5] Staging full Python embedded runtime into resources..."
Copy-Item $PyRuntimeDir $PyTargetResource -Recurse -Force

Write-Host "========================================================="
Write-Host "  ✅ ALL SIDECARS & RESOURCES STAGED SUCCESSFULLY FOR $Triple"
Write-Host "========================================================="
