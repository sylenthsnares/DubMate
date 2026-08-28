# -*- coding: utf-8 -*-
"""
test_launcher.py
DubMate Studio - Local Desktop Standalone Test Launcher
Spawns the local FastAPI studio server, opens the browser to the studio/launcher,
and handles clean shutdown on exit.
"""
import os
import sys
import time
import webbrowser
import threading
import uvicorn

# Ensure project root is in sys.path
if getattr(sys, 'frozen', False):
    # Running as compiled PyInstaller executable
    EXE_DIR = os.path.dirname(sys.executable)
    BUNDLE_DIR = sys._MEIPASS if hasattr(sys, '_MEIPASS') else EXE_DIR
    sys.path.insert(0, BUNDLE_DIR)
    sys.path.insert(0, EXE_DIR)
    os.chdir(EXE_DIR)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    if BASE_DIR not in sys.path:
        sys.path.insert(0, BASE_DIR)

import app
import pack_loader


def open_browser_delayed(url: str, delay_sec: float = 1.2):
    def _open():
        time.sleep(delay_sec)
        print(f"[DubMate] Opening browser at {url}...")
        webbrowser.open(url)
    t = threading.Thread(target=_open, daemon=True)
    t.start()


def main():
    print("=" * 60)
    print("  🎙️  DubMate Studio - Local Test Executable  🎬")
    print(f"  Version: {app.read_version()}")
    print("=" * 60)

    # Initialize pack paths & print active pack directory
    cfg = pack_loader.get_current_packs_config()
    print(f"[DubMate Config] Active scene packs directory: {cfg['packs_dir']}")
    print(f"[DubMate Config] Discovered scene packs: {cfg['pack_count']}")
    print(f"[DubMate Config] Configuration file: {cfg['config_file']}")
    print("-" * 60)

    # Launch browser to studio
    server_url = "http://127.0.0.1:8000"
    open_browser_delayed(server_url)

    print(f"[DubMate Engine] Starting FastAPI server on {server_url}...")
    uvicorn.run(app.app, host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
