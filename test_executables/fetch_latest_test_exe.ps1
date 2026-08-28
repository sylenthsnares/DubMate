# fetch_latest_test_exe.ps1 - Downloads the latest release .exe installer for testing
$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot

Write-Host "========================================================="
Write-Host "  🎙️ Fetching Latest DubMate Studio .exe for Testing"
Write-Host "========================================================="

$ApiUrl = "https://api.github.com/repos/sylenthsnares/DubMate/releases/latest"
Write-Host "Checking latest release at $ApiUrl..."

$Headers = @{ "User-Agent" = "DubMate-Test-Fetcher" }
$Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers

Write-Host "Latest Release: $($Release.name) ($($Release.tag_name))"

$ExeAsset = $Release.assets | Where-Object { $_.name -like "*.exe" -or $_.name -like "*.msi" }

if (-not $ExeAsset) {
    Write-Warning "No .exe or .msi assets found in release $($Release.tag_name) yet."
    exit 0
}

foreach ($asset in $ExeAsset) {
    $TargetFile = Join-Path $ScriptDir $asset.name
    Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 2)) MB)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $TargetFile -UseBasicParsing
    Write-Host "Saved to: $TargetFile" -ForegroundColor Green
}

Write-Host ""
Write-Host "✅ Download complete! You can now run the installer from $ScriptDir" -ForegroundColor Cyan
