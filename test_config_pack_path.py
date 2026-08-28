# -*- coding: utf-8 -*-
"""
test_config_pack_path.py
Automated test suite verifying:
1. Persistent scene pack folder configuration storage and retrieval (~/.dubmate/config.json).
2. GET /api/config endpoint returning active directory and pack counts.
3. POST /api/config endpoint setting, validating, and persisting custom packs folders.
4. Dynamic hot rescan and recovery when custom pack folders are configured.
5. Error handling for non-existent and empty paths.
"""

import os
import shutil
import tempfile
import unittest
from starlette.testclient import TestClient

import pack_loader
import app


class TestConfigPackPath(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Reset config to clean default
        default_dir = os.path.abspath(pack_loader.get_default_packs_dir())
        pack_loader.save_config({"packs_dir": default_dir})
        pack_loader.init_pack_dirs()
        pack_loader.PACK_OBJECT_CACHE.clear()

        cls.client = TestClient(app.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        # Restore default packs dir
        default_dir = os.path.abspath(pack_loader.get_default_packs_dir())
        pack_loader.save_config({"packs_dir": default_dir})
        pack_loader.init_pack_dirs()
        pack_loader.PACK_OBJECT_CACHE.clear()
        cls.client.__exit__(None, None, None)

    def test_01_get_config_returns_active_directory(self):
        """Verify GET /api/config returns active packs directory, config file path, and pack count."""
        resp = self.client.get("/api/config")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("packs_dir", data)
        self.assertIn("scanned_paths", data)
        self.assertIn("config_file", data)
        self.assertIn("pack_count", data)
        self.assertIsInstance(data["packs"], list)
        print(f"\n[Test 1] GET /api/config returned active packs_dir: {data['packs_dir']} ({data['pack_count']} packs)")

    def test_02_post_config_empty_or_invalid_path(self):
        """Verify POST /api/config rejects empty or non-existent directories with 400 Bad Request."""
        # Empty payload
        resp1 = self.client.post("/api/config", json={"packs_dir": ""})
        self.assertEqual(resp1.status_code, 400)

        # Non-existent path
        fake_path = os.path.join(tempfile.gettempdir(), "non_existent_packs_dir_99999")
        resp2 = self.client.post("/api/config", json={"packs_dir": fake_path})
        self.assertEqual(resp2.status_code, 400)
        self.assertIn("Directory does not exist", resp2.json()["detail"])
        print("[Test 2] Invalid paths rejected with 400 status and clear error message.")

    def test_03_custom_packs_folder_persistence_and_scan(self):
        """Verify setting a custom packs folder persists to disk and indexes packs in that folder."""
        temp_packs_base = tempfile.mkdtemp(prefix="dubmate_test_custom_packs_")
        source_pack = os.path.join(pack_loader.BASE_DIR, "Packs", "Deku_vs_Todoroki")
        target_pack = os.path.join(temp_packs_base, "Deku_vs_Todoroki")

        if os.path.exists(source_pack):
            shutil.copytree(source_pack, target_pack)

        try:
            # POST to /api/config
            resp = self.client.post("/api/config", json={"packs_dir": temp_packs_base})
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "ok")
            self.assertEqual(os.path.normpath(data["packs_dir"]), os.path.normpath(temp_packs_base))
            self.assertGreaterEqual(data["pack_count"], 1)

            # Verify saved config on disk matches
            saved_cfg = pack_loader.load_config()
            self.assertEqual(os.path.normpath(saved_cfg.get("packs_dir")), os.path.normpath(temp_packs_base))

            # Re-initialize pack loader and verify persistence
            pack_loader.init_pack_dirs()
            self.assertIn(os.path.abspath(temp_packs_base), [os.path.abspath(d) for d in pack_loader.PACKS_DIRS])

            # Check GET /api/packs includes the custom pack
            resp_packs = self.client.get("/api/packs")
            self.assertEqual(resp_packs.status_code, 200)
            self.assertGreaterEqual(len(resp_packs.json()), 1)
            print(f"[Test 3] Custom folder successfully persisted and indexed {data['pack_count']} packs.")

        finally:
            shutil.rmtree(temp_packs_base, ignore_errors=True)

    def test_04_single_pack_folder_auto_resolution(self):
        """Verify pointing directly to a single pack directory automatically resolves its container."""
        temp_single_base = tempfile.mkdtemp(prefix="dubmate_test_single_")
        source_pack = os.path.join(pack_loader.BASE_DIR, "Packs", "Deku_vs_Todoroki")
        target_pack = os.path.join(temp_single_base, "Solo_Pack")

        if os.path.exists(source_pack):
            shutil.copytree(source_pack, target_pack)

        try:
            # Point directly to Solo_Pack subfolder
            resp = self.client.post("/api/config", json={"packs_dir": target_pack})
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "ok")
            self.assertGreaterEqual(data["pack_count"], 1)
            print(f"[Test 4] Single pack folder resolved parent '{data['packs_dir']}' and loaded {data['pack_count']} packs.")
        finally:
            shutil.rmtree(temp_single_base, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
