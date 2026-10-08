# -*- coding: utf-8 -*-
"""
dubmate/data_home.py
Where DubMate keeps this computer's data, and the one-time move out of the install folder.

The desktop app (1.x) kept rooms, takes, saved videos and caches (`data`), the Pack Builder
add-on (`ai-packages`) and the installer's Pack Builder choice (`packbuilder.optin`) inside
the folder it was installed to, so a reinstall or uninstall could delete them. 2.0 keeps
them in a per-user folder with the same names inside:

  Windows   %LOCALAPPDATA%\\DubMate
  macOS     ~/Library/Application Support/DubMate
  other     $XDG_DATA_HOME/DubMate, else ~/.local/share/DubMate

DUBMATE_DATA_DIR overrides it. Source installs keep <repo>/data and never migrate.
The launcher (tauri/src-tauri/src/paths.rs) follows the same rules.

Stdlib only and no project imports: pack_loader imports this before CACHE_DIR exists.
See documentation/design/v2-installer.md, sections 1 and 2.
"""

import argparse
import errno
import json
import ntpath
import os
import posixpath
import shutil
import sys

APP_FOLDER = "DubMate"
ITEMS = ("data", "ai-packages", "packbuilder.optin")
PACK_BUILDER_ITEMS = ("ai-packages", "packbuilder.optin")
INSTALL_COMPLETE = ".install-complete"

# The folder holding app.py: <install root>/resources in the desktop app, the repo otherwise.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def user_data_root(platform=None, env=None, home=None) -> str:
    """The per-user DubMate folder. Pure: builds Windows paths with ntpath and the rest
    with posixpath, so any platform's answer can be checked on any computer."""
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    home = os.path.expanduser("~") if home is None else home
    override = (env.get("DUBMATE_DATA_DIR") or "").strip()
    if override:
        return override
    if platform == "win32":
        base = (env.get("LOCALAPPDATA") or "").strip() or ntpath.join(home, "AppData", "Local")
        return ntpath.join(base, APP_FOLDER)
    if platform == "darwin":
        return posixpath.join(home, "Library", "Application Support", APP_FOLDER)
    base = (env.get("XDG_DATA_HOME") or "").strip() or posixpath.join(home, ".local", "share")
    return posixpath.join(base, APP_FOLDER)


def is_packaged(base_dir: str = BASE_DIR) -> bool:
    """True in the desktop app, which stages the Python files into a 'resources' folder."""
    return os.path.basename(os.path.normpath(base_dir)).lower() == "resources"


def install_root(base_dir: str = BASE_DIR) -> str:
    """The folder the user installed to: one level above 'resources' in the desktop app."""
    return os.path.dirname(os.path.normpath(base_dir)) if is_packaged(base_dir) else base_dir


def data_root(base_dir: str = BASE_DIR, env=None, home=None) -> str:
    """The per-user folder in the desktop app (or when DUBMATE_DATA_DIR is set); the repo
    for a source install, which keeps its data where it always has."""
    env = os.environ if env is None else env
    if (env.get("DUBMATE_DATA_DIR") or "").strip() or is_packaged(base_dir):
        return user_data_root(env=env, home=home)
    return base_dir


def config_value(key: str, home=None):
    """One string setting from ~/.dubmate/config.json, read without pack_loader."""
    home = os.path.expanduser("~") if home is None else home
    try:
        with open(os.path.join(home, ".dubmate", "config.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    except (OSError, ValueError):
        pass
    return None


def _exe_dir(root: str) -> str:
    """The launcher's folder: the install root on Windows, Contents/MacOS in a macOS app."""
    for path in (root, os.path.dirname(root)):
        if os.path.basename(path) == "Contents":
            return os.path.join(path, "MacOS")
    return root


def legacy_locations(install_dir: str, base_dir: str, exe_dir=None, home=None) -> dict:
    """Where 1.x kept each item, most likely first. The 1.x fallback cache (~/.dubmate/cache,
    used when the install folder wasn't writable) counts only when it holds rooms."""
    home = os.path.expanduser("~") if home is None else home
    places = []
    for p in (exe_dir or _exe_dir(install_dir), install_dir, base_dir):
        if p not in places:
            places.append(p)
    data = [os.path.join(install_dir, "data")]
    fallback = os.path.join(home, ".dubmate", "cache")
    if os.path.isdir(os.path.join(fallback, "rooms")):
        data.append(fallback)
    return {
        "data": data,
        "ai-packages": [os.path.join(p, "ai-packages") for p in places],
        "packbuilder.optin": [os.path.join(p, "packbuilder.optin") for p in places],
    }


def _legacy(item, base_dir, home):
    """The old place resolve() would fall back to, or None."""
    for old in legacy_locations(install_root(base_dir), base_dir, home=home)[item]:
        if os.path.exists(old):
            return old
    return None


def resolve(item: str, *, base_dir: str = BASE_DIR, root=None, env=None, home=None) -> str:
    """Where `item` lives: the new place unless it is missing and an old place has it.
    A failed move therefore keeps the old place, a finished one uses the new place."""
    new = os.path.join(root or data_root(base_dir, env, home), item)
    if os.path.exists(new):
        return new
    return _legacy(item, base_dir, home) or new


def _log(message: str) -> None:
    print(f"[DubMate data] {message}", flush=True)


def _has_content(path: str) -> bool:
    if os.path.isdir(path):
        return bool(os.listdir(path))
    return os.path.exists(path)


def _inside(path: str, folder: str) -> bool:
    path, folder = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(folder))
    try:
        return os.path.commonpath([path, folder]) == folder
    except ValueError:  # different drives
        return False


def _keep_data_reason(old: str, env, home):
    """Why data stays where it is, or None. The user chose a cache folder (then there is
    nothing to move), or a folder they chose sits inside the old one."""
    if (env.get("DUBMATE_CACHE_DIR") or "").strip() or config_value("cache_dir", home):
        return ""
    chosen = {"exports_dir": "your export folder", "packs_dir": "your packs folder"}
    for key, name in chosen.items():
        value = config_value(key, home)
        if value and _inside(value, old):
            return f"{name} is inside it"
    return None


def _is_cross_drive(ex: OSError) -> bool:
    return getattr(ex, "winerror", None) == 17 or ex.errno == errno.EXDEV


def _sizes(path: str) -> dict:
    """{relative path: byte size} for every file under path (or the file itself)."""
    if os.path.isfile(path):
        return {".": os.path.getsize(path)}
    out = {}
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            full = os.path.join(dirpath, name)
            out[os.path.relpath(full, path)] = os.path.getsize(full)
    return out


def _remove(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.remove(path)


def _move(item, old, new, allow_copy, log) -> dict:
    """Rename old to new; across drives, copy, verify, rename into place, then remove old."""
    partial = new + ".partial"
    copied = False
    try:
        os.makedirs(os.path.dirname(new), exist_ok=True)
        if os.path.isdir(new):
            os.rmdir(new)  # empty: _has_content() said so
        try:
            os.rename(old, new)
        except OSError as ex:
            if not _is_cross_drive(ex):
                raise
            if not allow_copy:
                raise OSError("it's on another drive") from ex
            _remove(partial)  # only ever our own copy from an earlier attempt
            if os.path.isdir(old):
                shutil.copytree(old, partial, copy_function=shutil.copy2)
            else:
                shutil.copy2(old, partial)
            if _sizes(partial) != _sizes(old):
                raise OSError("the copy didn't match the original")
            os.rename(partial, new)
            copied = True
    except Exception as ex:
        try:
            _remove(partial)
        except OSError:
            pass
        reason = getattr(ex, "strerror", None) or str(ex) or type(ex).__name__
        log(f"Could not move {item} to {new}: {reason}. DubMate keeps using {old}.")
        return {"item": item, "status": "failed", "from": old, "to": new, "reason": reason}

    if copied:
        try:
            _remove(old)
        except OSError as ex:
            log(f"Copied {item} to {new}, but couldn't remove {old}: {ex.strerror or ex}. DubMate uses {new}.")
    log(f"Moved {item} from {old} to {new}.")
    return {"item": item, "status": "copied" if copied else "moved", "from": old, "to": new}


def migrate(allow_copy: bool, include_packbuilder: bool, log=_log, *, base_dir: str = BASE_DIR,
            root=None, env=None, home=None) -> list:
    """
    Moves what 1.x kept in the install folder to the per-user folder, once. Never merges,
    never overwrites, never deletes a source that wasn't verified as copied; whatever fails
    stays where it was and keeps working (resolve() falls back to it). Idempotent.

    allow_copy: copy across drives (the launcher, engine stopped). The engine at import
    only renames. include_packbuilder: also move ai-packages and packbuilder.optin, which
    only a 2.0 launcher finds in the new place.
    """
    env = os.environ if env is None else env
    if not is_packaged(base_dir):
        return []
    root = root or user_data_root(env=env, home=home)
    results = []
    for item in ITEMS:
        if item in PACK_BUILDER_ITEMS and not include_packbuilder:
            continue
        old = _legacy(item, base_dir, home)
        if old is None:
            continue
        new = os.path.join(root, item)
        if item == "data":
            reason = _keep_data_reason(old, env, home)
            if reason is not None:
                if reason:
                    log(f"Could not move {item} to {new}: {reason}. DubMate keeps using {old}.")
                results.append({"item": item, "status": "kept", "from": old, "to": new})
                continue
        if _has_content(new):
            log(f"Old {item} folder left at {old}; DubMate uses {new}")
            results.append({"item": item, "status": "left", "from": old, "to": new})
            continue
        results.append(_move(item, old, new, allow_copy, log))
    return results


def locations() -> dict:
    """Where this computer's DubMate data lives, for the About panel."""
    import pack_loader  # lazy: pack_loader imports this module

    ai_dir = resolve("ai-packages")
    left_behind = []
    if is_packaged():
        for item, paths in legacy_locations(install_root(), BASE_DIR).items():
            in_use = (resolve(item), pack_loader.CACHE_DIR)
            left_behind += [p for p in paths if os.path.exists(p) and p not in in_use]
    return {
        "root": data_root(),
        "data_dir": pack_loader.CACHE_DIR,
        "rooms_dir": os.path.join(pack_loader.CACHE_DIR, "rooms"),
        "exports_dir": pack_loader.get_exports_dir(),
        "ai_packages_dir": ai_dir,
        "ai_packages_installed": os.path.isfile(os.path.join(ai_dir, INSTALL_COMPLETE)),
        "config_file": pack_loader.get_config_path(),
        "packs_dirs": [os.path.abspath(d) for d in pack_loader.PACKS_DIRS if os.path.isdir(d)],
        "packaged": is_packaged(),
        "left_behind": left_behind,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dubmate.data_home",
                                     description="Move DubMate's data out of the install folder.")
    parser.add_argument("--migrate", action="store_true", help="move what 1.x kept in the install folder")
    parser.add_argument("--copy", action="store_true", help="copy across drives when a rename can't")
    parser.add_argument("--packbuilder", action="store_true", help="also move Pack Builder")
    args = parser.parse_args(argv)
    if not args.migrate:
        parser.print_help()
        return 0
    migrate(args.copy, args.packbuilder)
    return 0


if __name__ == "__main__":
    sys.exit(main())
