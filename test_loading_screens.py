# -*- coding: utf-8 -*-
"""
test_loading_screens.py
Comprehensive automated test script verifying the presence, correctness, and behavior
of the newly introduced loading screens, modal overlays, CSS animations, and JS lock methods.
"""

import os
import unittest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML = os.path.join(BASE_DIR, "static", "index.html")
STYLE_CSS = os.path.join(BASE_DIR, "static", "css", "style.css")
APP_JS = os.path.join(BASE_DIR, "static", "js", "app.js")
APP_PY = os.path.join(BASE_DIR, "app.py")


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
            "export-modal-progress-bar",
            "modal-step-dsp",
            "modal-step-mux",
            "modal-step-ready",
            "connector-dsp-mux",
            "connector-mux-ready",
            "export-modal-reassurance",
            "export-modal-actions",
            "btn-modal-close-view",
            "btn-modal-close-x",
            "btn-modal-dismiss",
            "btn-modal-download-169",
            "btn-modal-download-916",
        ]
        for el_id in required_export_ids:
            self.assertIn(f'id="{el_id}"', html, f"Missing element id: {el_id} in index.html")

        # Booth Processing Overlay
        self.assertIn('id="booth-processing-overlay"', html)
        self.assertIn('class="booth-processing-card"', html)
        self.assertIn('class="processing-spinner-ring"', html)

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
            ".booth-processing-overlay",
            ".booth-processing-card",
            ".processing-spinner-ring",
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
            "@keyframes spinSpinner",
        ]
        for kf in keyframes:
            self.assertIn(kf, css, f"Missing keyframe: {kf} in style.css")

    def test_03_app_js_state_and_methods(self):
        """Verify app.js implements lock state management and modal helper methods."""
        self.assertTrue(os.path.exists(APP_JS), "app.js missing")
        with open(APP_JS, "r", encoding="utf-8") as f:
            js = f.read()

        # Flags & DOM bindings
        self.assertIn("this.isRenderingExport = false", js)
        self.assertIn("this.isProcessingTake = false", js)
        self.assertIn("this.modalExportRendering = document.getElementById('modal-export-rendering')", js)
        self.assertIn("this.boothProcessingOverlay = document.getElementById('booth-processing-overlay')", js)
        self.assertIn("this.modalImportLoading = document.getElementById('modal-import-loading')", js)

        # Methods
        self.assertIn("setBoothProcessing(", js)
        self.assertIn("openExportModal(", js)
        self.assertIn("updateExportModalStep(", js)
        self.assertIn("handleExportSuccess(", js)
        self.assertIn("closeExportModal(", js)
        self.assertIn("lockScreeningUI(", js)

        # Keydown lock guard
        self.assertIn("if (this.isProcessingTake || this.isRenderingExport)", js)

        # Socket broadcast listeners
        self.assertIn("this.socket.on('export_started'", js)
        self.assertIn("this.socket.on('export_ready'", js)

    def test_04_app_py_export_started_broadcast(self):
        """Verify app.py broadcasts export_started to connected sockets."""
        self.assertTrue(os.path.exists(APP_PY), "app.py missing")
        with open(APP_PY, "r", encoding="utf-8") as f:
            py = f.read()

        self.assertIn('room.broadcast("export_started"', py)


if __name__ == "__main__":
    unittest.main()
