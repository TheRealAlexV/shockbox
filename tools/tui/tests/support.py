"""Shared test rig, importable as ``from support import ...`` from every test module.

Why this module exists and why it is not ``conftest``: test modules that import helpers from
``conftest`` by module name are fragile. ``conftest`` is loaded by pytest under a name pytest
chooses, and a plugin or a collection order can leave a *second*, partially-initialised copy of
that module in ``sys.modules`` — which is how ``NameError: MOCK_ENV`` happens. A plain sibling
module has one name, one load, no plugin involvement.

The rig: a fake install whose ``server.mjs`` *is* a Node launcher for the Python stub.

Why node and not a Python file named server.mjs: the supervisor spawns ``server.mjs`` with
``node`` (as the real launcher does), so the process tree, the pipe capture and the signal path
are the production ones. A file named ``server.mjs`` holding Python would only be executed by
accident on a machine where ``node`` is a Python shim — which is exactly what hid a real failure
once. Here ``server.mjs`` is valid JavaScript that runs the stub and waits for it.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

TESTS = Path(__file__).resolve().parent
STUB = TESTS / "stub_server.py"

# The adoption evidence override (see `shockbox_tui.supervisor._mock_server_pid`).
MOCK_ENV = "SHOCKBOX_TUI_TEST_MOCK_SERVER"


def mock_server(server_pid: int, app_dir: Path) -> str:
    """One line of SHOCKBOX_TUI_TEST_MOCK_SERVER: 'treat this pid as <app-dir>/server.mjs'."""
    return json.dumps(
        {
            "app_dir": str(Path(app_dir).resolve()),
            "argv0": str(Path(app_dir) / "server.mjs"),
            "server_pid": int(server_pid),
        }
    )


def free_port() -> int:
    """Bind port 0 and read it back. Never 8972."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_until(predicate, timeout: float = 15.0, interval: float = 0.05):
    """Poll ``predicate`` until it returns something truthy; False on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return False


def wait_status(status_of, state: str | None = None, key: str | None = None, minimum: int | None = None, timeout: float = 20.0):
    """Wait for a status condition and return the *dict*, or None on timeout.

    Written out longhand (no walrus inside a conditional) so a lambda's scope can never turn a
    timeout into an exception, and so a failure can print the status that was actually there.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = status_of()
        if state is not None and status.get("state") != state:
            time.sleep(0.05)
            continue
        if key is not None and int(status.get(key) or 0) < int(minimum or 1):
            time.sleep(0.05)
            continue
        return status
    return None


def _js(value: str) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def write_stub_launcher(
    app_dir: Path,
    port: int,
    *,
    mode: str = "normal",
    crash_after: float = 0,
    pid_file: Path | None = None,
) -> None:
    """Write ``<app_dir>/server.mjs``: node starts the stub and stays alive as its launcher."""
    extra = ["--mode", mode]
    if crash_after:
        extra += ["--crash-after", str(crash_after)]
    if pid_file:
        extra += ["--pid-file", str(pid_file)]
    args = ["--port", str(port), *extra]
    js_list = ", ".join(_js(a) for a in args)
    (app_dir / "server.mjs").write_text(
        "// Test stand-in for the real server.mjs: node starts the Python stub and stays alive\n"
        "// as its launcher. `await` at top level is the point: a finished module script lets\n"
        "// node's event loop drain, and node would then exit on its own before the supervisor\n"
        "// ever sends it a signal.\n"
        "import { spawn } from 'node:child_process';\n"
        f"const child = spawn({_js(sys.executable)}, [{_js(str(STUB))}, {js_list}], {{ stdio: 'inherit' }});\n"
        "const fwd = (s) => () => { try { child.kill(s); } catch {} };\n"
        "process.on('SIGTERM', fwd('SIGTERM'));\n"
        "process.on('SIGINT', fwd('SIGINT'));\n"
        "const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c === null ? 1 : c)));\n"
        "process.exit(code);\n",
        encoding="utf-8",
    )


def alive(pid: int | None) -> bool:
    """Process exists and is not a zombie.

    A killed-but-unreaped child still has a pid, so ``os.kill(pid, 0)`` alone would call it alive
    until pytest exits; ``/proc/<pid>/stat`` state ``Z`` is the POSIX way to tell.
    """
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    if sys.platform != "win32":
        try:
            state = Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()[0]
            return state != "Z"
        except (OSError, IndexError):
            return True
    return True


def listeners(port: int) -> list[int]:
    """Live pids listening on ``port`` (sorted)."""
    from shockbox_tui.supervisor import listener_pids

    return sorted(p for p in listener_pids(port) if alive(p))


def supervisor_command(ctl, *extra: str) -> list[str]:
    """The argv that runs the supervisor module for ``ctl``'s app dir / runtime dir / port."""
    return [sys.executable, "-m", "shockbox_tui.supervisor", *ctl.supervisor_argv()[3:], *extra]


def supervisor_env(**overrides: str) -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
    env.update(overrides)
    return env


def start_supervisor(ctl, *extra: str, env: dict | None = None, **env_overrides: str) -> subprocess.Popen:
    """Start a supervisor process directly (not via Control), as a test would on the rig."""
    merged = supervisor_env(**env_overrides)
    merged.update(env or {})
    return subprocess.Popen(
        supervisor_command(ctl, *extra),
        cwd=str(ctl.paths.app_dir),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env=merged,
    )


def force_kill(pid: int | None) -> None:
    if pid and alive(pid):
        try:
            os.kill(int(pid), signal.SIGKILL)
        except OSError:
            pass
