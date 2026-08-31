# -*- coding: utf-8 -*-
"""
run_all_tests.py
Comprehensive in-depth test runner for DubMate Studio.
Runs syntax checks across all files, executes frontend JSDOM tests,
and runs all 9 deep unit/integration test suites with timing metrics.
"""
import os
import sys
import time
import py_compile
import subprocess

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(TESTS_DIR)
PYTHON_EXE = sys.executable

def print_header(title: str):
    print("\n" + "=" * 70)
    print(f"  [+] {title}")
    print("=" * 70)

def test_python_syntax():
    print_header("Phase 1: Python Source File Compilation & Syntax Audit")
    py_files = []
    for d in (PROJECT_ROOT, TESTS_DIR, os.path.join(PROJECT_ROOT, "scripts")):
        if os.path.isdir(d):
            py_files += [os.path.join(d, f) for f in os.listdir(d) if f.endswith(".py")]
    passed = 0
    failed = 0
    for path in sorted(py_files):
        f = os.path.relpath(path, PROJECT_ROOT)
        try:
            py_compile.compile(path, doraise=True)
            print(f"  [OK]  {f}")
            passed += 1
        except Exception as e:
            print(f"  [ERR] {f}: {e}")
            failed += 1
    return passed, failed

def test_javascript_syntax():
    print_header("Phase 2: JavaScript Syntax & Static Lint Audit")
    js_dirs = [
        os.path.join(PROJECT_ROOT, "static", "js"),
        os.path.join(PROJECT_ROOT, "tauri", "src"),
        os.path.join(PROJECT_ROOT, "worker"),
    ]
    js_files = []
    for d in js_dirs:
        if os.path.isdir(d):
            for root, _, files in os.walk(d):
                for f in files:
                    if f.endswith(".js") and "node_modules" not in root:
                        js_files.append(os.path.join(root, f))

    passed = 0
    failed = 0
    for path in sorted(js_files):
        rel = os.path.relpath(path, PROJECT_ROOT)
        try:
            res = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if res.returncode == 0:
                print(f"  [OK]  {rel}")
                passed += 1
            else:
                print(f"  [ERR] {rel}: {res.stderr.strip()}")
                failed += 1
        except Exception as e:
            print(f"  [SKIP] {rel}: {e}")
    return passed, failed

def test_frontend_suite():
    print_header("Phase 3: Frontend JSDOM Headless DOM & Audio Integration Suite")
    t0 = time.time()
    for filename, label in (("test_room_socket.js", "Room Socket Delivery"),
                            ("test_launcher_ui.js", "Desktop Launcher Install Card"),
                            ("test_export_downloads.js", "Export & Download Feedback")):
        node_res = subprocess.run(["node", os.path.join(TESTS_DIR, filename)], capture_output=True, text=True)
        if node_res.returncode == 0:
            print(f"  [PASS] {label}")
            for line in node_res.stdout.strip().split("\n"):
                if "PASS:" in line:
                    print(f"         {line.strip()}")
        else:
            print(f"  [FAIL] {label} FAILED:\n{node_res.stderr}\n{node_res.stdout}")
            return False, time.time() - t0

    res = subprocess.run(["node", os.path.join(TESTS_DIR, "test_frontend.js")], capture_output=True, text=True)
    dur = time.time() - t0
    if res.returncode == 0:
        print(f"  [PASS] Frontend DOM & Audio Suite ({dur:.2f}s)")
        for line in res.stdout.strip().split("\n"):
            if "PASS:" in line or "ALL " in line:
                print(f"         {line.strip()}")
        return True, dur
    else:
        print(f"  [FAIL] Frontend DOM Suite FAILED ({dur:.2f}s):\n{res.stderr}\n{res.stdout}")
        return False, dur

def test_python_suites():
    print_header("Phase 4: Deep Backend, DSP, Packaging & Multiplayer Test Suites")
    suites = [
        ("test_config_pack_path.py", "Scene Pack Configuration & Dynamic Path Resolver"),
        ("test_host_transfer.py", "Multiplayer Host Migration & Version Handshake"),
        ("test_room_registry.py", "Public Room Code Publishing & Tunnel Handoff"),
        ("test_performance_guards.py", "Cold Start, Audio I/O & Cache Policy Guards"),
        ("test_sidecar_names.py", "Bundled Sidecar Name Resolution"),
        ("test_loading_screens.py", "Desktop Launcher Resilience & Modal States"),
        ("test_loudness_alignment.py", "Audio Loudness Normalization & True-Peak DSP"),
        ("test_noise_reduction.py", "Noise Profile Calibration & Dual-Take Generation"),
        ("test_noise_reduction_deep.py", "Spectral Subtraction & Audio Stem Export Stress Test"),
        ("test_pack_builder.py", "Scene Pack Creator, INI Parser & Video Transcoding"),
        ("test_pack_security.py", "Zip-Slip Defenses, Malware Quarantine & Tree Importer"),
        ("test_systematic.py", "Master Systematic Dual-Engine Suite & Full Project Zip"),
        ("test_audio_safety.py", "DSP Numerical Safety, Gain Clamping & Path Sanitization"),
        ("test_security_hardening.py", "Path Traversal, WebSocket Authorization & ZIP Allowlist"),
    ]

    results = []
    for script, desc in suites:
        script_path = os.path.join(TESTS_DIR, script)
        t0 = time.time()
        res = subprocess.run([PYTHON_EXE, script_path], capture_output=True, text=True)
        dur = time.time() - t0
        passed = (res.returncode == 0)
        results.append((script, desc, passed, dur, res.stdout, res.stderr))
        status_icon = "[PASS]" if passed else "[FAIL]"
        print(f"  {status_icon} [{dur:5.2f}s] {script} - {desc}")
        if not passed:
            print(f"     Error Output:\n{res.stderr}\n{res.stdout}")

    return results

def main():
    total_start = time.time()
    print("=" * 70)
    print("  DubMate Studio - Unified Deep Verification Runner")
    print(f"  Python Interpreter: {PYTHON_EXE}")
    print(f"  Workspace: {PROJECT_ROOT}")
    print("=" * 70)

    py_pass, py_fail = test_python_syntax()
    js_pass, js_fail = test_javascript_syntax()
    fe_pass, fe_dur = test_frontend_suite()
    py_results = test_python_suites()

    total_time = time.time() - total_start

    print("\n" + "=" * 70)
    print("  COMPREHENSIVE TEST AUDIT SUMMARY")
    print("=" * 70)
    print(f"  * Python Syntax Checks:     {py_pass}/{py_pass + py_fail} files OK")
    print(f"  * JavaScript Syntax Checks: {js_pass}/{js_pass + js_fail} files OK")
    print(f"  * Frontend JSDOM Suite:     {'PASSED' if fe_pass else 'FAILED'} in {fe_dur:.2f}s")

    all_py_passed = all(r[2] for r in py_results)
    passed_count = sum(1 for r in py_results if r[2])
    print(f"  * Backend Test Suites:      {passed_count}/{len(py_results)} suites PASSED")
    print(f"  * Total Execution Time:     {total_time:.2f} seconds")
    print("=" * 70)

    if py_fail == 0 and js_fail == 0 and fe_pass and all_py_passed:
        print("  >>> ALL TESTS & CODEBASE AUDITS PASSED WITH ZERO ERRORS! <<<")
        print("=" * 70 + "\n")
        sys.exit(0)
    else:
        print("  [!] SOME TESTS FAILED. PLEASE REVIEW LOGS ABOVE.")
        print("=" * 70 + "\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
