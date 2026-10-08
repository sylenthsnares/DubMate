# -*- coding: utf-8 -*-
"""
test_data_home.py
The 2.0 desktop app keeps rooms, takes, saved videos, caches and Pack Builder in a
per-user folder instead of the install folder, so no install, reinstall or uninstall
touches them (documentation/design/v2-installer.md, sections 1, 2 and 4).

Covers dubmate/data_home.py (where the folder is, the existence rule, the one-time
move), pack_loader.get_cache_dir(), pack_builder.ensure_ai_packages_on_path() and
GET /api/about/paths. Every path test builds Windows-style and macOS-style install
trees in a temp dir, so it runs the same on Linux CI.
"""

import errno
import json
import ntpath
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_TESTS_DIR)
sys.path.insert(0, _ROOT)

from dubmate import data_home

TAKE = b"RIFF" + bytes(range(256)) * 40
TORCH = b"# torch\n" * 500


def snapshot(path):
    """{relative path: bytes} for every file under path (or the file itself)."""
    if os.path.isfile(path):
        with open(path, "rb") as f:
            return {".": f.read()}
    out = {}
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            full = os.path.join(dirpath, name)
            with open(full, "rb") as f:
                out[os.path.relpath(full, path).replace(os.sep, "/")] = f.read()
    return out


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def fill_legacy(data, ai_packages, optin):
    write(os.path.join(data, "rooms", "ABCD", "takes", "line_001.wav"), TAKE)
    write(os.path.join(data, "rooms", "ABCD", "room.json"), b'{"pack_id": "p"}')
    write(os.path.join(data, "exports", "My dub.mp4"), b"mp4" * 300)
    write(os.path.join(data, "pack_index.json"), b"{}")
    write(os.path.join(ai_packages, "torch", "__init__.py"), TORCH)
    write(os.path.join(ai_packages, ".install-complete"), b"ok")
    write(optin, b"1")


def windows_layout(tmp):
    """X:\\DubMate Studio\\{resources, data, ai-packages, packbuilder.optin} as 1.x left it."""
    inst = os.path.join(tmp, "DubMate Studio")
    base = os.path.join(inst, "resources")
    os.makedirs(base)
    old = {
        "data": os.path.join(inst, "data"),
        "ai-packages": os.path.join(inst, "ai-packages"),
        "packbuilder.optin": os.path.join(inst, "packbuilder.optin"),
    }
    fill_legacy(old["data"], old["ai-packages"], old["packbuilder.optin"])
    return base, old


def macos_layout(tmp):
    """DubMate Studio.app/Contents/{Resources, data, MacOS/ai-packages, MacOS/packbuilder.optin}."""
    contents = os.path.join(tmp, "DubMate Studio.app", "Contents")
    base = os.path.join(contents, "Resources")
    os.makedirs(base)
    old = {
        "data": os.path.join(contents, "data"),
        "ai-packages": os.path.join(contents, "MacOS", "ai-packages"),
        "packbuilder.optin": os.path.join(contents, "MacOS", "packbuilder.optin"),
    }
    fill_legacy(old["data"], old["ai-packages"], old["packbuilder.optin"])
    return base, old


LAYOUTS = (("windows", windows_layout), ("macos", macos_layout))


class TestUserDataRoot(unittest.TestCase):
    """Where the per-user folder is, from the platform, the environment and home alone."""

    def test_windows_uses_localappdata(self):
        env = {"LOCALAPPDATA": r"C:\Users\a\AppData\Local"}
        self.assertEqual(data_home.user_data_root("win32", env, r"C:\Users\a"),
                         ntpath.join(r"C:\Users\a\AppData\Local", "DubMate"))

    def test_windows_empty_localappdata_falls_back_to_home(self):
        for env in ({"LOCALAPPDATA": ""}, {"LOCALAPPDATA": "  "}, {}):
            self.assertEqual(data_home.user_data_root("win32", env, r"C:\Users\a"),
                             r"C:\Users\a\AppData\Local\DubMate", env)

    def test_macos_uses_application_support(self):
        self.assertEqual(data_home.user_data_root("darwin", {}, "/Users/a"),
                         posixpath.join("/Users/a", "Library", "Application Support", "DubMate"))

    def test_linux_uses_xdg_then_local_share(self):
        self.assertEqual(data_home.user_data_root("linux", {"XDG_DATA_HOME": "/x/share"}, "/home/a"),
                         "/x/share/DubMate")
        self.assertEqual(data_home.user_data_root("linux", {}, "/home/a"), "/home/a/.local/share/DubMate")

    def test_override_wins_everywhere(self):
        for platform in ("win32", "darwin", "linux"):
            env = {"DUBMATE_DATA_DIR": "/elsewhere/DM", "LOCALAPPDATA": r"C:\L", "XDG_DATA_HOME": "/x"}
            self.assertEqual(data_home.user_data_root(platform, env, "/home/a"), "/elsewhere/DM", platform)

    def test_is_packaged_follows_the_resources_folder(self):
        self.assertTrue(data_home.is_packaged(os.path.join("inst", "resources")))
        self.assertTrue(data_home.is_packaged(os.path.join("App.app", "Contents", "Resources")))
        self.assertFalse(data_home.is_packaged(os.path.join("src", "DubMate")))


class MigrationCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dm_data_home_")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.root = os.path.join(self.tmp, "LocalAppData", "DubMate")
        self.env = {}
        self.logs = []

    def migrate(self, base, allow_copy=True, include_packbuilder=True):
        return data_home.migrate(allow_copy, include_packbuilder, log=self.logs.append, base_dir=base,
                                 root=self.root, env=self.env, home=self.home)

    def resolve(self, item, base):
        return data_home.resolve(item, base_dir=base, root=self.root, env=self.env, home=self.home)

    def new(self, item):
        return os.path.join(self.root, item)

    def assert_moved(self, old, before):
        for item, path in old.items():
            self.assertFalse(os.path.exists(path), f"{item} still at the old place")
            self.assertEqual(snapshot(self.new(item)), before[item], item)
        self.assertEqual([n for n in os.listdir(self.root) if n.endswith(".partial")], [])

    def assert_kept(self, item, old, before, base):
        self.assertEqual(snapshot(old[item]), before[item], f"{item} source changed")
        self.assertFalse(os.path.exists(self.new(item)), f"{item} half-moved")
        self.assertFalse(os.path.exists(self.new(item) + ".partial"), f"{item} .partial left")
        self.assertEqual(self.resolve(item, base), old[item])


class TestMigration(MigrationCase):
    def test_rename_moves_everything_byte_identically(self):
        for name, layout in LAYOUTS:
            with self.subTest(name):
                self.setUp()
                base, old = layout(self.tmp)
                before = {k: snapshot(v) for k, v in old.items()}
                for item, path in old.items():
                    self.assertEqual(self.resolve(item, base), path, f"{item} before the move")
                self.migrate(base, allow_copy=False)
                self.assert_moved(old, before)
                for item in old:
                    self.assertEqual(self.resolve(item, base), self.new(item))
                self.assertFalse(any("Could not move" in line for line in self.logs), self.logs)

    def test_cross_drive_copies_verifies_then_removes_source(self):
        real_rename = os.rename

        def cross_drive(src, dst):
            if str(src).endswith(".partial"):
                return real_rename(src, dst)
            raise OSError(errno.EXDEV, "Invalid cross-device link")

        for name, layout in LAYOUTS:
            with self.subTest(name):
                self.setUp()
                base, old = layout(self.tmp)
                before = {k: snapshot(v) for k, v in old.items()}
                with mock.patch.object(data_home.os, "rename", side_effect=cross_drive):
                    self.migrate(base, allow_copy=True)
                self.assert_moved(old, before)

    def test_windows_not_same_device_error_counts_as_cross_drive(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        real_rename = os.rename
        err = OSError(errno.EACCES, "The system cannot move the file to a different disk drive")
        err.winerror = 17

        def cross_drive(src, dst):
            if str(src).endswith(".partial"):
                return real_rename(src, dst)
            raise err

        with mock.patch.object(data_home.os, "rename", side_effect=cross_drive):
            self.migrate(base, allow_copy=True)
        self.assert_moved(old, before)

    def test_cross_drive_without_copy_keeps_the_old_place_and_says_so(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        with mock.patch.object(data_home.os, "rename", side_effect=OSError(errno.EXDEV, "cross-device")):
            self.migrate(base, allow_copy=False)
        for item in old:
            self.assert_kept(item, old, before, base)
        line = next(l for l in self.logs if l.startswith("Could not move data"))
        self.assertIn(self.new("data"), line)
        self.assertTrue(line.endswith(f"DubMate keeps using {old['data']}."), line)

    def test_size_mismatch_keeps_the_source_and_removes_partial(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        real_copy2 = shutil.copy2

        def short_copy(src, dst, *a, **kw):
            result = real_copy2(src, dst, *a, **kw)
            if os.path.basename(src) == "line_001.wav":
                with open(dst, "r+b") as f:
                    f.truncate(10)
            return result

        with mock.patch.object(data_home.os, "rename", side_effect=self._exdev_unless_partial()), \
                mock.patch.object(data_home.shutil, "copy2", side_effect=short_copy):
            self.migrate(base, allow_copy=True, include_packbuilder=False)
        self.assert_kept("data", old, before, base)
        self.assertTrue(any(l.startswith(f"Could not move data to {self.new('data')}: ") for l in self.logs), self.logs)

    def test_copy_error_keeps_the_source_and_removes_partial(self):
        base, old = macos_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        real_copy2 = shutil.copy2

        def disk_full(src, dst, *a, **kw):
            if os.path.basename(src) == "__init__.py":
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_copy2(src, dst, *a, **kw)

        with mock.patch.object(data_home.os, "rename", side_effect=self._exdev_unless_partial()), \
                mock.patch.object(data_home.shutil, "copy2", side_effect=disk_full):
            self.migrate(base, allow_copy=True)
        self.assert_kept("ai-packages", old, before, base)
        self.assertEqual(snapshot(self.new("data")), before["data"])
        self.assertTrue(any("Could not move ai-packages" in l and "keeps using" in l for l in self.logs), self.logs)

    def test_a_partial_from_an_earlier_attempt_is_replaced(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        write(os.path.join(self.new("data") + ".partial", "rooms", "half.wav"), b"x")
        with mock.patch.object(data_home.os, "rename", side_effect=self._exdev_unless_partial()):
            self.migrate(base, allow_copy=True)
        self.assert_moved(old, before)

    def test_second_run_is_a_no_op(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        self.migrate(base)
        self.logs.clear()
        self.migrate(base)
        self.assert_moved(old, before)
        self.assertEqual(self.logs, [])

    def test_never_merges_into_a_folder_that_has_content(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        write(os.path.join(self.new("data"), "rooms", "WXYZ", "room.json"), b"{}")
        newer = snapshot(self.new("data"))
        self.migrate(base, include_packbuilder=False)
        self.assertEqual(snapshot(old["data"]), before["data"])
        self.assertEqual(snapshot(self.new("data")), newer)
        self.assertEqual(self.resolve("data", base), self.new("data"))
        self.assertIn(f"Old data folder left at {old['data']}; DubMate uses {self.new('data')}", self.logs)

    def test_an_empty_new_folder_is_filled(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        os.makedirs(self.new("data"))
        self.migrate(base)
        self.assert_moved(old, before)

    def test_pack_builder_stays_unless_included(self):
        for name, layout in LAYOUTS:
            with self.subTest(name):
                self.setUp()
                base, old = layout(self.tmp)
                before = {k: snapshot(v) for k, v in old.items()}
                self.migrate(base, include_packbuilder=False)
                self.assertEqual(snapshot(self.new("data")), before["data"])
                for item in ("ai-packages", "packbuilder.optin"):
                    self.assert_kept(item, old, before, base)

    def test_a_chosen_cache_folder_is_never_migrated(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        self.env = {"DUBMATE_CACHE_DIR": os.path.join(self.tmp, "mine")}
        self.migrate(base, include_packbuilder=False)
        self.assert_kept("data", old, before, base)

        self.env = {}
        write(os.path.join(self.home, ".dubmate", "config.json"),
              json.dumps({"cache_dir": os.path.join(self.tmp, "mine")}).encode())
        self.migrate(base, include_packbuilder=False)
        self.assert_kept("data", old, before, base)

    def test_a_configured_folder_inside_the_old_data_is_not_moved(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        write(os.path.join(self.home, ".dubmate", "config.json"),
              json.dumps({"exports_dir": os.path.join(old["data"], "exports")}).encode())
        self.migrate(base, include_packbuilder=False)
        self.assert_kept("data", old, before, base)

    def test_source_install_never_migrates(self):
        repo = os.path.join(self.tmp, "DubMate")
        os.makedirs(repo)
        old = {
            "data": os.path.join(repo, "data"),
            "ai-packages": os.path.join(repo, "ai-packages"),
            "packbuilder.optin": os.path.join(repo, "packbuilder.optin"),
        }
        fill_legacy(old["data"], old["ai-packages"], old["packbuilder.optin"])
        before = {k: snapshot(v) for k, v in old.items()}
        self.assertEqual(self.migrate(repo), [])
        self.assertFalse(os.path.exists(self.root))
        for item, path in old.items():
            self.assertEqual(snapshot(path), before[item])

    def test_old_fallback_cache_moves_only_when_it_holds_rooms(self):
        inst = os.path.join(self.tmp, "Program Files", "DubMate Studio")
        base = os.path.join(inst, "resources")
        os.makedirs(base)
        fallback = os.path.join(self.home, ".dubmate", "cache")
        write(os.path.join(fallback, "pack_index.json"), b"{}")
        self.migrate(base, include_packbuilder=False)
        self.assertFalse(os.path.exists(self.new("data")))
        self.assertTrue(os.path.isdir(fallback))

        write(os.path.join(fallback, "rooms", "ABCD", "room.json"), b"{}")
        before = snapshot(fallback)
        self.migrate(base, include_packbuilder=False)
        self.assertEqual(snapshot(self.new("data")), before)
        self.assertFalse(os.path.exists(fallback))

    def test_resolve_prefers_the_new_place(self):
        base, old = windows_layout(self.tmp)
        os.makedirs(self.new("ai-packages"))
        self.assertEqual(self.resolve("ai-packages", base), self.new("ai-packages"))
        self.assertEqual(self.resolve("data", base), old["data"])
        shutil.rmtree(old["data"])
        self.assertEqual(self.resolve("data", base), self.new("data"))

    def test_command_line_moves_with_copy_and_pack_builder(self):
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        script = os.path.join(base, "dubmate")
        shutil.copytree(os.path.join(_ROOT, "dubmate"), script,
                        ignore=shutil.ignore_patterns("__pycache__"))
        env = {k: v for k, v in os.environ.items() if k != "DUBMATE_CACHE_DIR"}
        env.update(DUBMATE_DATA_DIR=self.root, HOME=self.home, USERPROFILE=self.home)
        res = subprocess.run([sys.executable, "-m", "dubmate.data_home", "--migrate", "--copy", "--packbuilder"],
                             cwd=base, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        self.assert_moved(old, before)

    @staticmethod
    def _exdev_unless_partial():
        real_rename = os.rename

        def rename(src, dst):
            if str(src).endswith(".partial"):
                return real_rename(src, dst)
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return rename


class TestEngineUsesTheDataHome(MigrationCase):
    def test_packaged_engine_moves_data_at_import_and_uses_it(self):
        """A 1.x launcher that took the in-app update: pack_loader moves data (rename only)
        before CACHE_DIR is chosen, and leaves Pack Builder where the old launcher looks."""
        base, old = windows_layout(self.tmp)
        before = {k: snapshot(v) for k, v in old.items()}
        shutil.copy2(os.path.join(_ROOT, "pack_loader.py"), base)
        shutil.copytree(os.path.join(_ROOT, "dubmate"), os.path.join(base, "dubmate"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        env = {k: v for k, v in os.environ.items() if k != "DUBMATE_CACHE_DIR"}
        env.update(DUBMATE_DATA_DIR=self.root, HOME=self.home, USERPROFILE=self.home)
        res = subprocess.run([sys.executable, "-c", "import pack_loader; print(pack_loader.CACHE_DIR)"],
                             cwd=base, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr + res.stdout)
        self.assertEqual(os.path.normcase(res.stdout.strip().splitlines()[-1]),
                         os.path.normcase(self.new("data")))
        self.assertEqual(snapshot(self.new("data")), before["data"])
        self.assertFalse(os.path.exists(old["data"]))
        for item in ("ai-packages", "packbuilder.optin"):
            self.assertEqual(snapshot(old[item]), before[item])

    def test_get_cache_dir_order(self):
        import pack_loader
        base, old = windows_layout(self.tmp)
        env = {"DUBMATE_DATA_DIR": self.root}
        with mock.patch.dict(os.environ, env), mock.patch.object(pack_loader, "BASE_DIR", base):
            os.environ.pop("DUBMATE_CACHE_DIR", None)
            with mock.patch.object(pack_loader, "_config_value", return_value=None):
                # Packaged, not moved yet: the old place.
                self.assertEqual(pack_loader.get_cache_dir(), old["data"])
                shutil.rmtree(old["data"])
                self.assertEqual(pack_loader.get_cache_dir(), self.new("data"))
            mine = os.path.join(self.tmp, "mine")
            with mock.patch.object(pack_loader, "_config_value",
                                   side_effect=lambda k: mine if k == "cache_dir" else None):
                self.assertEqual(pack_loader.get_cache_dir(), mine)
            os.environ["DUBMATE_CACHE_DIR"] = os.path.join(self.tmp, "env")
            self.assertEqual(pack_loader.get_cache_dir(), os.path.join(self.tmp, "env"))

    def test_source_install_keeps_its_data_folder(self):
        import pack_loader
        repo = os.path.join(self.tmp, "DubMate")
        os.makedirs(repo)
        with mock.patch.dict(os.environ, {"DUBMATE_DATA_DIR": self.root}), \
                mock.patch.object(pack_loader, "BASE_DIR", repo), \
                mock.patch.object(pack_loader, "_config_value", return_value=None):
            os.environ.pop("DUBMATE_CACHE_DIR", None)
            self.assertEqual(pack_loader.get_cache_dir(), os.path.join(repo, "data"))
        self.assertFalse(os.path.exists(self.root))

    def test_pack_builder_finds_the_new_place_first(self):
        import pack_builder
        new_ai = self.new("ai-packages")
        old_ai = os.path.join(self.tmp, "inst", "ai-packages")
        os.makedirs(new_ai)
        os.makedirs(old_ai)
        saved = list(sys.path)
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), saved))
        with mock.patch.object(pack_builder.data_home, "resolve", return_value=new_ai), \
                mock.patch.object(pack_builder.pack_loader, "get_install_root",
                                  return_value=os.path.dirname(old_ai)):
            pack_builder.ensure_ai_packages_on_path()
        self.assertEqual(sys.path[0], new_ai)
        self.assertIn(old_ai, sys.path)


ABOUT_KEYS = {"status", "root", "data_dir", "rooms_dir", "exports_dir", "ai_packages_dir",
              "ai_packages_installed", "config_file", "packs_dirs", "install_dir", "packaged",
              "left_behind", "licence_files"}


class TestAboutPaths(unittest.TestCase):
    """GET /api/about/paths: real folders for the About panel, on the host's computer only."""

    @classmethod
    def setUpClass(cls):
        from starlette.testclient import TestClient
        import app
        cls.app = app.app
        cls.TestClient = TestClient

    def test_own_computer_gets_the_contract(self):
        import pack_loader
        res = self.TestClient(self.app, base_url="http://127.0.0.1:8000").get("/api/about/paths")
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        self.assertEqual(set(data), ABOUT_KEYS)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["data_dir"], pack_loader.CACHE_DIR)
        self.assertEqual(data["rooms_dir"], os.path.join(pack_loader.CACHE_DIR, "rooms"))
        self.assertEqual(data["install_dir"], pack_loader.get_install_root())
        self.assertFalse(data["packaged"])
        self.assertIsInstance(data["packs_dirs"], list)
        self.assertIsInstance(data["left_behind"], list)
        self.assertIsInstance(data["ai_packages_installed"], bool)
        self.assertIn(os.path.join(_ROOT, "LICENSE"), data["licence_files"])
        for path in data["licence_files"]:
            self.assertTrue(os.path.isfile(path), path)

    def test_lan_and_tunnel_callers_are_refused(self):
        lan = self.TestClient(self.app, base_url="http://192.168.1.5:8000")
        self.assertEqual(lan.get("/api/about/paths").status_code, 403)
        local = self.TestClient(self.app, base_url="http://127.0.0.1:8000")
        for header in ({"Cf-Ray": "abc123-LHR"}, {"Cf-Connecting-Ip": "1.2.3.4"},
                       {"Origin": "https://evil.example"}):
            res = local.get("/api/about/paths", headers=header)
            self.assertEqual(res.status_code, 403, header)
            self.assertNotIn("data_dir", res.text)


if __name__ == "__main__":
    unittest.main()
