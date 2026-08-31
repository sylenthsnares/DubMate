# -*- coding: utf-8 -*-
"""
test_sidecar_names.py
Keeps the sidecar names in main.rs consistent with what the bundler actually ships.

The bug this guards was expensive and completely silent. tauri.conf.json declares
the external binary as "sidecar/cloudflared", and main.rs asked for it at runtime
under that same string. The bundler does not preserve that directory -- it flattens
external binaries next to the executable -- so the shipped file was
`<app dir>/cloudflared.exe` while the lookup asked for
`<app dir>/sidecar/cloudflared.exe`.

The call failed on every launch of every install. It sat inside `if let Ok(..)`
with no else, so nothing reported it: the tunnel never started, room codes were
never published to the registry, and no guest could ever join a room. Confirmed on
a real install by creating `<app dir>/sidecar/cloudflared.exe` by hand, after which
cloudflared spawned within ten seconds and the full join path worked.

A unit test cannot bundle an installer, but it can check the one thing that was
wrong: the name asked for at runtime must match the file name that gets shipped.
"""

import json
import os as _os
import re
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

PROJECT_ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
TAURI_CONF = _os.path.join(PROJECT_ROOT, "tauri", "src-tauri", "tauri.conf.json")
MAIN_RS = _os.path.join(PROJECT_ROOT, "tauri", "src-tauri", "src", "main.rs")

# `app.shell().sidecar("<name>")`
SIDECAR_CALL = re.compile(r'\.sidecar\(\s*"([^"]+)"\s*\)')
# The cloudflared lookup iterates a named list rather than passing a literal,
# so collect the names out of that const as well.
SIDECAR_NAME_CONST = re.compile(r'const\s+\w*SIDECAR_NAMES\s*:[^=]+=\s*\[([^\]]+)\]')


def _all_requested_names(source):
    names = list(SIDECAR_CALL.findall(source))
    for block in SIDECAR_NAME_CONST.findall(source):
        names.extend(re.findall(r'"([^"]+)"', block))
    return names


def _declared_binaries():
    with open(TAURI_CONF, "r", encoding="utf-8") as f:
        conf = json.load(f)
    external = conf.get("bundle", {}).get("externalBin", [])
    assert external, "tauri.conf.json declares no externalBin entries"
    # The bundler ships each entry under its file name, next to the executable.
    return {entry.rsplit("/", 1)[-1] for entry in external}, external


def test_every_sidecar_lookup_matches_a_shipped_binary():
    shipped, declared = _declared_binaries()

    with open(MAIN_RS, "r", encoding="utf-8") as f:
        source = f.read()

    requested = _all_requested_names(source)
    assert requested, "no .sidecar(...) calls found -- has the API changed?"

    bad = []
    for name in requested:
        # A lookup is fine if it uses the shipped file name, or if it is one of a
        # pair of fallbacks where at least the flattened form is present.
        if name.rsplit("/", 1)[-1] not in shipped:
            bad.append(name)

    assert not bad, (
        "these .sidecar() names do not correspond to any bundled binary: "
        f"{bad}\n  externalBin declares: {declared}\n"
        f"  which ship as: {sorted(shipped)}"
    )
    print(f"[PASS] all {len(requested)} sidecar lookups match a shipped binary {sorted(shipped)}")


def test_cloudflared_is_requested_by_its_flattened_name():
    """
    The flattened name is the one the bundler actually produces. Requesting only
    the declared path is what broke every install.
    """
    with open(MAIN_RS, "r", encoding="utf-8") as f:
        source = f.read()
    requested = _all_requested_names(source)

    cloudflared_lookups = [n for n in requested if n.rsplit("/", 1)[-1] == "cloudflared"]
    assert cloudflared_lookups, "nothing looks up the cloudflared sidecar any more"
    assert "cloudflared" in cloudflared_lookups, (
        "cloudflared is only requested by a prefixed path "
        f"({cloudflared_lookups}); the bundler ships it flattened, so this "
        "resolves to a file that does not exist and the tunnel never starts"
    )
    print("[PASS] cloudflared is requested by the name the bundler ships")


def test_the_tunnel_failure_path_is_not_silent():
    """
    The reason this went unnoticed for so long: the failure had no else branch.
    Any future rewrite must still report it.
    """
    with open(MAIN_RS, "r", encoding="utf-8") as f:
        source = f.read()

    assert "fn report_tunnel_failure" in source, \
        "report_tunnel_failure is gone; a tunnel that cannot start would be silent again"
    # Roughly: the resolver, the spawn, the early exit and the watchdog.
    reports = source.count("report_tunnel_failure(")
    assert reports >= 4, (
        f"only {reports} call sites report a tunnel failure; the known failure modes are "
        "missing binary, failed spawn, early exit, and never publishing a URL"
    )
    print(f"[PASS] tunnel failures are reported from {reports} call sites")


if __name__ == "__main__":
    test_every_sidecar_lookup_matches_a_shipped_binary()
    test_cloudflared_is_requested_by_its_flattened_name()
    test_the_tunnel_failure_path_is_not_silent()
    print("\n[OK] Sidecar name suite passed")
