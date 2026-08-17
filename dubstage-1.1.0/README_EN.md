# DubForge & DubStage

Dub scenes from video yourself. **DubForge** cuts a video into speakable clips, **DubStage** records your voice and plays the scene back with it in one piece.

*Deutsche Fassung: `LIESMICH.md`*

---

## One-time setup

1. Put all files into one folder, e.g. `F:\DubForge`
2. Double-click **`Setup.bat`**

The setup installs the Python packages, downloads ffmpeg into a `tools` subfolder, and asks whether to install Demucs for vocal separation. Demucs pulls in PyTorch, several hundred MB up to ~2 GB. If you say no, everything still works, just without a backing track.

Then: **`Start DubForge.bat`** to build, **`Start DubStage.bat`** to record.

---

## Switching language

Top right of the window: **Deutsch / English**. Takes effect immediately — labels, messages, dialogs and error texts. Your input is preserved. The choice is remembered.

---

# DubForge — building packs

**1. Source**

Either paste a YouTube link or pick a local file (MP4, MKV, MOV, WEBM, plain audio files work too). Enter the time span under "From" and "To" — `1:30`, `0:02:15.5`, or just `95` for seconds. Leave empty for the whole thing.

Then hit **"Load and analyse"**. The tool downloads or trims, extracts the audio, separates vocals from music and noise, and finds the spoken segments on its own.

**2. Review the clips**

The waveform shows the detected clips as boxes.

| Action | How |
|---|---|
| Listen to a clip | double-click the box |
| Select a clip | single click |
| Move start/end | drag the edge of the box |
| Create a new clip | drag across an empty area |
| Rename | double-click in the list |
| Zoom | mouse wheel over the waveform |

Too many or too few clips? Adjust **Sensitivity** and hit **"Detect again"**. Clips too long? Lower **Max. clip length** and detect again.

**Subtitles:** There is a field for them below the list. Click a clip, type the text, press **Enter** — that saves it and jumps straight to the next clip, so you can work through everything without touching the mouse. DubStage later shows the text in large type under the video. Optional: clips without a subtitle work normally.

**3. Build**

Enter a pack name, tick **"With video"** (required for DubStage), then **"Build pack"**. The pack lands in the `packs` folder next to the tool — exactly where DubStage looks. **"Copy to target folder"** puts a copy anywhere else you like.

## What ends up in the pack

| File | Purpose |
|---|---|
| `01_Name_44-048.wav` | One clip. The trailing number is its start time in the video (44.048 s) |
| `dub_video.mp4` | The video for the scene |
| `_backing_track.wav` | Music and noise without vocals |
| `_captions.json` | The subtitles, keyed by clip file name |
| `_TIMESTAMPS.txt` | Overview of all start times plus subtitles |
| `_README.txt` | Short summary |

All clips are normalised loud (peak −1 dBFS) so that loudness does not get in the way of the comparison.

---

# DubStage — recording

Pick a pack → **Start**. Per line:

| Button | What happens |
|---|---|
| **▶ Original** | The video segment plays with the original line |
| **● Record** | 3-2-1, then the same segment runs and you speak over it |
| **▶ My take** | Play your take back, against the video |
| **Leave line empty** | Discard the take, the line keeps the original |
| **‹ Back / Next ›** | Change line |

Below the video the line's **subtitle** is shown in large type. The strip above it shows every line: green = recorded, gold = where you are. Click it to jump.

After the last line **Done** leads to the finale: the whole scene plays with your voice, subtitles running along. **Save as video** writes an MP4 into the `dubs` folder. **‹ Back to the lines** returns any time.

Keyboard: **Space** records or starts the finale, **Esc** goes back.

## The comparison strip

Above the button row sits the actual tool: the **original track as a blue silhouette**, with **your take** laid over it semi-transparently — red and growing live while recording, green afterwards. A gold marker shows where you are.

Both curves share the same time axis, starting at zero of the clip. So you can see at a glance whether you come in too early or too late and whether your pauses line up: if the blocks sit on top of each other, the timing matches. The strip is slightly wider than the original because recording continues for 0.7 seconds after the clip — room to finish the sentence.

Each curve is normalised to its own loudness, so what you compare is rhythm, not level. If your take is too quiet, a note appears at the bottom right.

## Microphone

The menu has **Test**: records two seconds, shows the level, plays it back. If nothing arrives, pick a different device in the dropdown next to it.

## Frame rate

The default is **25 frames per second** at 960 px wide. The video is split into single frames once and cached under `%TEMP%\dubstage_cache`, roughly 37 MB per minute of video.

If your machine stutters or space gets tight, change it in `dubstage_settings.json`:

```json
"video_fps": 20
```

Allowed range is 8 to 30. The frames are regenerated the next time you open that pack.

## Packs that do not show up

The search covers the `packs` folder next to the tools. **Add folder** permanently adds any other folder.

For a folder to count as a pack it needs a **`dub_video`** (mp4, ogv, mkv, webm, mov or avi) and at least one clip with a timestamp in its file name.

---

## Updates

Both tools ask GitHub on start whether a newer release exists — at most once
every six hours. If there is, a banner appears at the top: it names the version,
**What's new** expands it to show that release's changelog, and **Update now**
installs it. The archive is downloaded and checked, the app closes, the files
are replaced and it starts again — takes a few seconds.

Your `packs/`, `dubs/`, `tools/` and settings are never touched. Only the
program files are replaced, and the previous ones are copied to a backup folder
in `%TEMP%` beforehand, with a log of every step beside it.

Apart from downloading a video you asked for, this is the only time either tool
touches the network, and nothing is sent. To switch it off, set
`"check_updates": false` in `dubforge_settings.json` or `dubstage_settings.json`.

---

## When something goes wrong

**Windows blocks the BAT files** — Right-click → Properties → tick **Unblock** at the bottom. Or in PowerShell inside the folder: `Get-ChildItem -Recurse | Unblock-File`. Important: move the files out of the downloads folder into a normal folder first.

**"ffmpeg not found"** — Run Setup.bat again. If that fails: grab the **release full** build from `gyan.dev/ffmpeg/builds`, extract it, and put `ffmpeg.exe`, `ffprobe.exe` and `ffplay.exe` from `bin` into `tools\`.

**A YouTube download fails** — Almost always an outdated yt-dlp. YouTube keeps changing how it serves video, so the tool only stays current for a few weeks. Click **Update yt-dlp** in the top right of DubForge; the version and its age are logged at startup. By hand: `py -m pip install --upgrade yt-dlp`.

**Demucs fails** — Not a problem, the tool falls back to the original audio automatically. You only lose the backing track.

**Clips are slightly off** — With YouTube downloads the cut can snap to a keyframe. Set the time span a few seconds wider and adjust in the editor.

**Microphone records nothing** — Pick a different device in the DubStage menu and press **Test**.

---

You are responsible for only using material you are entitled to use.
