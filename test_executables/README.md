# Executable Testing Sandbox (`test_executables/`)

This directory is a dedicated, git-ignored sandbox for downloading, staging, and testing compiled `.exe` and `.msi` application builds.

## How to Test the Latest Build:

### 1. Auto-Fetch from GitHub Releases:
Run the helper script in PowerShell:
```powershell
.\test_executables\fetch_latest_test_exe.ps1
```
This downloads `DubMate.Studio_*_x64-setup.exe` from the latest GitHub Release directly into this folder.

### 2. Manual Test:
- Double-click the downloaded `.exe` in this folder.
- Test the startup flow, engine health probe, Cloudflare tunnel creation, and scene pack loading.
- Test multi-client room joining.

> **Note:** All `.exe`, `.msi`, `.dmg`, and temporary extraction logs placed in this directory are excluded by `.gitignore`.
