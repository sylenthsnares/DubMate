# -*- coding: utf-8 -*-
"""
run_all_tests.py
Comprehensive in-depth test runner for DubMate Studio.
Runs syntax checks across all files, executes every frontend JSDOM test,
the worker unit tests, and every tests/test_*.py suite with timing metrics.

Every subprocess runs with an isolated HOME/USERPROFILE, DUBMATE_CACHE_DIR and
TMP/TEMP/TMPDIR inside a per-run temp dir, so the suites never read or write the
user's real ~/.dubmate/config.json or cache, and leave no temp files behind.
The fixture packs are generated into that dir too, never into the repo's Packs/
(which may be the app's real pack library).
"""
import os
import sys
import glob
import json
import stat
import time
import shutil
import tempfile
import py_compile
import subprocess

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(TESTS_DIR)
PYTHON_EXE = sys.executable
FIXTURE_COUNT = 15
RUN_DIR_PREFIX = "dubmate_tests_"

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

def make_fixture_packs(packs_dir, env):
    """Generates the synthetic fixture packs the suites rely on into packs_dir (a temp folder)."""
    print(f"\n  [..] Generating {FIXTURE_COUNT} fixture packs in {packs_dir}")
    res = subprocess.run([PYTHON_EXE, os.path.join("scripts", "make_test_packs.py"),
                          str(FIXTURE_COUNT), "--dir", packs_dir],
                         cwd=PROJECT_ROOT, capture_output=True, text=True, env=env)
    if res.returncode != 0:
        print(f"  [FAIL] make_test_packs.py failed:\n{res.stderr}\n{res.stdout}")
        return False
    print("  [OK]  Fixture packs generated")
    return True

def write_test_config(home, packs_dir):
    """Points the isolated ~/.dubmate/config.json at the temp fixture packs."""
    cfg_dir = os.path.join(home, ".dubmate")
    os.makedirs(cfg_dir, exist_ok=True)
    with open(os.path.join(cfg_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"packs_dir": packs_dir}, f)

def _rmtree(path):
    """rmtree that clears read-only bits (Windows) and leaves locked files behind instead of failing."""
    def onerror(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=onerror)
    else:
        shutil.rmtree(path, onerror=onerror)

def sweep_stale_runs(max_age_hours=6):
    """Removes run folders left by earlier runs that were killed before their own cleanup.

    A full run takes minutes, so a folder this old belongs to no live run.
    """
    cutoff = time.time() - max_age_hours * 3600
    for path in glob.glob(os.path.join(tempfile.gettempdir(), RUN_DIR_PREFIX + "*")):
        try:
            if os.path.isdir(path) and os.path.getmtime(path) < cutoff:
                _rmtree(path)
        except OSError:
            pass

def test_python_suites(env, home, packs_dir):
    print_header("Phase 5: Deep Backend, DSP, Packaging & Multiplayer Test Suites")
    results = []
    for script_path in sorted(glob.glob(os.path.join(TESTS_DIR, "test_*.py"))):
        script = os.path.basename(script_path)
        # Every suite starts from the same config: some suites rewrite packs_dir.
        write_test_config(home, packs_dir)
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

    sweep_stale_runs()
    tmp = tempfile.mkdtemp(prefix=RUN_DIR_PREFIX)
    try:
        home = os.path.join(tmp, "home")
        cache = os.path.join(tmp, "cache")
        packs = os.path.join(tmp, "Packs")
        child_tmp = os.path.join(tmp, "tmp")
        for d in (home, cache, packs, child_tmp):
            os.makedirs(d)
        # DUBMATE_EXPORTS_DIR is deliberately not set: it overrides the configured
        # export folder and would make that setting untestable. Exports default to
        # <cache>/exports, which is already isolated.
        # TMP/TEMP/TMPDIR send every temp file a suite (or the engine under test)
        # creates into this run's folder, so it is removed with the rest below.
        env = dict(os.environ, USERPROFILE=home, HOME=home, DUBMATE_CACHE_DIR=cache,
                   TMP=child_tmp, TEMP=child_tmp, TMPDIR=child_tmp)
        env.pop("DUBMATE_EXPORTS_DIR", None)

        py_pass, py_fail = test_python_syntax()
        js_pass, js_fail = test_javascript_syntax(env)
        fe_pass, fe_dur = test_frontend_suite(env)
        wk_pass, wk_dur = test_worker_suite(env)
        fixtures_ok = make_fixture_packs(packs, env)
        py_results = test_python_suites(env, home, packs) if fixtures_ok else []
    finally:
        _rmtree(tmp)

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
