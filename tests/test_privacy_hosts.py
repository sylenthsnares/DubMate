# -*- coding: utf-8 -*-
"""
test_privacy_hosts.py
Every https:// host the shipped code talks to is named in PRIVACY.md, so a new
online destination can't land without the privacy notice saying so.
"""

import os
import re
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRIVACY = os.path.join(PROJECT_ROOT, "PRIVACY.md")

SHIPPED_FILES = ["app.py", "pack_builder.py", "pack_loader.py", "audio_processor.py"]
SHIPPED_DIRS = [("dubmate", (".py",)), ("static", (".html", ".js", ".css"))]
RUST_DIR = os.path.join("tauri", "src-tauri", "src")

# Hosts in shipped code that DubMate never contacts itself.
NOT_CONTACTED = {
    "www.youtube.com",  # the Pack Builder's link field placeholder
}

HOST = re.compile(r"https://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _strip_rust_tests(source):
    """Drops `#[cfg(test)]` items (test modules and test-only functions)."""
    out = []
    i = 0
    marker = "#[cfg(test)]"
    while True:
        j = source.find(marker, i)
        if j < 0:
            out.append(source[i:])
            break
        out.append(source[i:j])
        brace = source.find("{", j)
        semi = source.find(";", j)
        if brace < 0 or (0 <= semi < brace):
            i = semi + 1  # `#[cfg(test)] use ...;`
            continue
        depth = 0
        k = brace
        while k < len(source):
            if source[k] == "{":
                depth += 1
            elif source[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        i = k + 1
    return "".join(out)


def _shipped_sources():
    for name in SHIPPED_FILES:
        yield name, _read(os.path.join(PROJECT_ROOT, name))
    for folder, exts in SHIPPED_DIRS:
        for root, dirs, files in os.walk(os.path.join(PROJECT_ROOT, folder)):
            dirs[:] = [d for d in dirs if d not in ("__pycache__", "node_modules")]
            for name in sorted(files):
                if name.endswith(exts):
                    path = os.path.join(root, name)
                    yield os.path.relpath(path, PROJECT_ROOT), _read(path)
    rust = os.path.join(PROJECT_ROOT, RUST_DIR)
    for name in sorted(os.listdir(rust)):
        if name.endswith(".rs"):
            yield os.path.join(RUST_DIR, name), _strip_rust_tests(_read(os.path.join(rust, name)))


def _hosts():
    found = {}
    for rel, text in _shipped_sources():
        for host in HOST.findall(text):
            found.setdefault(host.lower(), set()).add(rel.replace(os.sep, "/"))
    return found


def test_rust_test_modules_are_skipped():
    src = 'fn a() { x("https://kept.example") }\n#[cfg(test)]\nmod tests {\n fn b() { "https://gone.example"; { } }\n}\n'
    stripped = _strip_rust_tests(src)
    assert "kept.example" in stripped and "gone.example" not in stripped
    print("[PASS] #[cfg(test)] modules are left out")


def test_every_contacted_host_is_named_in_privacy():
    privacy = _read(PRIVACY).lower()
    hosts = _hosts()
    assert "dubmate.bkaproductions.com" in hosts and "api.github.com" in hosts, \
        "the host scan found nothing; check SHIPPED_FILES"
    missing = {h: sorted(files) for h, files in hosts.items()
               if h not in NOT_CONTACTED and h not in privacy}
    assert not missing, f"PRIVACY.md doesn't name these hosts the app uses: {missing}"
    print(f"[PASS] {len(hosts)} hosts in shipped code are named in PRIVACY.md")


if __name__ == "__main__":
    test_rust_test_modules_are_skipped()
    test_every_contacted_host_is_named_in_privacy()
    print("\n[OK] Privacy hosts suite passed")
    sys.exit(0)
