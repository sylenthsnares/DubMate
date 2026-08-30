# -*- coding: utf-8 -*-
"""
run_tunnel.py
Starts a cloudflared quick tunnel in front of the local DubMate engine, echoes its
output so the user still sees the public URL, and -- the part that matters -- posts
that URL back to the engine's /api/tunnel endpoint.

Without this step ACTIVE_TUNNEL_URL stays None, so no room code is ever published to
the public registry and guests get "Room not found or expired" for a code the host is
staring at. The desktop app does the same notification from Rust; this covers the
batch/shell launchers used when running from a source checkout.

Usage:
    python scripts/run_tunnel.py --cloudflared tools/cloudflared.exe --port 8000
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

TUNNEL_URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

# The engine is normally already up by the time we start, but the launchers only
# sleep a few seconds before handing over, so tolerate it still binding.
NOTIFY_ATTEMPTS = 10
NOTIFY_BACKOFF_SECONDS = 2


def notify_engine(port: int, tunnel_url: str) -> bool:
    """Posts the tunnel URL to the local engine, retrying a few times."""
    endpoint = f"http://127.0.0.1:{port}/api/tunnel"
    payload = json.dumps({"tunnel_url": tunnel_url}).encode("utf-8")

    for attempt in range(1, NOTIFY_ATTEMPTS + 1):
        req = urllib.request.Request(
            endpoint,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                if 200 <= resp.status < 300:
                    print(f"[DubMate] Public tunnel registered with the engine: {tunnel_url}")
                    return True
                print(f"[DubMate] Engine rejected tunnel notice ({resp.status}), attempt {attempt}/{NOTIFY_ATTEMPTS}")
        except (urllib.error.URLError, OSError) as ex:
            print(f"[DubMate] Could not reach the engine ({ex}), attempt {attempt}/{NOTIFY_ATTEMPTS}")
        time.sleep(NOTIFY_BACKOFF_SECONDS)

    print(
        f"[DubMate] Gave up telling the engine about {tunnel_url}. Room codes will not "
        f"be published; share the tunnel link directly instead."
    )
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Run cloudflared and register the tunnel with DubMate.")
    parser.add_argument("--cloudflared", required=True, help="Path to the cloudflared binary")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DUBMATE_PORT") or 8000))
    args = parser.parse_args()

    if not os.path.isfile(args.cloudflared):
        print(f"[ERROR] cloudflared not found at {args.cloudflared}")
        return 1

    target = f"http://127.0.0.1:{args.port}"
    print(f"[DubMate] Opening a public tunnel to {target} ...")

    proc = subprocess.Popen(
        [args.cloudflared, "tunnel", "--url", target],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    reported = None
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            match = TUNNEL_URL_RE.search(line)
            if match and match.group(0) != reported:
                reported = match.group(0)
                # Off the read loop so cloudflared's output keeps streaming while
                # the notification retries.
                threading.Thread(
                    target=notify_engine,
                    args=(args.port, reported),
                    daemon=True,
                ).start()
    except KeyboardInterrupt:
        pass
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    return proc.returncode or 0


if __name__ == "__main__":
    sys.exit(main())
