# 📦 DubMate Scene Packs Directory

Place your scene packs into this folder.

## How to Get Scene Packs

1. **Download Choicer Voicer Dub Packs**:
   Visit [GameBanana Choicer Voicer Mods](https://gamebanana.com/mods/cats/44064) and download any pack (`.zip`).

2. **Convert to DubStage Format**:
   - Drag the downloaded `.zip` file onto `CVConvert/Convert.bat` (or place it in `CVConvert/input/` and run `Convert.bat`).
   - The converted pack folder will appear in `CVConvert/output/`.

3. **Install Pack**:
   - Move or copy the converted folder from `CVConvert/output/` into this `Packs/` folder.
   - Click **Rescan Packs** in the DubMate web interface.

## Pack Folder Structure
Each pack folder inside `Packs/` should contain:
```
Packs/
└── Your_Scene_Name/
    ├── dub_video.mp4 (or dub_video.ogv)
    ├── _backing_track.wav
    ├── _captions.json
    ├── 01_Character_0-120.wav
    └── ...
```
