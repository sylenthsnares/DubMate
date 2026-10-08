# Design: 2.0 notices (privacy, your content, licences, security, About)

Branch `fix/v2-notices` from `origin/main` at `f851fa9`. Before-shots: `%TEMP%/dm_shots/v2-notices/before-*` (1440x900 and 960x680; strings in `before-report.txt`): first-run mic intro as host (`01`) and as a guest (`05`), the logo menu (`02`), the `?` sheet (`03`), Audio settings (`04`), and the Pack Builder's link import (`06`).

## Goal

Before 2.0, someone can find out in a minute, in plain words, what DubMate sends where, where their files are and how to delete them, whose code ships inside it under which licence, and how to report a security hole. A guest in someone else's room is told, where they set up their mic, that their takes go to the host's computer. Nothing here is legalese. No line claims something the code doesn't do.

## Owner decisions this implements

- 2026-10-09: code signing is deferred. Add PRIVACY.md (contact through GitHub issues for now, "we can change it later"), a "Your content" note, THIRD_PARTY_NOTICES, SECURITY.md, an About panel and a "Where your data lives" section.
- The guest recording notice must **not** go on the join card. It goes in Audio settings (where a guest sets up their mic) and in the About panel.
- PR #19's privacy rule: a member or guest on someone else's engine never sees the host's folders.
- Out of scope: booth, lobby, landing and join card (PRs #26/#28); installers, bundling and `release.yml` (the installer PR, `fix/v2-installer`, ships these files inside the installers and moves user data).

## Facts checked in code (the docs say these and nothing more)

- No accounts, no analytics, telemetry or crash reporting: no such code in the engine, the studio, the launcher or the worker.
- **Room registry** (`worker/src/index.ts:283-291`): room code → `tunnel_url`, `room_token`, `created_at`, `app_version`, kept 12 h (`expirationTtl: 43200`). The engine refreshes it while the room is open (`room_registry.registry_heartbeat`). Joining by code asks `dubmate.bkaproductions.com/rooms/<code>/resolve` (`lobby.js:533`).
- **Tunnel**: the desktop app starts a cloudflared quick tunnel when it opens (`sidecars.rs:270`, `:452`). Cloudflare carries all room traffic and sees IP addresses. The engine also listens on the LAN (`app.py:366`, `0.0.0.0`).
- **Guests**: their name and colour (localStorage `dubmate_user`), takes, and room checks (a few seconds of room sound plus the mic's name, `noise_profiles_api.py:55`) go through the host's tunnel to the host's computer. The host can export and share takes (video, stems, project ZIP), and everyone in the room can play them.
- **Updates**: on every launch the desktop app asks `api.github.com/repos/sylenthsnares/DubMate/releases/latest` and downloads the bundle from `github.com` (`updater.rs:225`, `main.rs:53`). Source installs update with `git` from GitHub (`update.bat`/`update.sh`).
- **Downloads on demand**:
  - Pack Builder install: pip from PyPI (`packbuilder.rs:697`, `requirements_builder.txt`).
  - Whisper weights (openai-whisper's default host) on first transcription.
  - Demucs `htdemucs` weights (via torch hub) on first separation.
  - Speaker models from `github.com/k2-fsa/sherpa-onnx/releases`, about 35 MB, first use only (`pack_builder.py:1009-1029`).
  - yt-dlp contacts the site of the link the user pastes.
  - The engineer checks the exact Whisper and Demucs hosts and cache folders in the installed packages. They are not set by DubMate (no `TORCH_HOME` or `XDG_CACHE_HOME` in `sidecars.rs`), so they default to `~/.cache/whisper` and `~/.cache/torch`.
- **Fonts**: the studio and the Pack Builder load their fonts from Google Fonts (`index.html:12-15`, `builder.html:10-12`), so Google sees the IP address of everyone who opens them, guests included. The launcher bundles its two fonts (`tauri/src/fonts`, OFL).
- **Mic audio** is recorded in the page and processed by the engine on the host's computer. Nothing is sent anywhere else.
- **Data folders today** (`pack_loader.py:71-101`):
  - data root `DUBMATE_CACHE_DIR` → `cache_dir` in config → `<install>/data` → `~/.dubmate/cache` → temp;
  - inside it: `rooms/` (rooms, takes, sessions), `noise_profiles/`, `builder/`, `models/speakers/`, `peaks/`, `pack_index.json`, `exports/` (unless `exports_dir` is set);
  - config at `~/.dubmate/config.json`;
  - packs in `<install>/Packs` plus the `packs_dir`/`extra_packs_dirs` from config;
  - the Pack Builder add-on at `<install>/ai-packages`, with speaker models in `ai-packages/dubmate-models/speakers`.
  
  The installer PR moves the desktop data root to `%LOCALAPPDATA%\DubMate` / `~/Library/Application Support/DubMate`. It isn't on origin yet (checked at `f851fa9`), so PRIVACY.md describes the 2.0 locations and the PR body carries the TODO to check them against `fix/v2-installer` before merge.
- **Shipped binaries**:
  - `externalBin` = cloudflared, ffmpeg, deep-filter (`tauri.conf.json:44-48`).
  - Python runtime: CPython 3.12.4 embeddable from python.org on Windows; python-build-standalone 20240713 on macOS.
  - FFmpeg on Windows: BtbN `autobuild-2026-07-31-14-10` `ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1`, SHA-pinned. That is a **GPL build**, so the GPL source offer applies.
  - FFmpeg on macOS: whatever Homebrew has at build time (unpinned, GPL).
  - DeepFilterNet 0.5.6 (SHA-pinned, model built in). cloudflared "latest" (unpinned).
  - `requirements.txt` and everything pip resolves for it, plus pip, setuptools and wheel.
  - The Rust launcher with its crates.
- **Ported code**: integrated loudness follows pyloudnorm, ported to numpy (`audio_processor.py:693`), MIT.
- Private vulnerability reporting is **off** on `sylenthsnares/DubMate` (`gh api …/private-vulnerability-reporting` → `{"enabled":false}`).

## Layout and behaviour

### 1. Documents (repo root)

**PRIVACY.md.** Short sections, each opening with the outcome:

- What DubMate doesn't do: no accounts, no ads, no usage data or crash reports.
- What goes online, and to whom: one bullet per destination, listed in the facts above (registry, Cloudflare tunnel, GitHub updates, Google Fonts, PyPI and the model hosts, sites you import from), each with when it happens and what is sent.
- Recording in someone's room: your name, colour, takes and room checks go to the host's computer, and the host can export and share your takes.
- Where your data lives: a table of folder, what's in it, and path on Windows, macOS and a source install. Rows: data (rooms and takes, room checks, Pack Builder work files, speaker models, caches), saved videos, scene packs, settings (`~/.dubmate/config.json`), the Pack Builder add-on, the Whisper and Torch model caches, and the desktop app's WebView data (`%LOCALAPPDATA%\com.dubmate.studio`; `~/Library/WebKit/com.dubmate.studio` and `~/Library/Caches/com.dubmate.studio`, checked on a real install). Then "Delete everything": quit DubMate, delete those folders, uninstall. Guests: clear the site's data in their browser.
- Your content: you need the rights to the videos you import, dub and share. Downloading from YouTube and similar sites may be against their terms. "This isn't legal advice."
- Questions: GitHub issues on sylenthsnares/DubMate, which are public, so no personal details. Security holes go to SECURITY.md instead.

**SECURITY.md.**
- Report privately with GitHub's "Report a vulnerability" (Security tab → Advisories). The owner must switch it on first (hands-on).
- In scope:
  - the engine's HTTP and WebSocket server as reached through the tunnel and the LAN;
  - the room registry worker;
  - the desktop updater and the Pack Builder installer;
  - the desktop app's commands open to the studio page.
- Out of scope: Cloudflare's, GitHub's and upstream projects' own bugs (report those upstream).
- Supported versions: the latest release only.
- What to expect: an acknowledgement, a fix in the next release, and credit if wanted. No promised SLA.

**THIRD_PARTY_NOTICES.md.** One file the installer PR ships as is. Sections:
1. **In the desktop app.** Name, version (pinned or "current at build time"), licence, source URL:
   - DubMate itself (GPLv3);
   - CPython (PSF-2.0; python-build-standalone's extra components by pointer to the licence files it ships in `python-runtime`);
   - every package in the runtime, resolved by `pip install -r requirements.txt` into a clean venv and read with `importlib.metadata` (the command goes in a comment at the top);
   - pedalboard (GPLv3, with JUCE and Rubber Band inside);
   - FFmpeg: the Windows pinned build with its GPL source offer (the FFmpeg source at commit `9b6c8969e0`, plus BtbN's build scripts at that autobuild tag), and the macOS Homebrew build;
   - DeepFilterNet 0.5.6 (MIT OR Apache-2.0) and cloudflared (Apache-2.0);
   - the launcher's Rust crates: the direct ones by name, and the rest summed up by licence from `cargo metadata`. Every crate whose licence isn't MIT or Apache-2.0 is named.
   - the launcher fonts (OFL-1.1; the OFL files sit beside them);
   - icons (Lucide, ISC, if the engineer confirms the paths are Lucide's).
2. **Downloaded when you install the Pack Builder** (from PyPI, not shipped by DubMate): torch, torchaudio, demucs, openai-whisper, pykakasi, yt-dlp and sherpa-onnx, each with its licence.
3. **Models downloaded on first use**: Whisper weights (MIT), Demucs htdemucs (MIT), pyannote segmentation 3.0 ONNX (MIT), 3D-Speaker CAM++ (Apache-2.0).
4. **Code adapted from**: pyloudnorm (MIT).
5. **Licence texts**: each licence text once (MIT and BSD with each holder's copyright line, Apache-2.0, ISC, PSF, OFL pointer, Unlicense). GPLv3 is the repo's LICENSE.

**README.md.**
- The Licensing section links LICENSE, THIRD_PARTY_NOTICES.md, PRIVACY.md and SECURITY.md, and keeps its model lines (or points to the notices for them).
- "Fair Use & Media Disclaimer" becomes a short plain "Your content" with the same two sentences as PRIVACY.md and a link to it. The § 107 claim goes, because it's legal advice the app can't stand behind.
- Add the new section to the TOC.

**CHANGELOG `[Unreleased]`**: one Added entry ("About DubMate, privacy and licence notices"), and one Changed line for the Audio settings privacy wording. Add both at the end of their sections.

### 2. Engine: data folders (own computer only)

New `dubmate/data_folders.py`, the one place the studio learns real paths:

- `data_folders() -> list[{key, label, path, exists}]`, in order:
  - `rooms` "Rooms and takes" (`CACHE_DIR/rooms`);
  - `exports` "Saved videos" (`common.exports_dir()`);
  - `packs` "Scene packs" (one row per `pack_loader.PACKS_DIRS` entry, keys `packs`, `packs-2`…);
  - `settings` "Settings" (folder of `pack_loader.get_config_path()`);
  - `addon` "Pack Builder add-on", only when `pack_builder._addon_dir()` finds one;
  - `data` "Everything else" (`CACHE_DIR`).
- `GET /api/data-folders` → `{folders: [...]}`. `common.require_own_computer`, so a tunnel guest or LAN device gets 403.
- `POST /api/data-folders/open` `{key}` → own computer only. It resolves the path from `data_folders()` **by key** (never a path from the request), requires an existing directory, and opens it in the file manager (`explorer <dir>` / `open <dir>` / `xdg-open <dir>`, beside `rooms_api.reveal_in_file_manager`). Unknown key → 400; missing folder → 404 "That folder doesn't exist yet."
- Works in the desktop app and in a browser on the host's computer, like Show in folder. No Rust needed. The installer PR changes the paths inside `data_folders()` and adds no second endpoint (PR body note).

### 3. Desktop app: fixed DubMate pages

`external.rs`:
- `ExternalTarget::Page(DubMatePage)` with `Source`, `Licence`, `Notices`, `Privacy` and `Security`, each a `const` URL:
  - `https://github.com/sylenthsnares/DubMate`;
  - `…/blob/main/LICENSE`, `…/blob/main/THIRD_PARTY_NOTICES.md`, `…/blob/main/PRIVACY.md`, `…/blob/main/SECURITY.md`.
- Windows `rundll32 url.dll,FileProtocolHandler <url>`, macOS `open <url>`, anything else Err.
- `#[tauri::command] open_dubmate_page(page: String)` maps `"source" | "licence" | "notices" | "privacy" | "security"` to the enum, and anything else is Err. Only the name crosses from the page, never a URL.
- Register it in `main.rs` and `build.rs`. `allow-open-dubmate-page` goes in `capabilities/studio.json`, with its description updated.

### 4. Studio: the About panel

**Openers.**
- The logo menu gets a hairline divider and a third row, `button#mode-opt-about.mode-dropdown-item`: an info-circle stroke SVG (not an emoji), "About DubMate", desc "Version, licences and privacy". `#btn-mode-dropdown`'s label becomes "DubMate menu".
- On the studio page, the `?` sheet gets a footer `button.btn.btn-ghost.btn-sm` "About DubMate". It closes the sheet and opens About, and focus returns to the opener.
- The Pack Builder's menu and sheet are unchanged.

**Markup.** `#modal-about.studio-modal-overlay` (`role="dialog"`, `aria-modal`, `aria-labelledby="about-title"`), opened with `openDialog`: Esc and backdrop close it, and focus returns to the opener. The card `.studio-modal-card.about-card` is 560px max, scrolls inside itself (`max-height: calc(100vh - 48px)`), and has a `.modal-close-btn`. There is no amber button in it: nothing in it is the one action.

**Content, top to bottom.**
1. The logo mic icon and `h2#about-title` "About DubMate". Below it, a 12px muted meta line: "Version 2.0.0" on the own computer, "This room runs DubMate 2.0.0" for a guest. The version comes from the existing `/health` read (`update_notice.js`). If that fails, the line is hidden.
2. "Free and open source under the GNU GPL v3." (13px.)
3. A wrapping row of `btn-secondary btn-sm` links: Source code, Licence, Third-party notices, Privacy, Security.
   - **Browser:** `a target="_blank" rel="noopener noreferrer"`, with the accessible name plus " (opens in a new tab)" and the URL as `data-tip`.
   - **Desktop on its own engine:** a button calling `invoke('open_dubmate_page', {page})`.
   - **Older desktop app** (`olderDesktopApp`, or the invoke refused): "Copy link", with the same hint behaviour as `downloadPageControl`.
   - Generalise that helper into `externalLinkControl({url, label, page})`, and rebuild `downloadPageControl` on it, behaviour unchanged.
4. "Privacy" (title 14px 700), then two 12px sentences:
   - "DubMate has no accounts and collects no usage data. Recording, effects and rendering happen on the host's computer."
   - "Recording in someone else's room: your takes are sent to the host's computer, and the host can export and share them."
5. "Where your data lives":
   - **Own computer:** fetched from `GET /api/data-folders` when the panel opens. One row per folder: the label (12px 600), the path (JetBrains Mono 12px, `user-select: text`, `overflow-wrap: anywhere`, `--foreground-muted`), and `btn-ghost btn-xs` "Open folder" (it posts `/api/data-folders/open`; failure shows the error inline under the row, `role="status"`). A folder that doesn't exist yet shows "Not created yet" instead of the button. Below the list, 12px muted: "To remove everything, quit DubMate and delete these folders. The privacy notice lists the rest." A failed fetch shows "Couldn't read the folders." and the list stays empty.
   - **Member or guest** (`!isEngineLocal()`): no request and no paths. One line: "Your name, colour and audio settings are kept in this browser. What you record is on the host's computer."

### 5. Audio settings privacy lines

- `renderAudioIntro()` (`#audio-intro-privacy`):
  - own computer: "Your takes are saved on this computer." This replaces "Audio stays on this computer.", which stops being true once friends play your takes.
  - someone else's engine: "Your takes are sent to the host's computer, and the host can export and share them."
- Devices step: a new `<p id="audio-guest-privacy" class="audio-setup-note">` under `#audio-setup-subtitle` with the same guest sentence, shown only when `!isEngineLocal()`. Desktop members get the mic granted automatically and never see the intro step.
- The join card is not touched.

### 6. Pack Builder link import

Under `#url-input-group` (`builder.html`), shown and hidden with it: `<p id="url-import-rights" class="field-hint">Only import videos you have the right to use. Downloading from YouTube and similar sites can be against their terms.</p>`. The missing-tools state doesn't show it, because there's no import there.

## Implementation groups (build order)

1. **G1 Documents and drift tests** (§1): PRIVACY.md, SECURITY.md, THIRD_PARTY_NOTICES.md, the README and CHANGELOG edits, `tests/test_third_party_notices.py` and `tests/test_privacy_hosts.py`.
2. **G2 Engine folders and desktop pages** (§2, §3): `dubmate/data_folders.py` with its routes and `tests/test_data_folders.py`, plus `external.rs`, `main.rs`, `build.rs`, the capability and the Rust tests.
3. **G3 Studio About panel, privacy lines, builder line** (§4-6): `index.html`, `static/js/studio/about.js` (mixin), `update_notice.js` (shared link control), `shortcuts.js` footer, `audio_setup.js`, `builder.html`, `style.css`, the JSDOM tests and the after-shots.

## Tests

- `test_third_party_notices.py` fails when THIRD_PARTY_NOTICES.md doesn't name one of these:
  - each `externalBin` basename;
  - each top-level name in `requirements.txt` and `requirements_builder.txt` (normalised `-`/`_`, case-insensitive);
  - the FFmpeg build id parsed from both `stage-sidecars.ps1` and `download_tools.ps1` (so a re-pin forces a notices update);
  - the DeepFilterNet version from the stage scripts;
  - the CPython and python-build-standalone versions;
  - each `pack_builder.SPEAKER_MODELS` file;
  - each font in `tauri/src/fonts`.
- `test_privacy_hosts.py`: every `https://` host in the shipped code (`app.py`, `dubmate/`, `pack_builder.py`, `pack_loader.py`, `audio_processor.py`, `static/`, `tauri/src-tauri/src/*.rs` outside `#[cfg(test)]`) is named in PRIVACY.md. Allow-list the docs-only hosts: placeholders and the download page.
- `test_data_folders.py`:
  - GET lists the keys in order with real paths;
  - `cf-ray` / `cf-connecting-ip` or a non-loopback Host → 403 on both routes;
  - open: an unknown key → 400; a missing folder → 404; a known key calls the opener with the resolved path, with `subprocess.Popen` mocked;
  - a `path` in the body is ignored.
- `test_about_panel.js` (JSDOM, `buildStudioBundle`):
  - the logo menu row and the `?` footer open it, and focus returns;
  - own computer: the version line, the folder rows from mocked `/api/data-folders`, and Open folder posting the key;
  - guest: no `/api/data-folders` request, the guest line, and no path text anywhere in the panel;
  - links: browser anchors with `target=_blank` and `noopener`; desktop invoke with the page name; an older desktop app copies the link.
- `test_audio_settings_layout.js`: the new intro strings, and `#audio-guest-privacy` shown only off the own computer.
- `test_builder_step1.js`: the rights line sits inside the link import and hides with the input group.
- `test_update_notice.js` stays green after the helper is generalised.
- Rust (`cargo test`, `CARGO_TARGET_DIR=X:/Projects_X/DubMate/tauri/src-tauri/target`): each page on Windows and macOS, an unknown page name is Err, Linux is Err.
- The full suite (`tests/run_all_tests.py`), including `test_css_floors.js` and `test_design_tokens.js`.

## Risks

- **2.0 paths.** PRIVACY.md describes the installer PR's folders, which aren't on origin yet. The PR body TODO says to check them against `fix/v2-installer` before merge, and the About panel shows whatever the engine really uses.
- **FFmpeg source offer.**
  - BtbN prunes old autobuilds. That breaks the pin and a source link that points at the build.
  - So the notice points at FFmpeg's own git at the exact commit and at BtbN's scripts at the tag.
  - Attaching the source to each release (`release.yml`) is recommended to the installer PR or a follow-up, not done here.
- **macOS FFmpeg** is an unpinned Homebrew build, copied alone, that may link Homebrew libraries. The notices describe it honestly. Flag it to the installer PR.
- **Doc links** point at `blob/main/…` and 404 until this PR merges.
- **Tauri on a tunnel page**: an `<a target=_blank>` in the desktop window on a member's page. Same as the download link today. Check hands-on.

## Decided without the owner

1. "Your content" is a section of PRIVACY.md, not a separate CONTENT.md. README's "Fair Use" section becomes a short "Your content", dropping the § 107 claim.
2. Open folder goes through an own-computer-only engine route with fixed keys (as Show in folder does), not external.rs. Paths are always shown as selectable text too.
3. This PR adds `GET /api/data-folders`. The installer PR should change its paths, not add a second endpoint.
4. One Rust command, `open_dubmate_page`, with five fixed pages. It takes page names, never URLs.
5. The own-computer mic intro line becomes "Your takes are saved on this computer."
6. The guest sentence also shows on the Audio settings devices step, because desktop members skip the intro.
7. A guest's About says "This room runs DubMate X" and shows no paths, only that their settings are in this browser.
8. The studio keeps Google Fonts, disclosed in PRIVACY.md. Self-hosting them is a suggested follow-up.
9. The FFmpeg GPL source is offered by links to the exact upstream commit and build scripts.
10. All notices go in one file with the licence texts appended. Rust crates are summed up by licence, and the non-MIT/Apache ones are named.
11. pyloudnorm is credited for the ported loudness code, and Lucide for the icons if confirmed.
12. About is in the studio only. The Pack Builder gets only the rights line.
13. The `?` sheet on the studio gets an "About DubMate" footer button.
14. Privacy questions go to public GitHub issues ("don't post personal details"), and security reports to private advisories.

## Hands-on checks

1. Turn on private vulnerability reporting: repo Settings → Security → "Private vulnerability reporting".
2. Desktop app on your own room:
   - logo menu → About: each link opens the default browser;
   - each Open folder opens Explorer or Finder on the right folder;
   - the paths match the installed 2.0 layout.
3. Desktop app updated in place from 1.1.3: About's links read "Copy link" and copy.
4. Join a friend's room from the desktop app and from a browser:
   - Audio settings shows the guest line on both steps;
   - About shows "This room runs DubMate …", no paths, and working links;
   - the join card is unchanged.
5. Read PRIVACY.md, SECURITY.md and the notices once for tone. Confirm the FFmpeg source-link approach.
6. macOS: check the WebView data folders named in PRIVACY.md exist where it says.
