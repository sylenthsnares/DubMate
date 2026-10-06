# stage-sidecars.ps1 - Stages Python, FFmpeg, DeepFilterNet and cloudflared sidecars for Windows x64 build
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
    Write-Host "[1/6] Downloading CPython 3.12 Embeddable Runtime..."
    Invoke-WebRequest "https://www.python.org/ftp/python/3.12.4/python-3.12.4-embed-amd64.zip" -OutFile $PyZip -UseBasicParsing
}
Write-Host "[1/6] Extracting Python Embeddable Package..."
Expand-Archive $PyZip $PyRuntimeDir -Force

$PyExe = Join-Path $PyRuntimeDir "python.exe"

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

# 2. Bootstrap PIP & Install Dependencies into Embedded Python
Write-Host "[2/6] Bootstrapping pip into embedded Python..."
$GetPipPy = Join-Path $env:TEMP "get-pip.py"
if (-not (Test-Path $GetPipPy)) {
    Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPipPy -UseBasicParsing
}
& $PyExe $GetPipPy --no-warn-script-location --quiet
# Build backends for sdist-only AI packages (openai-whisper, demucs).
# Embedded Python ignores pip's isolated build env, so these must be resident.
& $PyExe -m pip install setuptools wheel --no-warn-script-location --quiet

$ReqFile = Join-Path $ProjectRoot "requirements.txt"
if (Test-Path $ReqFile) {
    Write-Host "[2/6] Installing Python requirements into embedded runtime..."
    & $PyExe -m pip install -r $ReqFile --target (Join-Path $PyRuntimeDir "Lib\site-packages") --no-warn-script-location --quiet
}

# 3. FFmpeg Static Windows Binary
$FfmpegTarget = Join-Path $SidecarDir "ffmpeg-$Triple.exe"
$LocalFfmpeg = Join-Path $ProjectRoot "tools\ffmpeg.exe"
if (Test-Path $LocalFfmpeg) {
    Write-Host "[3/6] Copying local FFmpeg from tools\..."
    Copy-Item $LocalFfmpeg $FfmpegTarget -Force
} else {
    # Same pin and SHA-256 as scripts/download_tools.ps1; move both together.
    $FfmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip"
    $FfmpegSha256 = "cc4156d51387566ea8ba653fc3a04897bdf812fddf652428d9030bbf7ae24835"
    Write-Host "[3/6] Downloading FFmpeg static build..."
    $FfmpegZip = Join-Path $env:TEMP "dubmate-ffmpeg-pinned.zip"
    $FfmpegExtract = Join-Path $env:TEMP "dubmate-ffmpeg-pinned"
    Invoke-WebRequest $FfmpegUrl -OutFile $FfmpegZip -UseBasicParsing
    $ActualSha256 = (Get-FileHash $FfmpegZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $FfmpegSha256) {
        Remove-Item $FfmpegZip -Force
        throw "FFmpeg SHA-256 mismatch, not extracting.`n  url     : $FfmpegUrl`n  expected: $FfmpegSha256`n  actual  : $ActualSha256"
    }
    if (Test-Path $FfmpegExtract) {
        Remove-Item $FfmpegExtract -Recurse -Force
    }
    Expand-Archive $FfmpegZip $FfmpegExtract -Force
    $FoundFfmpeg = Get-ChildItem $FfmpegExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    Copy-Item $FoundFfmpeg.FullName $FfmpegTarget -Force
}

# 4. DeepFilterNet (noise cleanup). The official standalone binary; its model is built in.
# Same pin and SHA-256 as scripts/download_tools.ps1; move both together, and never
# relax the hash to make a download pass.
$DeepFilterUrl = "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe"
$DeepFilterSha256 = "75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915"
$DeepFilterTarget = Join-Path $SidecarDir "deep-filter-$Triple.exe"
$LocalDeepFilter = Join-Path $ProjectRoot "tools\deep-filter.exe"
if ((Test-Path $LocalDeepFilter) -and ((Get-FileHash $LocalDeepFilter -Algorithm SHA256).Hash.ToLowerInvariant() -eq $DeepFilterSha256)) {
    Write-Host "[4/6] Copying local DeepFilterNet from tools\..."
    Copy-Item $LocalDeepFilter $DeepFilterTarget -Force
} else {
    Write-Host "[4/6] Downloading DeepFilterNet..."
    $DeepFilterDownload = Join-Path $env:TEMP "dubmate-deep-filter-pinned.exe"
    Invoke-WebRequest $DeepFilterUrl -OutFile $DeepFilterDownload -UseBasicParsing
    $ActualSha256 = (Get-FileHash $DeepFilterDownload -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha256 -ne $DeepFilterSha256) {
        Remove-Item $DeepFilterDownload -Force
        throw "DeepFilterNet SHA-256 mismatch, not staging it.`n  url     : $DeepFilterUrl`n  expected: $DeepFilterSha256`n  actual  : $ActualSha256"
    }
    Copy-Item $DeepFilterDownload $DeepFilterTarget -Force
}

# 5. cloudflared Windows Binary
$CfTarget = Join-Path $SidecarDir "cloudflared-$Triple.exe"
$LocalCf = Join-Path $ProjectRoot "tools\cloudflared.exe"
if (Test-Path $LocalCf) {
    Write-Host "[5/6] Copying local cloudflared from tools\..."
    Copy-Item $LocalCf $CfTarget -Force
} else {
    Write-Host "[5/6] Downloading cloudflared binary..."
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $CfTarget -UseBasicParsing
}

# 6. Application Resources (app.py, audio_processor, pack_loader, static, VERSION, python-runtime)
$ResourceDir = Join-Path $ScriptDir "..\src-tauri\resources"
New-Item -ItemType Directory -Force $ResourceDir | Out-Null
Write-Host "[6/6] Staging application Python files and static assets into resources..."
$FilesToCopy = @("app.py", "audio_processor.py", "pack_loader.py", "pack_builder.py", "VERSION", "requirements.txt", "requirements_builder.txt")
foreach ($file in $FilesToCopy) {
    $src = Join-Path $ProjectRoot $file
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $ResourceDir $file) -Force
    }
}
$StaticSrc = Join-Path $ProjectRoot "static"
$StaticDest = Join-Path $ResourceDir "static"
if (Test-Path $StaticDest) {
    Remove-Item $StaticDest -Recurse -Force
}
if (Test-Path $StaticSrc) {
    Copy-Item $StaticSrc $StaticDest -Recurse -Force
}
$DubmateSrc = Join-Path $ProjectRoot "dubmate"
$DubmateDest = Join-Path $ResourceDir "dubmate"
if (Test-Path $DubmateDest) {
    Remove-Item $DubmateDest -Recurse -Force
}
Copy-Item $DubmateSrc $DubmateDest -Recurse -Force
Get-ChildItem $DubmateDest -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

$PyTargetResource = Join-Path $ResourceDir "python-runtime"
if (Test-Path $PyTargetResource) {
    Remove-Item $PyTargetResource -Recurse -Force
}
Write-Host "[6/6] Staging full Python embedded runtime into resources..."
Copy-Item $PyRuntimeDir $PyTargetResource -Recurse -Force

Write-Host "========================================================="
Write-Host "  ✅ ALL SIDECARS & RESOURCES STAGED SUCCESSFULLY FOR $Triple"
Write-Host "========================================================="
