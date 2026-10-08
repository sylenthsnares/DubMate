# -*- coding: utf-8 -*-
"""
test_data_folders.py
About's "Where your data lives": GET /api/data-folders lists the real folders DubMate uses,
and POST /api/data-folders/open opens one in the file manager. Both are for the engine's own
computer only; open resolves the folder by key and never takes a path from the request.
Each folder says whether it is DubMate's own (own: True) or one that may hold other files
(a folder the user chose), so About only tells you to delete DubMate's own. Listing creates
nothing.
"""

import os
import sys
import shutil
import tempfile
import unittest
from unittest import mock

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_TESTS_DIR))

from fastapi.testclient import TestClient

import pack_builder
import pack_loader
from app import app
from dubmate import common, data_folders


class DataFoldersCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dm_folders_")
        self.packs_a = os.path.join(self.tmp, "PacksA")
        self.packs_b = os.path.join(self.tmp, "PacksB")
        self.exports = os.path.join(self.tmp, "exports")
        for d in (self.packs_a, self.packs_b, self.exports):
            os.makedirs(d)
        self.data = os.path.join(self.tmp, "data")
        os.makedirs(os.path.join(self.data, "rooms"))
        patches = [
            mock.patch.object(pack_loader, "CACHE_DIR", self.data),
            mock.patch.object(pack_loader, "PACKS_DIRS", [self.packs_a, self.packs_b]),
            mock.patch.dict(os.environ, {"DUBMATE_EXPORTS_DIR": self.exports}),
            mock.patch.object(pack_builder, "_addon_dir", return_value=None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        popen = mock.patch("dubmate.data_folders.subprocess.Popen")
        self.popen = popen.start()
        self.addCleanup(popen.stop)
        self.local = TestClient(app, base_url="http://127.0.0.1:8000")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _open(self, client, status, headers=None, **body):
        res = client.post("/api/data-folders/open", json=body, headers=headers or {})
        self.assertEqual(res.status_code, status, res.text)
        return res

    def _opened_dir(self):
        self.popen.assert_called_once()
        return os.path.normpath(self.popen.call_args.args[0][-1])


class TestListFolders(DataFoldersCase):

    def test_lists_the_keys_in_order_with_real_paths(self):
        res = self.local.get("/api/data-folders")
        self.assertEqual(res.status_code, 200, res.text)
        folders = res.json()["folders"]
        self.assertEqual([f["key"] for f in folders],
                         ["rooms", "exports", "packs", "packs-2", "settings", "data"])
        paths = {f["key"]: f["path"] for f in folders}
        n = os.path.normpath
        self.assertEqual(paths["rooms"], n(os.path.join(self.data, "rooms")))
        self.assertEqual(paths["exports"], n(self.exports))
        self.assertEqual(paths["packs"], n(self.packs_a))
        self.assertEqual(paths["packs-2"], n(self.packs_b))
        self.assertEqual(paths["settings"], n(os.path.dirname(pack_loader.get_config_path())))
        self.assertEqual(paths["data"], n(self.data))
        labels = {f["key"]: f["label"] for f in folders}
        self.assertEqual(labels["rooms"], "Rooms and takes")
        self.assertEqual(labels["exports"], "Saved videos")
        self.assertEqual(labels["packs"], "Your packs folder")
        self.assertEqual(labels["packs-2"], "Your packs folder")
        self.assertEqual(labels["data"], "All DubMate data")
        self.assertTrue(all(f["exists"] for f in folders))

    def test_folders_you_chose_are_not_dubmates_own(self):
        """A chosen Export or Packs folder may be Videos or Downloads: never DubMate's to delete."""
        own = {f["key"]: f["own"] for f in self.local.get("/api/data-folders").json()["folders"]}
        self.assertEqual(own, {"rooms": True, "exports": False, "packs": False, "packs-2": False,
                               "settings": True, "data": True})

    def test_the_default_export_and_packs_folders_are_dubmates_own(self):
        default_packs = pack_loader.get_default_packs_dir()
        with mock.patch.dict(os.environ, {"DUBMATE_EXPORTS_DIR": ""}), \
                mock.patch.object(pack_loader, "_config_value", return_value=None), \
                mock.patch.object(pack_loader, "PACKS_DIRS", [self.packs_a, default_packs]):
            folders = {f["key"]: f for f in self.local.get("/api/data-folders").json()["folders"]}
        self.assertEqual(folders["exports"]["path"], os.path.normpath(os.path.join(self.data, "exports")))
        self.assertTrue(folders["exports"]["own"])
        self.assertEqual((folders["packs"]["label"], folders["packs"]["own"]), ("Your packs folder", False))
        self.assertEqual((folders["packs-2"]["label"], folders["packs-2"]["own"]), ("Scene packs", True))

    def test_settings_in_the_install_folder_are_not_dubmates_own(self):
        """When ~/.dubmate can't be made, settings sit in the install folder: not one to delete."""
        fallback = os.path.join(pack_loader.BASE_DIR, "dubmate_config.json")
        with mock.patch.object(pack_loader, "get_config_path", return_value=fallback):
            folders = {f["key"]: f for f in self.local.get("/api/data-folders").json()["folders"]}
        self.assertEqual(folders["settings"]["path"], os.path.normpath(pack_loader.BASE_DIR))
        self.assertFalse(folders["settings"]["own"])

    def test_listing_creates_no_folder(self):
        """'Not created yet' has to stay true: reading the list makes no folder."""
        with mock.patch.dict(os.environ, {"DUBMATE_EXPORTS_DIR": ""}), \
                mock.patch("dubmate.common._exports_dir", None), \
                mock.patch.object(pack_loader, "_config_value", return_value=None):
            folders = {f["key"]: f for f in self.local.get("/api/data-folders").json()["folders"]}
        self.assertFalse(folders["exports"]["exists"])
        self.assertFalse(os.path.exists(os.path.join(self.data, "exports")))

    def test_the_addon_row_appears_only_with_an_installed_addon(self):
        addon = os.path.join(self.tmp, "ai-packages")
        os.makedirs(addon)
        with mock.patch.object(pack_builder, "_addon_dir", return_value=addon):
            folders = self.local.get("/api/data-folders").json()["folders"]
        self.assertEqual([f["key"] for f in folders][-2:], ["addon", "data"])
        self.assertEqual(folders[-2]["path"], os.path.normpath(addon))
        self.assertEqual(folders[-2]["label"], "Pack Builder add-on")

    def test_old_folders_an_earlier_version_left_are_listed_last(self):
        """2.0 moved the data out of the install folder; a copy it couldn't remove stays on disk."""
        old = os.path.join(self.tmp, "DubMate Studio", "data")
        os.makedirs(old)
        gone = os.path.join(self.tmp, "DubMate Studio", "packbuilder.optin")  # a file: nothing to open
        with open(gone, "w") as f:
            f.write("1")
        with mock.patch.object(data_folders.data_home, "left_behind", return_value=[old, gone]) as left:
            folders = self.local.get("/api/data-folders").json()["folders"]
        self.assertIn(self.data, left.call_args.args[0])
        self.assertEqual(folders[-1], {"key": "old-1", "label": "Old copy, no longer used",
                                       "path": os.path.normpath(old), "exists": True, "own": True})
        self.assertEqual([f["key"] for f in folders][-2:], ["data", "old-1"])
        with mock.patch.object(data_folders.data_home, "left_behind", return_value=[old]):
            self.assertEqual(self._open(self.local, 200, key="old-1").json(), {"status": "ok"})
        self.assertEqual(self._opened_dir(), os.path.normpath(old))

    def test_a_source_install_has_no_old_folders(self):
        keys = [f["key"] for f in self.local.get("/api/data-folders").json()["folders"]]
        self.assertFalse([k for k in keys if k.startswith("old")])

    def test_a_missing_folder_is_listed_as_not_existing(self):
        shutil.rmtree(self.packs_b)
        folders = {f["key"]: f for f in self.local.get("/api/data-folders").json()["folders"]}
        self.assertFalse(folders["packs-2"]["exists"])
        self.assertTrue(folders["rooms"]["exists"])


class TestOwnComputerOnly(DataFoldersCase):
    REFUSED = ({"cf-ray": "abc123"}, {"cf-connecting-ip": "203.0.113.5"},
               {"host": "192.168.1.5:8000"})

    def test_both_routes_refuse_tunnel_and_lan_callers(self):
        for headers in self.REFUSED:
            res = self.local.get("/api/data-folders", headers=headers)
            self.assertEqual(res.status_code, 403, headers)
            self.assertNotIn("dm_folders_", res.text)
            self._open(self.local, 403, headers=headers, key="rooms")
        lan = TestClient(app, base_url="http://192.168.1.20:8000")
        self.assertEqual(lan.get("/api/data-folders").status_code, 403)
        self._open(lan, 403, key="rooms")
        self.popen.assert_not_called()


class TestOpenFolder(DataFoldersCase):

    def test_a_known_key_opens_its_folder(self):
        self.assertEqual(self._open(self.local, 200, key="packs-2").json(), {"status": "ok"})
        self.assertEqual(self._opened_dir(), os.path.normpath(self.packs_b))

    def test_an_unknown_key_is_400(self):
        res = self._open(self.local, 400, key="../secrets")
        self.assertEqual(res.json()["detail"], "That folder isn't one DubMate uses.")
        self._open(self.local, 400)
        self.popen.assert_not_called()

    def test_a_missing_folder_is_404(self):
        shutil.rmtree(self.packs_b)
        res = self._open(self.local, 404, key="packs-2")
        self.assertEqual(res.json()["detail"], "That folder doesn't exist yet.")
        self.popen.assert_not_called()

    def test_a_path_in_the_body_is_ignored(self):
        self._open(self.local, 200, key="rooms", path=self.tmp)
        self.assertEqual(self._opened_dir(), os.path.normpath(os.path.join(self.data, "rooms")))
        self.popen.reset_mock()
        self._open(self.local, 400, path=self.tmp)
        self.popen.assert_not_called()

    def test_the_folder_list_is_the_only_source_of_paths(self):
        with mock.patch.object(data_folders, "data_folders",
                               return_value=[{"key": "rooms", "label": "x", "path": self.packs_a, "exists": True, "own": True}]):
            self._open(self.local, 200, key="rooms")
        self.assertEqual(self._opened_dir(), os.path.normpath(self.packs_a))


if __name__ == "__main__":
    unittest.main()
