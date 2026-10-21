# Design: the 2.0 installer, your data and Pack Builder survive any reinstall

Branch `fix/v2-installer` from `origin/main` at `f851fa9`. Source: the 2.0.0 readiness audit (`%TEMP%/dubmate_overnight/release-2.0/READINESS.md`, 1.4 risks 3 and 5, 1.5 C) and the owner's 2026-10-09 decisions. Before state: `%TEMP%/dm_shots/v2-installer/before-*` (`before-report.txt` explains why the installer pages are described from the template rather than screenshotted: running setup or uninstall would close the owner's running DubMate).

## Goal

Today the desktop app keeps the user's work inside the folder it was installed to (`X:\DubMate Studio\data`, `ai-packages`, `packbuilder.optin`). The uninstaller always deletes Pack Builder, and the 2.0 installer's reinstall page preselects "uninstall before installing", which runs the 1.1.3 uninstaller and deletes the ~2 GB Pack Builder. The release also goes public before its installers exist.

After this PR:
- rooms, takes, saved videos, caches and Pack Builder live in a per-user folder that no install, reinstall or uninstall touches by default;
- uninstall removes them only when the user ticks "Also remove Pack Builder and my DubMate data";
- upgrading defaults to "Do not uninstall";
- LICENSE and THIRD_PARTY_NOTICES.md travel with both installers and the update zip;
- a release stays a draft until both installers are attached.

## Owner decisions this implements

- Code signing is deferred. Stay on Tauri's NSIS installer (custom template `installer.nsi`) and the macOS dmg.
- Data and `ai-packages` move to a per-user folder with a one-time migration that never deletes user data.
- Uninstall doesn't delete Pack Builder by default. Upgrades default to "Do not uninstall".
- LICENSE and notices ship in the installers. The release stays a draft until its installers are attached.
- The parallel PR `fix/v2-notices` writes THIRD_PARTY_NOTICES.md, PRIVACY.md, SECURITY.md and the About panel with "where your data lives". This PR only ships the files and gives the About panel a real data source: its `GET /api/data-folders` reads the moved folders through `pack_loader.CACHE_DIR` (`data_home.resolve`) and lists old folders 1.x left behind (`data_home.left_behind`). The earlier `GET /api/about/paths` had no caller and was dropped, so there is one endpoint.
- Out of scope: VERSION, tags, releases, booth, lobby, landing, join flow (PRs #26/#28), the user's `packs_dir` setting.

## Layout and behaviour

### 1. One place that says where data lives

**Per-user root (`DubMate data folder`):**
| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\DubMate` (fallback `~\AppData\Local\DubMate` if the variable is empty) |
| macOS | `~/Library/Application Support/DubMate` |
| Linux / other | `$XDG_DATA_HOME/DubMate`, else `~/.local/share/DubMate` (only reached by a packaged build; none ships today) |

Inside it, the same names the install folder used, so every move is one rename:
```
DubMate/
  data/               rooms/, exports/ (default export folder), peaks/, builder/, noise_profiles/, pack_index.json, *_web.mp4
  ai-packages/        Pack Builder add-on (pip --target)
  packbuilder.optin   installer's Pack Builder choice
```

**Packaged vs source.** Packaged = the Python files run from a folder named `resources`/`Resources` (what `pack_loader.get_install_root()` already detects). Source installs and dev Tauri runs keep today's behaviour exactly: `<repo>/data`, no migration.

**Engine: new module `dubmate/data_home.py`** (stdlib only, imported by `pack_loader` before `CACHE_DIR` is computed; `pack_loader` must not import `dubmate.common`, so the module has no project imports):
- `user_data_root(platform=sys.platform, env=os.environ, home=expanduser("~")) -> str`: the table above. `DUBMATE_DATA_DIR` in `env` wins (the 2.0 launcher sets it, tests use it). Pure: no disk access, so tests pass Windows-style and macOS-style inputs on Linux.
- `legacy_locations(install_root, base_dir, exe_dir=None) -> dict[item, list[path]]`: where 1.x kept each item. `data`: `<install_root>/data`, then `~/.dubmate/cache` (1.x's fallback when the install folder wasn't writable; only when it holds a `rooms` folder). `ai-packages` and `packbuilder.optin`: `<exe dir>` (Windows: the install root; macOS: `Contents/MacOS`), `<install_root>`, `<base_dir>`.
- `resolve(item, ...) -> path`: **the existence rule, identical in Rust**: use the new place unless it is missing and a legacy place has the item; then use that legacy place. A failed migration therefore keeps the old place automatically, a finished one uses the new place, and when both exist the new place wins. Stateless and idempotent.
- `left_behind(in_use) -> list`: legacy folders still on disk that DubMate no longer uses, for About's "Old copy, no longer used" rows.
- `pack_loader.get_cache_dir()` keeps `DUBMATE_CACHE_DIR` and the `cache_dir` setting first (tests and power users), then `resolve("data")` when packaged, then today's `<repo>/data` for source, then the existing fallbacks.
- `pack_builder.ensure_ai_packages_on_path()` adds `resolve("ai-packages")` first, then the legacy candidates it checks today.

**Launcher: `paths.rs`** gets the Rust equivalent:
- `user_data_root_for(os: TargetOs, env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf` (pure, unit-tested for Windows and macOS layouts on any host) and `user_data_root(app)`: `DUBMATE_DATA_DIR`, else the table; in a cargo dev run (`is_cargo_target_dir`) it returns `install_root_dir()` as today.
- `resolve_user_item(app, name)` with the same existence rule. `ai_packages_dir`, `get_packbuilder_status`, `prepare_install`, `removal_target`, `delete_packbuilder_files` and the PYTHONPATH in `spawn_engine` all go through it instead of `install_root_dir(app).join(...)`. `removal_target`'s "the folder directly inside its root" check is kept, with the root being whichever place `resolve_user_item` chose.
- `spawn_engine` sets `DUBMATE_DATA_DIR` for the engine.

### 2. One-time migration

`dubmate/data_home.migrate(allow_copy: bool, include_packbuilder: bool, log=print) -> list[result]`, one implementation, two callers:

1. **The 2.0 launcher, before it starts the engine.** In `start_sidecars`, if any legacy item exists (cheap `exists()` checks in Rust), it emits `startup-progress` "Moving your DubMate files to their new folder" and runs the bundled Python once with the engine's environment: `python -m dubmate.data_home --migrate --copy --packbuilder`. No timeout (a cross-drive copy of Pack Builder can take minutes); its output goes to the same log as the engine's. Then it starts the engine as usual. Nothing to move costs no Python start. "Legacy item exists" means the existence rule would pick an old place (the new one is missing), so a folder left behind after a finished move doesn't start Python on every launch. The same goes for an item the move leaves on purpose or keeps failing on: `migrate` records it in `<root>/.move-status.json` (`{item: {"status": "kept"}}` when `DUBMATE_CACHE_DIR`/`cache_dir` is set or a chosen export or packs folder is inside the old `data`; `{item: {"status": "failed", "tries": n}}` after a failed launcher copy), and `has_items_to_move` skips a kept item and a failed one after 2 tries. A kept record is cleared as soon as the reason goes; a successful move clears its record. Before copying, the move checks the destination drive has room for the copy (plus 100 MB) and fails at once if not. `python -m dubmate.data_home --migrate` exits 1 when something stayed in the old folder; the launcher then emits `files-not-moved` and the splash says "Your files stayed in their old folder and still work". Around the move Rust also emits `moving-files` (`true`, then `false`): the splash then shows "This happens once and can take a few minutes" with the count instead of "Taking longer than usual", offers no Restart (a restart there would start a second engine) and doesn't show the 3-minute card; the engine's own start is counted from the end of the move. Setup starts the move before the launcher page listens, so Rust also keeps it in `SharedState.file_move` and the launcher asks once (`get_file_move` -> `{moving, failed}`), the way it asks `get_last_failure`. The move's Python is stopped when the window closes (`stop_file_move`); a stopped copy leaves the source whole and the next start copies again.
2. **The engine at import, rename only** (`allow_copy=False, include_packbuilder=False`), only when the running script is `app.py`: the speaker-detection child imports `pack_loader` too and must never move the folder out from under the running engine. This covers a 1.x desktop app that took the 2.0 update in-app: its launcher is 1.1.3, which never runs step 1. On macOS 1.x kept data inside the app bundle (`Contents/Resources/data`, beside the staged `resources` folder that holds app.py), which dragging in the 2.0 dmg replaces, so moving it out while the old launcher still runs is the only chance to save it. Pack Builder is left alone here: the 1.1.3 launcher looks for it only in the install folder and would download 2 GB again.

Per item (`data`, then `ai-packages`, then `packbuilder.optin`):
- Skip when there is no legacy copy, or when the new place already exists and isn't empty: never merge, never overwrite. Log `Old <item> folder left at <path>; DubMate uses <new>` once.
- Try `os.rename(old, new)` (same drive: instant, atomic).
- Cross-drive (`EXDEV` / WinError 17): only with `allow_copy`. Copy to `<new>.partial` (cleared first if a previous attempt left one), flushing each copied file to the disk itself (`fsync`, so a power cut after the source is removed can't lose it), verify every file exists with the same byte size as its source and the file counts match, rename `<new>.partial` to `<new>`, then remove the source. A failed removal after a verified copy is logged and left; the new place wins from then on.
- One move at a time: `migrate` holds an OS lock on `<root>/.move.lock` (released by the system if the process dies) while it moves anything, so a second DubMate started meanwhile waits, then finds the move done, instead of reading the old folder or clearing the first one's `.partial`. With nothing left to move it takes no lock.
- Any error before the final rename: remove `<new>.partial` (only ever our own copy), keep the source, log `Could not move <item> to <new>: <reason>. DubMate keeps using <old>.` The next start tries again (the launcher at most twice, see above).
- Rooms save the finished dub's path as an absolute path. When a room loads and that path is gone, the same file name in the current export folder is used if it is there, so a room's dub survives the move.
- Never deletes a source that wasn't verified as copied. Never touches `Packs/`, a configured `exports_dir`, `cache_dir` or `packs_dir`.
- When `DUBMATE_CACHE_DIR` or the `cache_dir` setting is set, `data` isn't migrated: the user chose that folder.
- Runs with the engine stopped (step 1) or before anything opens files (step 2).

### 3. Installer and uninstaller (Windows, `installer.nsi` + `installer-hooks.nsh`)

**Reinstall page.** When upgrading (`SemverCompare` = 1) the first visit preselects "Do not uninstall" (`$ReinstallPageCheck` initialised to 2 on that branch). Same-version and downgrade defaults are unchanged. Keyboard focus goes to whichever choice is checked. The text above the choices on that branch is DubMate's own, "An older version of DubMate is installed. Installing over it keeps your rooms, settings and Pack Builder.", instead of Tauri's line recommending to uninstall first. Passive mode (`/P`) already skips uninstalling on upgrade (`PageLeaveReinstall` reads the page state), so behaviour matches.

**Protecting Pack Builder from an old uninstaller.** If the user still picks "Uninstall before installing", the installer renames `$INSTDIR\ai-packages` to `$INSTDIR\ai-packages.keep` and copies `packbuilder.optin` to `$PLUGINSDIR` before `ExecWait` on the old uninstaller, and restores both right after it returns (success, cancel or error). Same folder, so the rename is instant. The folder is the one the old uninstaller is told to uninstall (`_?=`, the registered install location, `$4` in the template), which is `$INSTDIR` unless setup was started with `/D=`. The old uninstaller's exit code is read before the restore, so a restore error can't turn a finished uninstall into "unable to uninstall". The 1.1.3 hook deletes only `$INSTDIR\ai-packages`; its file list never included `data`.

**Old uninstallers can't be changed.** A 1.1.3 uninstaller run on its own from Windows Settings still deletes `$INSTDIR\ai-packages`. Documented in the CHANGELOG known issues (wording left to the release-notes PR): "Use the 2.0 installer to upgrade; don't uninstall 1.x first."

**Pack Builder choice.** `SecPackBuilder` writes `$LOCALAPPDATA\DubMate\packbuilder.optin` (creating the folder). `InitPackBuilderDefault` preselects the component if either the new or the old marker exists. The main section deletes both stale markers, as it does today for the old one.

**Uninstall confirm page.** The existing checkbox becomes the one choice, unticked by default:
- label: **Also remove Pack Builder and my DubMate data**;
- a second line under it (static text, same font): "Rooms, takes, videos and settings in DubMate's own folder. Your scene packs are kept."
- When the uninstaller runs with `/UPDATE` or with the new `/KEEPDATA` switch, the checkbox isn't created and its state is 0. The 2.0 installer passes `/KEEPDATA` whenever it runs a previous uninstaller (reinstall flow). The name avoids the `/P` and `/UPDATE` prefixes, because `GetOptions` matches prefixes.

**`NSIS_HOOK_PREUNINSTALL`** removes data only when `$DeleteAppDataCheckboxState = 1`, `$UpdateMode <> 1` and `/KEEPDATA` wasn't given:
- `$LOCALAPPDATA\DubMate` (guarded: `$LOCALAPPDATA` not empty);
- `$INSTDIR\ai-packages`, `$INSTDIR\ai-packages.keep`, `$INSTDIR\data`, `$INSTDIR\packbuilder.optin` (anything a failed migration left behind);
- `$PROFILE\.dubmate` (settings, mic sync, the 1.x fallback cache);
- WebView data in `$APPDATA`/`$LOCALAPPDATA\com.dubmate.studio`: the template already removes it under the same checkbox.

Never removed: the packs folder, a configured export folder outside `DubMate\data`. Unticked, the uninstaller removes program files only.

**macOS** has no uninstaller. Dragging the app to the Bin leaves `~/Library/Application Support/DubMate`. Nothing to change.

### 4. Shipping LICENSE and THIRD_PARTY_NOTICES.md

- Add `LICENSE` and `THIRD_PARTY_NOTICES.md` to the three ship lists: `release.yml`'s `zip -r app-bundle…`, `stage-sidecars.ps1 $FilesToCopy`, `stage-sidecars.sh for file in`. Staged into `tauri/src-tauri/resources`, so `"resources": ["resources/**/*"]` puts them in both installers (Windows `<install>\resources\`, macOS `Contents/Resources/resources/`), and the update zip delivers them to in-app updaters too.
- `tests/test_release_metadata.py::test_legal_files_ship`: both names are in all three lists, and every listed root file exists in the repo, failing with "THIRD_PARTY_NOTICES.md is in the ship lists but not in the repo. Merge fix/v2-notices first." On this branch that test is red until `fix/v2-notices` lands; the build group merges `origin/fix/v2-notices` in if it has landed by then (`git show origin/fix/v2-notices:THIRD_PARTY_NOTICES.md`). Merge order: notices first, then this PR.
- About's folder list is `GET /api/data-folders` (dubmate/data_folders.py, from `fix/v2-notices`, own computer only). It follows the move through `pack_loader.CACHE_DIR` and adds a row per old folder from `data_home.left_behind`. The first draft of this PR had its own `GET /api/about/paths`; it had no caller and was dropped so the two can't drift apart.

### 5. Release workflow (`release.yml`)

- **Version check:** a release counts as published only when `gh release view v<V> --json isDraft` says `false`. A leftover draft (an installer job failed) means "not released yet": the next run rebuilds and reuses that draft. Only "release not found" counts as new; any other `gh` error stops the run, because guessing "new" would turn a published release back into a draft.
- **bundle job:** `softprops/action-gh-release` with `draft: ${{ steps.check.outputs.is_new == 'true' }}` (a draft for a new version or a leftover draft; a manual rebuild of an already published version stays published, as before, instead of disappearing for the length of the build), `make_latest` `false` for a draft and `legacy` for a rebuild of a published version (so it keeps GitHub's choice of latest during the build), `target_commitish: ${{ github.sha }}`. Its `id` output becomes the job output `release_id`. Same gate as today; `build_only` still skips it.
- **installers job:** `tauri-action` gets `releaseId: ${{ needs.bundle.outputs.release_id }}` and no `tagName` (a draft isn't found by tag, so a tag would make it create a second, public release), and `releaseDraft: true`. With a `releaseId`, tauri-action leaves the release's name and body alone; `releaseBody` still feeds the updater's `latest.json`. The build_only steps are unchanged.
- **Windows generated-template check** (both modes, after the build): the generated `target/release/nsis/x64/installer.nsi` contains the `/KEEPDATA` switch, the upgrade default (`${If} $ReinstallPageCheck = 0`) and the label "Also remove Pack Builder and my DubMate data"; the test checks the same three strings are in `installer.nsi`. This catches Tauri dropping or rewriting the custom template.
- **New `publish` job:** `needs: [bundle, installers]`, `if: needs.installers.result == 'success' && !inputs.build_only && needs.bundle.outputs.release_id != ''`. It checks the release has an `app-bundle-*.zip`, a `*-setup.exe` and a `.dmg`, then `gh release edit v<V> --draft=false --latest`. If either installer job fails, the release stays a draft and the run fails visibly. 1.x apps never see a draft (`/releases/latest` skips drafts).

## Implementation groups (build order)

1. **G1 Engine data home and migration.** `dubmate/data_home.py`, `pack_loader`, `pack_builder`, Python tests.
2. **G2 Launcher paths and migration step.** `paths.rs`, `sidecars.rs`, `packbuilder.rs`, Rust tests.
3. **G3 Installer and uninstaller.** `installer.nsi`, `installer-hooks.nsh`, template tests.
4. **G4 Release workflow and legal files.** `release.yml`, staging scripts, `test_release_metadata.py`.

## Tests

- `tests/test_data_home.py` (pytest, Linux CI):
  - `user_data_root` for a Windows env (`LOCALAPPDATA=C:\Users\a\AppData\Local`, empty `LOCALAPPDATA`), macOS, Linux/XDG, and the `DUBMATE_DATA_DIR` override. Pure-path assertions use `ntpath`/`posixpath` explicitly, not `os.path`.
  - Migration on temp trees shaped like a Windows install (`<inst>/resources`, `<inst>/data`, `<inst>/ai-packages`, `<inst>/packbuilder.optin`) and a macOS bundle (`App.app/Contents/Resources/resources` holding app.py, `Contents/Resources/data`, `Contents/MacOS/ai-packages`):
    - a rename moves everything byte-identically;
    - a forced cross-drive (monkeypatched `os.rename` raising `EXDEV`) copies, verifies, removes the source;
    - `allow_copy=False` leaves the source and logs;
    - a size mismatch or copy error keeps the source, removes `.partial`, and `resolve` then returns the old place;
    - a second run is a no-op;
    - a non-empty target is never merged or overwritten;
    - `include_packbuilder=False` leaves ai-packages;
    - `DUBMATE_CACHE_DIR`/`cache_dir` skip the data move;
    - a source install (no `resources`) never migrates.
- `/api/data-folders` lists old folders last as "Old copy, no longer used" (tests/test_data_folders.py).
- Rust (`cargo test`): `user_data_root_for` for Windows and macOS inputs; the existence rule; `removal_target` under the new root (existing tests rewritten against it); the launcher only runs the migrate step when a legacy item exists.
- `tests/test_installer_template.py`: in `installer.nsi`, the upgrade branch sets the "Do not uninstall" default; the reinstall `ExecWait` passes `/KEEPDATA` and wraps the `ai-packages.keep` rename and restore; the confirm page uses the new label. In `installer-hooks.nsh`, every `RMDir /r` sits inside the checkbox/`UpdateMode`/`KEEPDATA` guard and `$LOCALAPPDATA` is checked non-empty. The optin marker path is the same in NSIS and `paths.rs`.
- `tests/test_release_metadata.py`:
  - the legal files ship;
  - the bundle step creates a draft with `make_latest: false`;
  - tauri-action gets `releaseId`;
  - a `publish` job needs both jobs, is skipped for `build_only`, and is the only step that sets `--draft=false`;
  - the version check reads `isDraft`;
  - the build_only steps are unchanged.

## Risks

- **Cross-drive first start.** The owner's install is on `X:` and `%LOCALAPPDATA%` is on `C:`. The first 2.0 start copies `data` and the ~2 GB Pack Builder to C:, which can take minutes, and reverses the earlier "keep gigabytes off C:" choice (`paths.rs:226-228`). The splash says what is happening. If C: is full, the copy fails, the old place keeps working, and the log says so. Setting `DUBMATE_DATA_DIR` moves the root elsewhere, but that isn't offered in the UI.
- **macOS straight dmg install over 1.x** (no in-app update first) replaces the bundle and its `Contents/Resources/data`. This can't be fixed from 2.0; it needs a release-notes line.
- **Draft + tauri-action:** `releaseId` support must hold for `tauri-action@v0`. Verify on the first real run (no dry run publishes).
- **Default `Packs/` inside `resources`** (packs built without a configured packs folder) is still in the install folder. It isn't moved here (packs are out of scope); the 2.0 uninstaller doesn't list it, so it survives.
- `test_legal_files_ship` is red until `fix/v2-notices` merges.

## Decided without the owner

1. Layout inside the per-user folder mirrors the old install root (`data/`, `ai-packages/`, `packbuilder.optin`), so each move is one rename.
2. Migration runs in the launcher (before the engine, any drive, with a splash line) and, rename-only, in the engine for 1.x launchers that took the in-app update. Pack Builder moves only under a 2.0 launcher.
3. Never merge: if the new folder already has content, the old one is left and logged.
4. `~/.dubmate/cache` (1.x fallback) migrates as `data` only when the install folder has no `data` and it holds `rooms`.
5. The installer shields `ai-packages` from a 1.x uninstaller by renaming it around the call, beyond the brief's "document it".
6. The tick-box also removes `~/.dubmate` (settings, mic sync) and the default export folder inside DubMate's own folder; it never removes packs or a chosen export folder.
7. New uninstaller switch `/KEEPDATA` for the reinstall flow.
8. `DUBMATE_DATA_DIR` is the one override (env only, no UI).
9. A leftover draft counts as unreleased; `publish` checks all three assets before flipping. A manual rebuild of a published version isn't turned into a draft.
10. Merge order: `fix/v2-notices` before this PR.

## Hands-on checks (owner)

1. `build_only` installer over the current X: install, "Do not uninstall" preselected: after first start, `%LOCALAPPDATA%\DubMate\data` has your rooms, `X:\DubMate Studio\data` is gone, old rooms open with takes, Pack Builder opens without downloading, Settings > Export folder shows the new path, and the splash showed "Moving your DubMate files…".
2. Same, but pick "Uninstall before installing": Pack Builder is still there afterwards.
3. Uninstall from Windows Settings, box unticked: `%LOCALAPPDATA%\DubMate` remains. Reinstall: everything is back. Uninstall with the box ticked: it is gone, `Documents\DubMate\Packs` remains.
4. Fill C: or make `%LOCALAPPDATA%\DubMate` read-only, then start: DubMate starts on the old folder, and the log says why.
5. macOS: in-app update from 1.x, then the dmg. Rooms survive in `~/Library/Application Support/DubMate`.
6. `C:\…\DubMate Studio\resources\LICENSE` and `THIRD_PARTY_NOTICES.md` exist; About panel paths match reality.
7. First real release: the draft appears, then turns public with `.exe`, `.dmg` and the zip; 1.x apps are offered the update only after that.
