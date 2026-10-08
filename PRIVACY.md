# Privacy

DubMate has no accounts, no ads, and doesn't collect usage data or crash reports. Recording, effects and rendering happen on the host's computer, not on a server. This page lists everything that does go online, where your files are, and how to delete them.

- [What DubMate doesn't do](#what-dubmate-doesnt-do)
- [What goes online, and to whom](#what-goes-online-and-to-whom)
- [Recording in someone's room](#recording-in-someones-room)
- [Where your data lives](#where-your-data-lives)
- [Your content](#your-content)
- [Questions](#questions)

## What DubMate doesn't do

- No accounts or sign-in.
- No analytics, usage tracking or crash reports.
- No ads.
- Your microphone is recorded in the DubMate page and processed by DubMate on the host's computer. It isn't sent anywhere else.

## What goes online, and to whom

Each service below sees the IP address of the computer that contacts it.

- **Room codes: DubMate's room registry, `dubmate.bkaproductions.com` (on Cloudflare).** When you open a room, DubMate stores its room code with the room's web address, a secret that lets your DubMate update the entry, the time it was created and your DubMate version. DubMate refreshes it while the room is open, and it's deleted 12 hours after the last refresh. Invite links and joining by code ask the registry for the room's address. The registry stores nothing else: no names, recordings or IP addresses.
- **The connection for friends: a Cloudflare quick tunnel (`trycloudflare.com`).** When the desktop app opens, it starts a tunnel so friends can join from anywhere. Everything in the room travels through Cloudflare: the page, the video, everyone's takes. Cloudflare sees the IP address of the host and of everyone who joins. DubMate also listens on your local network, so a device on the same Wi-Fi can join by your computer's address.
- **Updates: GitHub (`api.github.com`, `github.com`).** Every time the desktop app opens, it asks GitHub for the latest release, and downloads it from GitHub when there's a newer one. If an update needs new Python packages, they come from PyPI. If you run DubMate from source, `update.bat` and `update.sh` update it with git from GitHub and pip from PyPI.
- **Fonts: Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`).** The studio and the Pack Builder load their fonts from Google, so Google sees the IP address of everyone who opens them, including friends who join from a browser. The desktop app's start screen uses fonts built into the app.
- **Installing the Pack Builder: PyPI (`pypi.org`, `files.pythonhosted.org`).** Ticking Pack Builder downloads about 2 GB of Python packages from PyPI.
- **Pack Builder models, the first time each is needed.** They're kept on your computer afterwards.
  - The Whisper transcription model, from OpenAI's `openaipublic.azureedge.net`, the first time you transcribe a video.
  - The Demucs voice separation model, from Meta's `dl.fbaipublicfiles.com`, the first time you separate voices.
  - The speaker detection models, about 35 MB, from the sherpa-onnx project's releases on `github.com/k2-fsa`, the first time the Pack Builder works out who says each line.
- **Videos you import by link.** The Pack Builder downloads the video, and its subtitles if it has any, from the site the link points to (YouTube, for example).

## Recording in someone's room

When you record in someone else's room, your takes are sent to the host's computer, and the host can export and share them.

- Your name, your colour, every take you record and your room checks (a few seconds of room sound and the name of your mic) go through the room's connection to the host's computer and are saved there.
- Everyone in the room can play your takes.
- The host can save them in videos, separate tracks and project ZIPs, and share those.
- To have your takes removed, ask the host.

## Where your data lives

The desktop app keeps your work in DubMate's own folder:

- **Windows:** `%LOCALAPPDATA%\DubMate` (usually `C:\Users\<you>\AppData\Local\DubMate`)
- **macOS:** `~/Library/Application Support/DubMate`
- **Running from source:** the `data` folder inside your DubMate folder, or `~/.dubmate/cache` if DubMate can't write there.

Inside it:

| What | Desktop app (in DubMate's folder) | Running from source |
|---|---|---|
| Rooms, takes and sessions | `data/rooms` | `data/rooms` |
| Room checks | `data/noise_profiles` | `data/noise_profiles` |
| Pack Builder work files | `data/builder` | `data/builder` |
| Waveforms, kept to open lines faster | `data/peaks` | `data/peaks` |
| Saved videos, separate tracks and ZIPs | `data/exports`, or the Export folder you chose in Audio settings | the same |
| Pack Builder add-on | `ai-packages` | the `.venv` folder in your DubMate folder |
| Speaker detection models | `ai-packages/dubmate-models/speakers` | `data/models/speakers` |

Elsewhere on your computer:

| What | Where |
|---|---|
| Settings (your packs folders and export folder) | `~/.dubmate/config.json` (on Windows, `C:\Users\<you>\.dubmate\config.json`) |
| Scene packs | the `Packs` folder that comes with DubMate, plus any folder you chose with Packs folder |
| Whisper and Demucs models | `~/.cache/whisper` and `~/.cache/torch` |
| Your name, colour, audio settings and mic sync in the desktop app | Windows: `%LOCALAPPDATA%\com.dubmate.studio`. macOS: `~/Library/WebKit/com.dubmate.studio` and `~/Library/Caches/com.dubmate.studio` |

### Delete everything

1. Quit DubMate.
2. Delete DubMate's folder, the `.dubmate` folder in your home folder, and the `com.dubmate.studio` folders above.
3. Delete any export or packs folder you chose yourself, if you don't want to keep what's in it.
4. Delete `~/.cache/whisper` and `~/.cache/torch` if no other app uses them. Other apps that use PyTorch share `~/.cache/torch`.
5. Uninstall the app: on Windows from Settings > Apps, on macOS by moving DubMate Studio to the Bin. If you run DubMate from source, delete its folder.

Room codes are deleted from the registry within 12 hours of the room closing.

### If you joined from a browser

Your name, colour and audio settings are kept in your browser for the room's address. Clear that site's data in your browser to remove them. What you recorded is on the host's computer.

## Your content

You need the rights to the videos you import, dub and share. Downloading from YouTube and similar sites can be against their terms. This isn't legal advice.

## Questions

Ask in a [GitHub issue](https://github.com/sylenthsnares/DubMate/issues) on sylenthsnares/DubMate. Issues are public, so don't post personal details. To report a security problem, follow [SECURITY.md](SECURITY.md) instead.
