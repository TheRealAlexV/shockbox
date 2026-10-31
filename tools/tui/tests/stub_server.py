"""A stand-in for ``server.mjs`` used by the tests, on purpose *outside* ``shockbox_tui``.

It speaks just enough of the real app's surface for the supervisor and the HTTP client to be
exercised for real: it takes the same flags, binds the port, answers ``/health`` in the shape of
``core/server-http.mjs``, serves a two-key ``/api/core/settings`` with PATCH, and writes one
line to stdout so the log-capture path has bytes that did not come from node.

Behaviours selected by ``--mode``:

    normal   (default) run until SIGTERM; /health up; writes its pid to ``--pid-file``
    crash    print a line and exit 3 immediately (the backoff path)

``--crash-after N`` exits 3 after N seconds, which is an *unexpected* exit from the
supervisor's point of view (no command asked for it).
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULTS = {"compatPort": 0, "forceScenes": ["Desktop"], "publicUrl": "", "obsUrl": "ws://127.0.0.1:4455"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--state", default=None)
    ap.add_argument("--log-dir", default=None)
    ap.add_argument("--sounds", default=None)
    ap.add_argument("--pid-file", default=None)
    ap.add_argument("--mode", default="normal")
    ap.add_argument("--crash-after", type=float, default=0)
    args = ap.parse_args()

    print(f"stub: pid {os.getpid()} on port {args.port} mode {args.mode}", flush=True)
    if args.mode == "crash":
        print("stub: crashing on purpose", flush=True)
        _write_pid(args.pid_file)
        return 3

    settings = dict(DEFAULTS, publicUrl=f"http://127.0.0.1:{args.port}")
    started = time.time()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *_args):  # keep the stdout merge readable
            return

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                return self._send(
                    200,
                    {
                        "ok": True,
                        "service": "shockbox",
                        "version": "0.0-stub",
                        "pid": os.getpid(),
                        "port": args.port,
                        "clients": 0,
                        "channels": {},
                        "modules": {"wall": "up", "notifications": "up"},
                        "obs": {"state": "off", "scene": None},
                        "uptime": round(time.time() - started),
                    },
                )
            if self.path == "/api/core/settings":
                return self._send(
                    200,
                    {"ok": True, "settings": {k: {"type": "number", "label": k, "value": v} for k, v in settings.items()}},
                )
            if self.path == "/api/modules":
                return self._send(200, {"ok": True, "modules": [{"id": "wall", "status": "up"}]})
            return self._send(404, {"ok": False, "error": "no route"})

        def do_PATCH(self):  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return self._send(400, {"ok": False, "error": "bad json"})
            if self.path == "/api/core/settings":
                changed = []
                for key, value in body.items():
                    if key not in settings:
                        return self._send(400, {"ok": False, "error": f'unknown setting "{key}"'})
                    if settings[key] != value:
                        settings[key] = value
                        changed.append(key)
                return self._send(200, {"ok": True, "changed": changed, "settings": settings})
            return self._send(404, {"ok": False, "error": "no route"})

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    _write_pid(args.pid_file)
    print("stub: listening", flush=True)

    stop = threading.Event()

    def on_signal(_signum, _frame):
        stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    deadline = time.monotonic() + args.crash_after if args.crash_after else None
    while not stop.is_set():
        if deadline is not None and time.monotonic() >= deadline:
            print("stub: crash-after elapsed, exiting 3", flush=True)
            server.shutdown()
            return 3
        stop.wait(0.05)
    print("stub: shutting down", flush=True)
    server.shutdown()
    return 0


def _write_pid(path: str | None) -> None:
    if not path:
        return
    try:
        with open(path, "w", encoding="ascii") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main())
