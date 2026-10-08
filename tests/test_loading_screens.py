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
        self.assertIn("showFailure(", js)
        self.assertIn("btnRetry", js)
        # Timing is elapsed time, not a poll count (U5b 39a); the red card waits 3 minutes.
        self.assertNotIn("maxAttempts", js)
        self.assertIn("NO_ANSWER_AFTER_MS = 3 * 60 * 1000", js)
        # The launcher's half of the Rust contract (U5b 39a, 39b).
        for name in ("update-status", "update-progress", "update-stage", "update-complete"):
            self.assertIn(f'"{name}"', js, name)
        for cmd in ("cancel_update", "start_packbuilder_install", "get_packbuilder_status",
                    "open_studio_in_browser", "trigger_start_sidecars", "apply_update"):
            self.assertIn(f'"{cmd}"', js, cmd)
        self.assertIn("eta_secs", js)
        self.assertIn("first_download", js)
        # Pack Builder installs in the background: no launcher card, no blocking install.
        self.assertNotIn("packbuilder-progress", js)
        self.assertNotIn("renderBuilderProgress", js)
        self.assertNotIn('"install_packbuilder"', js)
        self.assertNotIn('id="builder-stages"', html)
        self.assertNotIn('id="tech-log"', html)
        # Open in browser goes through Rust, never window.open.
        self.assertNotIn("window.open(", js)
        # Accessibility hooks.
        self.assertIn('role="status"', html)
        self.assertIn('aria-live="polite"', html)
        self.assertIn('role="progressbar"', html)
        self.assertIn('role="alert"', html)

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



class TestHonestLauncherRust(unittest.TestCase):
    """UI pass U5b (39a, 39b): Rust owns the startup text, reports real failures as a
    struct, and Pack Builder installs in the background."""

    TAURI_DIR = os.path.join(BASE_DIR, "tauri", "src-tauri")

    def _read(self, *parts):
        with open(os.path.join(self.TAURI_DIR, *parts), "r", encoding="utf-8") as f:
            return f.read()

    def test_startup_stages_come_from_rust(self):
        rs = _rust_source()
        self.assertIn('"Starting the engine"', rs)
        self.assertIn('"Loading your scenes"', rs)
        self.assertIn("Waiting for application startup", rs)
        # The stderr "Error"/"Traceback" guess is gone, and so is the generic stage.
        self.assertNotIn('"Still starting"', rs)
        self.assertNotIn('"Starting DubMate"', rs)

    def test_engine_failures_are_a_struct_with_known_kinds(self):
        rs = _rust_source()
        self.assertIn("struct EngineFailure", rs)
        self.assertIn("fn classify_engine_failure", rs)
        for kind in ("missing_files", "no_runtime", "port_in_use", "damaged", "crashed", "timeout"):
            self.assertIn(f'"{kind}"', rs, kind)
        # 3 minutes before a real "didn't start", not 30 seconds.
        self.assertIn("ENGINE_START_TIMEOUT_SECS: u64 = 180", rs)

    def test_commands_are_registered_and_allowed(self):
        new = ["start_packbuilder_install", "get_packbuilder_install", "cancel_update",
               "open_mic_settings", "open_studio_in_browser"]
        build = self._read("build.rs")
        main = self._read("src", "main.rs")
        for cmd in new:
            self.assertIn(f'"{cmd}"', build, cmd)
            self.assertIn(cmd, main, cmd)
        self.assertNotIn('"install_packbuilder"', build)
        self.assertNotIn("fn install_packbuilder", _rust_source())

        default = json.loads(self._read("capabilities", "default.json"))["permissions"]
        for perm in ("allow-start-packbuilder-install", "allow-get-packbuilder-install",
                     "allow-cancel-update", "allow-open-mic-settings",
                     "allow-open-studio-in-browser"):
            self.assertIn(perm, default)
        self.assertNotIn("allow-install-packbuilder", default)

        studio = json.loads(self._read("capabilities", "studio.json"))
        for perm in ("allow-open-mic-settings", "allow-start-packbuilder-install",
                     "allow-get-packbuilder-install", "allow-trigger-start-sidecars"):
            self.assertIn(perm, studio["permissions"])
        # The studio page never gets the browser opener or the updater.
        self.assertNotIn("allow-open-studio-in-browser", studio["permissions"])
        self.assertNotIn("allow-cancel-update", studio["permissions"])
        self.assertNotIn("allow-apply-update", studio["permissions"])


class TestLauncherLook(unittest.TestCase):
    """UI pass U5b (39): the launcher is the studio's front door, in the studio's
    colours and fonts, even before the engine or the internet is up."""

    LAUNCHER_DIR = os.path.join(BASE_DIR, "tauri", "src")

    def _launcher_html(self):
        with open(os.path.join(self.LAUNCHER_DIR, "index.html"), encoding="utf-8") as f:
            return f.read()

    @staticmethod
    def _tokens(css):
        import re
        root = css[css.index(":root {"):]
        root = root[:root.index("}")]
        return dict(re.findall(r"(--[\w-]+):\s*([^;]+);", root))

    def test_tokens_are_the_studios_by_name(self):
        with open(STYLE_CSS, encoding="utf-8") as f:
            studio = self._tokens(f.read())
        launcher = self._tokens(self._launcher_html())
        for name in ("--background", "--card", "--border", "--border-wood", "--foreground",
                     "--foreground-muted", "--foreground-dim", "--primary", "--primary-hover",
                     "--accent-brass", "--accent-red-soft"):
            self.assertEqual(launcher.get(name), studio[name], name)

    def test_window_is_the_studios_colour(self):
        with open(os.path.join(BASE_DIR, "tauri", "src-tauri", "tauri.conf.json"), encoding="utf-8") as f:
            conf = json.load(f)
        self.assertEqual(conf["app"]["windows"][0]["backgroundColor"], "#12100e")

    def test_fonts_are_bundled_with_their_licences(self):
        html = self._launcher_html()
        fonts = os.path.join(self.LAUNCHER_DIR, "fonts")
        for woff2 in ("PlusJakartaSans-latin.woff2", "JetBrainsMono-latin.woff2"):
            with open(os.path.join(fonts, woff2), "rb") as f:
                self.assertEqual(f.read(4), b"wOF2", woff2)
            self.assertIn(f'url("fonts/{woff2}")', html)
        for licence in ("OFL-PlusJakartaSans.txt", "OFL-JetBrainsMono.txt"):
            with open(os.path.join(fonts, licence), encoding="utf-8") as f:
                self.assertIn("SIL Open Font License", f.read(), licence)
        # Nothing comes from the internet.
        self.assertNotIn("fonts.googleapis.com", html)
        self.assertNotIn("fonts.gstatic.com", html)

    def test_no_emoji_and_reduced_motion(self):
        html = self._launcher_html()
        self.assertNotIn("⚠", html)
        self.assertIn("prefers-reduced-motion", html)


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
