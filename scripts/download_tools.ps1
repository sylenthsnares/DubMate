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

if ((-not (Test-Path $ffmpegPath)) -or (-not (Test-Path $ffprobePath))) {
    Write-Host "   -> Setting up portable FFmpeg & FFprobe in tools\..." -ForegroundColor Cyan
    
    $downloaded = $false
    
    # Check if a downloaded zip already exists in TEMP from a prior attempt
    $existingZips = Get-ChildItem -Path $env:TEMP -Filter "dubmate_ffmpeg*.zip" -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 10000000 }
    foreach ($ez in $existingZips) {
        try {
            Write-Host "      Extracting cached archive ($($ez.Name))..."
            $tempExtract = Join-Path $env:TEMP "dubmate_ffmpeg_x_$([Guid]::NewGuid().ToString('N'))"
            Expand-Archive -Path $ez.FullName -DestinationPath $tempExtract -Force
            $foundFfmpeg = Get-ChildItem -Path $tempExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
            if ($foundFfmpeg) {
                $binDir = $foundFfmpeg.DirectoryName
                Get-ChildItem -Path $binDir -Filter "*.exe" | ForEach-Object {
                    Copy-Item -Path $_.FullName -Destination $TargetDir -Force
                }
                $downloaded = $true
                Write-Host "      FFmpeg and FFprobe installed in tools\" -ForegroundColor Green
            }
            Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
            if ($downloaded) { break }
        } catch {
            Write-Host "      Cached archive extraction skipped: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    
    if (-not $downloaded) {
        $urls = @(
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
        )
        
        foreach ($url in $urls) {
            try {
                Write-Host "      Downloading from: $url"
                $tempZip = Join-Path $env:TEMP "dubmate_ffmpeg_$([Guid]::NewGuid().ToString('N')).zip"
                $tempExtract = Join-Path $env:TEMP "dubmate_ffmpeg_x_$([Guid]::NewGuid().ToString('N'))"
                
                Invoke-WebRequest -Uri $url -OutFile $tempZip -UseBasicParsing
                
                Write-Host "      Extracting FFmpeg binaries..."
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
                
                Remove-Item $tempZip, $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
                if ($downloaded) { break }
            } catch {
                Write-Host "      Download attempt failed: $($_.Exception.Message)" -ForegroundColor Yellow
                Remove-Item $tempZip, $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
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
    # Check if root has cloudflared.exe
    $rootCf = Join-Path $PSScriptRoot "..\cloudflared.exe"
    if (Test-Path $rootCf) {
        Copy-Item -Path $rootCf -Destination $cloudflaredPath -Force
        Write-Host "   -> Migrated cloudflared.exe to tools\" -ForegroundColor Green
    } else {
        Write-Host "   -> Downloading cloudflared.exe for multiplayer..." -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cloudflaredPath -UseBasicParsing
            Write-Host "      cloudflared.exe installed in tools\" -ForegroundColor Green
        } catch {
            Write-Warning "Cloudflared download failed: $($_.Exception.Message)"
        }
    }
} else {
    Write-Host "   -> cloudflared.exe already present in tools\" -ForegroundColor Green
}
