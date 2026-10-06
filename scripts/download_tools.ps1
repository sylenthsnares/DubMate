# download_tools.ps1
# Downloads portable FFmpeg, FFprobe, and Cloudflared into the project tools/ folder.

param (
    [string]$TargetDir = "$PSScriptRoot\..\tools"
)

$TargetDir = [System.IO.Path]::GetFullPath($TargetDir)
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. FFmpeg and FFprobe
$ffmpegPath = Join-Path $TargetDir "ffmpeg.exe"
$ffprobePath = Join-Path $TargetDir "ffprobe.exe"

# Pinned to one BtbN month-end build (those are kept for about two years) and
# checked against a hardcoded SHA-256 before anything is extracted. The same pin
# lives in tauri/scripts/stage-sidecars.ps1; move both together, and never relax
# the hash to make a download pass.
$FfmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip"
$FfmpegSha256 = "cc4156d51387566ea8ba653fc3a04897bdf812fddf652428d9030bbf7ae24835"
$ffmpegHashMismatch = $false

if ((-not (Test-Path $ffmpegPath)) -or (-not (Test-Path $ffprobePath))) {
    Write-Host "   -> Setting up portable FFmpeg & FFprobe in tools\..." -ForegroundColor Cyan

    $downloaded = $false
    $tempZip = Join-Path $env:TEMP "dubmate_ffmpeg_$([Guid]::NewGuid().ToString('N')).zip"
    $tempExtract = Join-Path $env:TEMP "dubmate_ffmpeg_x_$([Guid]::NewGuid().ToString('N'))"

    try {
        Write-Host "      Downloading from: $FfmpegUrl"
        Invoke-WebRequest -Uri $FfmpegUrl -OutFile $tempZip -UseBasicParsing

        # Hashed through .NET rather than Get-FileHash: Windows PowerShell started
        # from a PowerShell 7 terminal inherits a module path where Get-FileHash
        # fails to load.
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($tempZip)
        try {
            $actualSha256 = ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
            $sha.Dispose()
        }
        if ($actualSha256 -ne $FfmpegSha256) {
            $ffmpegHashMismatch = $true
            Write-Host "      FFmpeg download failed its SHA-256 check and was NOT installed." -ForegroundColor Red
            Write-Host "        expected: $FfmpegSha256" -ForegroundColor Red
            Write-Host "        actual  : $actualSha256" -ForegroundColor Red
        } else {
            Write-Host "      SHA-256 verified. Extracting FFmpeg binaries..."
            Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force

            $foundFfmpeg = Get-ChildItem -Path $tempExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
            if ($foundFfmpeg) {
                $binDir = $foundFfmpeg.DirectoryName
                Get-ChildItem -Path $binDir -Filter "*.exe" | ForEach-Object {
                    Copy-Item -Path $_.FullName -Destination $TargetDir -Force
                }
                $downloaded = $true
                Write-Host "      FFmpeg and FFprobe successfully installed in tools\" -ForegroundColor Green
            }
        }
    } catch {
        Write-Host "      Download attempt failed: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        Remove-Item $tempZip, $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not $downloaded) {
        Write-Warning "Could not automatically download FFmpeg. You can place ffmpeg.exe into $TargetDir manually."
    }
} else {
    Write-Host "   -> FFmpeg and FFprobe already present in tools\" -ForegroundColor Green
}

# 2. Cloudflared
$cloudflaredPath = Join-Path $TargetDir "cloudflared.exe"
if (-not (Test-Path $cloudflaredPath)) {
    Write-Host "   -> Downloading cloudflared.exe for multiplayer..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cloudflaredPath -UseBasicParsing
        Write-Host "      cloudflared.exe installed in tools\" -ForegroundColor Green
    } catch {
        Write-Warning "Cloudflared download failed: $($_.Exception.Message)"
    }
} else {
    Write-Host "   -> cloudflared.exe already present in tools\" -ForegroundColor Green
}

# 3. DeepFilterNet 3 (AI Vocal De-Noising & Speech Enhancer)
# Pinned like FFmpeg: the same URL and SHA-256 live in tauri/scripts/stage-sidecars.ps1.
# The file is downloaded to %TEMP% and only kept if its hash matches.
$DeepFilterUrl = "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe"
$DeepFilterSha256 = "75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915"
$deepFilterPath = Join-Path $TargetDir "deep-filter.exe"
if (-not (Test-Path $deepFilterPath)) {
    Write-Host "   -> Downloading DeepFilterNet 3 for AI vocal de-noising..." -ForegroundColor Cyan
    $tempDeepFilter = Join-Path $env:TEMP "dubmate_deep_filter_$([Guid]::NewGuid().ToString('N')).exe"
    try {
        Invoke-WebRequest -Uri $DeepFilterUrl -OutFile $tempDeepFilter -UseBasicParsing
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($tempDeepFilter)
        try {
            $actualSha256 = ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
            $sha.Dispose()
        }
        if ($actualSha256 -ne $DeepFilterSha256) {
            Write-Warning "DeepFilterNet download failed its SHA-256 check and was NOT installed (expected $DeepFilterSha256, got $actualSha256). Noise cleanup uses the built-in fallback."
        } else {
            Move-Item -Path $tempDeepFilter -Destination $deepFilterPath -Force
            Write-Host "      SHA-256 verified. DeepFilterNet 3 installed in tools\" -ForegroundColor Green
        }
    } catch {
        Write-Warning "DeepFilterNet download failed: $($_.Exception.Message)"
    } finally {
        Remove-Item $tempDeepFilter -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "   -> deep-filter.exe already present in tools\" -ForegroundColor Green
}

if ($ffmpegHashMismatch) {
    Write-Error "FFmpeg was not installed: the download did not match its pinned SHA-256. Try again; if it keeps failing, the published file has changed."
    exit 1
}
