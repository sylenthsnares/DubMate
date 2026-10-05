# -*- coding: utf-8 -*-
"""
run_all_tests.py
Comprehensive in-depth test runner for DubMate Studio.
Runs syntax checks across all files, executes every frontend JSDOM test,
the worker unit tests, and every tests/test_*.py suite with timing metrics.

Every subprocess runs with an isolated HOME/USERPROFILE and DUBMATE_CACHE_DIR
inside a per-run temp dir, so the suites never read or write the user's real
~/.dubmate/config.json or cache.
"""
import os
import sys
import glob
import time
import shutil
import tempfile
import py_compile
import subprocess

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(TESTS_DIR)
PYTHON_EXE = sys.executable
FIXTURE_PREFIX = "ZZ_Fixture_"
FIXTURE_COUNT = 15

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
    pkg_dir = os.path.join(PROJECT_ROOT, "dubmate")
    if os.path.isdir(pkg_dir):
        for root, dirs, files in os.walk(pkg_dir):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            py_files += [os.path.join(root, f) for f in files if f.endswith(".py")]
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

def test_javascript_syntax(env):
    print_header("Phase 2: JavaScript Syntax & Static Lint Audit")
    js_dirs = [
        os.path.join(PROJECT_ROOT, "static", "js"),
        os.path.join(PROJECT_ROOT, "tauri", "src"),
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
            res = subprocess.run(["node", "--check", path], capture_output=True, text=True, env=env)
            if res.returncode == 0:
                print(f"  [OK]  {rel}")
                passed += 1
            else:
                print(f"  [ERR] {rel}: {res.stderr.strip()}")
                failed += 1
        except Exception as e:
            print(f"  [SKIP] {rel}: {e}")
    return passed, failed

def test_frontend_suite(env):
    print_header("Phase 3: Frontend JSDOM Headless DOM & Audio Integration Suites")
    t0 = time.time()
    all_passed = True
    for path in sorted(glob.glob(os.path.join(TESTS_DIR, "test_*.js"))):
        filename = os.path.basename(path)
        t1 = time.time()
        res = subprocess.run(["node", path], capture_output=True, text=True, env=env)
        dur = time.time() - t1
        if res.returncode == 0:
            print(f"  [PASS] [{dur:5.2f}s] {filename}")
            for line in res.stdout.strip().split("\n"):
                if "PASS:" in line or "ALL " in line:
                    print(f"         {line.strip()}")
        else:
            all_passed = False
            print(f"  [FAIL] [{dur:5.2f}s] {filename}:\n{res.stderr}\n{res.stdout}")
    return all_passed, time.time() - t0

def test_worker_suite(env):
    print_header("Phase 4: Cloudflare Worker Unit Tests")
    t0 = time.time()
    res = subprocess.run(["node", "--experimental-strip-types", "tests/worker.test.mjs"],
                         cwd=os.path.join(PROJECT_ROOT, "worker"),
                         capture_output=True, text=True, env=env)
    dur = time.time() - t0
    if res.returncode == 0:
        print(f"  [PASS] [{dur:5.2f}s] worker/tests/worker.test.mjs")
        return True, dur
    print(f"  [FAIL] [{dur:5.2f}s] worker/tests/worker.test.mjs:\n{res.stderr}\n{res.stdout}")
    return False, dur

def ensure_fixture_packs(env):
    """Generates the synthetic fixture packs the suites rely on if any are missing."""
    found = glob.glob(os.path.join(PROJECT_ROOT, "Packs", FIXTURE_PREFIX + "*"))
    if sum(1 for p in found if os.path.isdir(p)) >= FIXTURE_COUNT:
        return True
    print(f"\n  [..] Fewer than {FIXTURE_COUNT} fixture packs in Packs/; running scripts/make_test_packs.py")
    res = subprocess.run([PYTHON_EXE, os.path.join("scripts", "make_test_packs.py")],
                         cwd=PROJECT_ROOT, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        print(f"  [FAIL] make_test_packs.py failed:\n{res.stderr}\n{res.stdout}")
        return False
    print("  [OK]  Fixture packs generated")
    return True

def test_python_suites(env):
    print_header("Phase 5: Deep Backend, DSP, Packaging & Multiplayer Test Suites")
    results = []
    for script_path in sorted(glob.glob(os.path.join(TESTS_DIR, "test_*.py"))):
        script = os.path.basename(script_path)
        t0 = time.time()
        res = subprocess.run([PYTHON_EXE, script_path], capture_output=True, text=True, env=env)
        dur = time.time() - t0
        passed = (res.returncode == 0)
        results.append((script, passed, dur, res.stdout, res.stderr))
        status_icon = "[PASS]" if passed else "[FAIL]"
        print(f"  {status_icon} [{dur:5.2f}s] {script}")
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

    tmp = tempfile.mkdtemp(prefix="dubmate_tests_")
    try:
        home = os.path.join(tmp, "home")
        cache = os.path.join(tmp, "cache")
        os.makedirs(home)
        os.makedirs(cache)
        # DUBMATE_EXPORTS_DIR is deliberately not set: it overrides the configured
        # export folder and would make that setting untestable. Exports default to
        # <cache>/exports, which is already isolated.
        env = dict(os.environ, USERPROFILE=home, HOME=home, DUBMATE_CACHE_DIR=cache)
        env.pop("DUBMATE_EXPORTS_DIR", None)

        py_pass, py_fail = test_python_syntax()
        js_pass, js_fail = test_javascript_syntax(env)
        fe_pass, fe_dur = test_frontend_suite(env)
        wk_pass, wk_dur = test_worker_suite(env)
        fixtures_ok = ensure_fixture_packs(env)
        py_results = test_python_suites(env) if fixtures_ok else []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    total_time = time.time() - total_start

    print("\n" + "=" * 70)
    print("  COMPREHENSIVE TEST AUDIT SUMMARY")
    print("=" * 70)
    print(f"  * Python Syntax Checks:     {py_pass}/{py_pass + py_fail} files OK")
    print(f"  * JavaScript Syntax Checks: {js_pass}/{js_pass + js_fail} files OK")
    print(f"  * Frontend JSDOM Suites:    {'PASSED' if fe_pass else 'FAILED'} in {fe_dur:.2f}s")
    print(f"  * Worker Unit Tests:        {'PASSED' if wk_pass else 'FAILED'} in {wk_dur:.2f}s")
    if not fixtures_ok:
        print("  * Fixture Packs:            FAILED to generate; backend suites not run")

    all_py_passed = fixtures_ok and all(r[1] for r in py_results)
    passed_count = sum(1 for r in py_results if r[1])
    print(f"  * Backend Test Suites:      {passed_count}/{len(py_results)} suites PASSED")
    print(f"  * Total Execution Time:     {total_time:.2f} seconds")
    print("=" * 70)

    if py_fail == 0 and js_fail == 0 and fe_pass and wk_pass and all_py_passed:
        print("  >>> ALL TESTS & CODEBASE AUDITS PASSED WITH ZERO ERRORS! <<<")
        print("=" * 70 + "\n")
        sys.exit(0)
    else:
        print("  [!] SOME TESTS FAILED. PLEASE REVIEW LOGS ABOVE.")
        print("=" * 70 + "\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
