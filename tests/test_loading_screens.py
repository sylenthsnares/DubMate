# -*- coding: utf-8 -*-
"""
test_loading_screens.py
Comprehensive automated test script verifying the presence, correctness, and behavior
of the newly introduced loading screens, modal overlays, CSS animations, and JS lock methods.
"""

import os
import json
import unittest

# Ensure the project root is importable when this suite is run from tests/
import sys as _sys
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_sys.path.insert(0, BASE_DIR)
INDEX_HTML = os.path.join(BASE_DIR, "static", "index.html")
STYLE_CSS = os.path.join(BASE_DIR, "static", "css", "style.css")
RUST_SRC_DIR = os.path.join(BASE_DIR, "tauri", "src-tauri", "src")


def _rust_source():
    """Every tauri/src-tauri/src/*.rs, sorted and concatenated, so moving code
    between modules does not hide it from these checks."""
    parts = []
    for name in sorted(os.listdir(RUST_SRC_DIR)):
        if name.endswith(".rs"):
            with open(os.path.join(RUST_SRC_DIR, name), "r", encoding="utf-8") as f:
                parts.append(f.read())
    return "\n".join(parts)


class TestLoadingScreensAndLockouts(unittest.TestCase):

    def test_01_index_html_modal_elements(self):
        """Verify all modal and overlay elements are present in index.html with correct accessibility attributes."""
        self.assertTrue(os.path.exists(INDEX_HTML), "index.html missing")
        with open(INDEX_HTML, "r", encoding="utf-8") as f:
            html = f.read()

        # Master Export Modal elements
        required_export_ids = [
            "modal-export-rendering",
            "export-modal-badge",
            "export-modal-title",
            "export-modal-status-text",
            "export-modal-progress",
            "export-modal-progress-bar",
            "modal-step-dsp",
            "modal-step-mux",
            "connector-dsp-mux",
            "export-modal-reassurance",
            "export-modal-actions",
            "export-modal-failed-actions",
            "export-modal-timeout-actions",
            "btn-modal-close-view",
            "btn-modal-close-x",
            "btn-modal-reveal",
            "btn-modal-make-916",
            "btn-modal-download-169",
            "btn-modal-download-916",
            "btn-modal-retry",
            "btn-modal-keep-working",
        ]
        for el_id in required_export_ids:
            self.assertIn(f'id="{el_id}"', html, f"Missing element id: {el_id} in index.html")
        # Two real steps (no "Finish" nothing reports), and no text Close once done (UI pass U5a).
        for gone in ("modal-step-ready", "connector-mux-ready", "btn-modal-dismiss", "export-saved-path"):
            self.assertNotIn(f'id="{gone}"', html, f"{gone} is still in the export modal")

        # A take saves in the background (UI pass U2): no booth-wide overlay.
        self.assertNotIn('id="booth-processing-overlay"', html)

        # Pack Import Loading Modal
        self.assertIn('id="modal-import-loading"', html)
        self.assertIn('id="import-modal-title"', html)
        self.assertIn('id="import-modal-status-text"', html)

    def test_02_style_css_modal_and_lock_rules(self):
        """Verify all modal, overlay, keyframe, and interaction lock CSS classes exist in style.css."""
        self.assertTrue(os.path.exists(STYLE_CSS), "style.css missing")
        with open(STYLE_CSS, "r", encoding="utf-8") as f:
            css = f.read()

        required_classes = [
            ".studio-modal-overlay",
            ".studio-modal-card",
            ".modal-close-btn",
            ".render-film-reel",
            ".reel-core",
            ".reel-pulse-ring",
            ".modal-steps-container",
            ".modal-step-item",
            ".modal-progress-track",
            ".modal-progress-fill",
            ".ui-interaction-locked",
        ]
        for cls in required_classes:
            self.assertIn(cls, css, f"Missing CSS selector: {cls} in style.css")

        # Verify keyframes
        keyframes = [
            "@keyframes studioFadeIn",
            "@keyframes studioScaleUp",
            "@keyframes spinFilmReel",
            "@keyframes pulseReelRing",
        ]
        for kf in keyframes:
            self.assertIn(kf, css, f"Missing keyframe: {kf} in style.css")

    def test_05_tauri_launcher_elements_and_resilience(self):
        """Verify desktop launcher HTML, JS, config and Rust handle startup, progress, and errors reliably."""
        launcher_html_path = os.path.join(BASE_DIR, "tauri", "src", "index.html")
        launcher_js_path = os.path.join(BASE_DIR, "tauri", "src", "launcher.js")
        tauri_conf_path = os.path.join(BASE_DIR, "tauri", "src-tauri", "tauri.conf.json")
        main_rs_path = os.path.join(BASE_DIR, "tauri", "src-tauri", "src", "main.rs")

        self.assertTrue(os.path.exists(launcher_html_path), "tauri/src/index.html missing")
        self.assertTrue(os.path.exists(launcher_js_path), "tauri/src/launcher.js missing")
        self.assertTrue(os.path.exists(tauri_conf_path), "tauri/src-tauri/tauri.conf.json missing")
        self.assertTrue(os.path.exists(main_rs_path), "tauri/src-tauri/src/main.rs missing")

        with open(launcher_html_path, "r", encoding="utf-8") as f:
            html = f.read()
        self.assertIn('id="splash"', html)
        self.assertIn('id="status-text"', html)
        self.assertIn('id="detail-text"', html)
        self.assertIn('id="error-box"', html)
        self.assertIn('id="error-msg"', html)
        self.assertIn('id="btn-retry"', html)
        self.assertIn('id="btn-open-browser"', html)

        with open(launcher_js_path, "r", encoding="utf-8") as f:
            js = f.read()
        self.assertIn("startup-progress", js)
        self.assertIn("server-error", js)
        self.assertIn("server-ready", js)
        self.assertIn("showError(", js)
        self.assertIn("btnRetry", js)
        self.assertIn("maxAttempts = 120", js)

        with open(tauri_conf_path, "r", encoding="utf-8") as f:
            conf = json.load(f)
        self.assertTrue(conf.get("app", {}).get("withGlobalTauri", False), "withGlobalTauri must be enabled")
        self.assertEqual(conf.get("build", {}).get("frontendDist"), "../src", "frontendDist should point to ../src")

        rs = _rust_source()
        self.assertIn('emit("server-error"', rs)
        self.assertIn('emit("startup-progress"', rs)
        self.assertIn('emit("server-ready"', rs)
        self.assertIn('"-u"', rs)

    def test_06_fastapi_root_and_static_routes(self):
        """Verify that app.py serves root index.html, builder.html, css, and js assets with 200 OK."""
        from fastapi.testclient import TestClient
        import app

        client = TestClient(app.app)
        # Root index
        resp = client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("<title>DubMate</title>", resp.text)

        # /index.html
        resp_idx = client.get("/index.html")
        self.assertEqual(resp_idx.status_code, 200)
        self.assertIn("<title>DubMate</title>", resp_idx.text)

        # /builder.html
        resp_bld = client.get("/builder.html")
        self.assertEqual(resp_bld.status_code, 200)

        # CSS asset
        resp_css = client.get("/css/style.css")
        self.assertEqual(resp_css.status_code, 200)
        self.assertEqual(resp_css.headers.get("content-type"), "text/css; charset=utf-8")

        # JS asset
        resp_js = client.get("/js/app.js")
        self.assertEqual(resp_js.status_code, 200)



class TestEnginePortIsDynamic(unittest.TestCase):
    """The engine port must not be hardcoded: a busy 8000 used to be fatal."""

    def test_app_honours_dubmate_port_env(self):
        import os as _os
        import importlib
        sys_path_app = importlib.import_module("app")
        prev = _os.environ.get("DUBMATE_PORT")
        try:
            _os.environ["DUBMATE_PORT"] = "8321"
            self.assertEqual(sys_path_app.get_engine_port(), 8321)
            _os.environ["DUBMATE_PORT"] = "garbage"
            self.assertEqual(sys_path_app.get_engine_port(), 8000)
        finally:
            if prev is None:
                _os.environ.pop("DUBMATE_PORT", None)
            else:
                _os.environ["DUBMATE_PORT"] = prev

    def test_launcher_js_has_no_hardcoded_engine_url(self):
        path = os.path.join(BASE_DIR, "tauri", "src", "launcher.js")
        with open(path, encoding="utf-8") as f:
            body = f.read()
        self.assertNotIn(
            "127.0.0.1:8000", body,
            "launcher.js must build the engine URL from the resolved port",
        )

    def test_rust_selects_a_free_port(self):
        body = _rust_source()
        self.assertIn("fn find_available_port", body)
        self.assertIn('env("DUBMATE_PORT"', body)

if __name__ == "__main__":
    unittest.main()
