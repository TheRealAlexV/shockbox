"""The detached supervisor: owns the node process, restarts it, writes what it sees.

Run it (usually via :class:`shockbox_tui.control.Control`, which detaches it)::

    python -m shockbox_tui.supervisor --app-dir C:/OBS/ShockBox --port 8972

It replaces ``deploy/run.cmd`` as the launcher, and it survives the TUI: the TUI is only a
viewer, so closing the TUI window does not take ShockBox down. That is why this is a separate
process and not a thread — a thread dies with its parent.

Files it owns, all under the runtime dir (see ``paths.py``)::

    supervisor.lock   OS-level exclusive lock. Held by flock/LockFileEx for as long as this
                      process lives; the kernel drops it on any death, so a stale lock after a
                      crash simply is not there. Not a pid heuristic.
    status.json       {pid, port, state, since, restarts, last_exit, last_error, node_pid,
                       adopted, health, next_restart_at}. Rewritten on every change and at
                      least every 2s (heartbeat). Atomic replace; the UI only ever reads it.
    cmd.json          Command channel. The UI writes {"id","action"} atomically
                      (tmp + os.replace); this process polls, executes and deletes. Deletion is
                      the acknowledgement. A command never waits on the supervisor, so it can
                      never wedge the UI.
    supervisor.log    This process's own stdout/stderr (crash before status.json exists).

Actions (idempotent by construction — `start` while running is a no-op, `stop` while stopped
is a no-op):

    start      start node if it is not running (after `stop`, this is the way back)
    stop       stop node; supervisor stays, state `stopped`, no auto-restart
    restart    stop node if needed, reset backoff, start now
    shutdown   stop node, state `stopped`, exit the supervisor

Log capture: node's stdout and stderr are merged into ``<app-dir>/logs/shockbox-<local
date>.log`` through :class:`shockbox_tui.logtail.LogFile` — the same 8 MiB generations
``core/log.mjs`` writes, because both writers share one file.

Orphans: before spawning, whoever listens on the port is inspected. If its command line runs
``<app-dir>/server.mjs`` (the evidence rule of ``deploy/install.ps1``) it is adopted when
``/health`` answers with that same pid, and stopped otherwise. Only then is a node spawned.
"""

from __future__ import annotations

import argparse
import atexit
import datetime as _dt
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from pathlib import Path
from typing import Any

from . import apiclient
from .logtail import LogFile
from .paths import HEARTBEAT_STALE_S, Paths

# The restart policy of deploy/run.cmd, unchanged: 2s, 4s, 8s, 16s, 30s, 60s, then 60s while
# crashes keep coming; a run that lasts HEALTHY_S resets it.
BACKOFF_SEQUENCE = (2, 4, 8, 16, 30, 60)
HEALTHY_S = 300.0

STATUS_INTERVAL = 2.0  # heartbeat, so a UI can detect a wedged supervisor
CMD_INTERVAL = 0.25
HEALTH_INTERVAL = 2.0
STOP_GRACE_S = 8.0  # SIGTERM/CTRL_BREAK, then kill
STALE_CMD_S = 120.0

STATES = ("starting", "running", "backoff", "stopped", "failed")


def now_iso() -> str:
    """UTC ISO-8601, seconds precision: what a machine reads (log timestamps are UTC too)."""
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            # No fsync: readers are protected by the atomic replace below, not by durability
            # across a power cut (a runtime dir is rebuilt on the next start anyway), and the
            # fsync of a 700-byte heartbeat was 3.6 ms/s of the idle supervisor on the rig.
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# ---------------------------------------------------------------------------------------------
# OS probes. Everything that differs between Windows and POSIX is in this section.
# ---------------------------------------------------------------------------------------------


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        if sys.platform == "win32":
            # OpenProcess right is enough evidence; os.kill(p, 0) on Windows *terminates*.
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            ERROR_ACCESS_DENIED = 5
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                # Access denied is *evidence of a live pid we may not inspect*, not evidence of
                # death: a non-elevated TUI cannot open a SYSTEM supervisor, and treating that
                # as "dead" was what made it unlink a live supervisor's pid file (and fail to
                # adopt a live node). Owner-agnostic: alive, just not readable.
                return k32.GetLastError() == ERROR_ACCESS_DENIED
            exit_code = ctypes.c_ulong(0)
            ok = k32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            k32.CloseHandle(handle)
            return bool(ok) and exit_code.value == 259  # STILL_ACTIVE
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def _proc_cmdline(pid: int) -> str:
    """Command line of ``pid`` as one string, or '' when it cannot be read."""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            k32 = ctypes.windll.kernel32
            handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return ""
            try:
                size = wintypes.DWORD(4096)
                buf = ctypes.create_unicode_buffer(size.value)
                if not k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    return ""
                return buf.value
            finally:
                k32.CloseHandle(handle)
        except Exception:
            return ""
    try:
        raw = Path(f"/proc/{int(pid)}/cmdline").read_bytes()
    except OSError:
        return ""
    return raw.replace(b"\x00", b" ").decode("utf-8", "replace").strip()


def listener_pids(port: int) -> list[int]:
    """Pids with a TCP socket in LISTEN on ``port``.

    Windows: ``GetExtendedTcpTable`` (ships with the OS, no PowerShell spawn). POSIX: listen
    sockets are matched by inode from ``/proc/net/tcp{,6}``, the only portable-enough source
    without a dependency; a missing ``/proc`` yields [] and the supervisor falls back to
    /health evidence.
    """
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            AF_INET, AF_INET6 = 2, 23
            TCP_TABLE_OWNER_PID_LISTENER = 3
            iphlpapi = ctypes.windll.iphlpapi
            found: list[int] = []
            for af in (AF_INET, AF_INET6):
                size = wintypes.DWORD(0)
                iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, af, TCP_TABLE_OWNER_PID_LISTENER, 0)
                if size.value == 0:
                    continue
                buf = ctypes.create_string_buffer(size.value)
                rc = iphlpapi.GetExtendedTcpTable(buf, ctypes.byref(size), False, af, TCP_TABLE_OWNER_PID_LISTENER, 0)
                if rc != 0:
                    continue
                count = ctypes.cast(buf, ctypes.POINTER(wintypes.DWORD)).contents.value
                offset = ctypes.sizeof(wintypes.DWORD)
                # MIB_TCPROW_OWNER_PID: state, local addr, local port, remote addr, remote
                # port, owning pid — all DWORDs, 24 bytes. MIB_TCP6ROW_OWNER_PID is 56 bytes.
                row = 24 if af == AF_INET else 56
                port_offsets = (8,) if af == AF_INET else (20,)
                for i in range(count):
                    base = offset + i * row
                    addr = ctypes.cast(buf, ctypes.c_void_p).value + base
                    local_port = wintypes.DWORD.from_address(addr + port_offsets[0]).value
                    local_port = ((local_port & 0xFF) << 8) | (local_port >> 8)
                    owner = wintypes.DWORD.from_address(addr + row - 4).value
                    if local_port == port and owner not in found:
                        found.append(owner)
            return found
        except Exception:
            return []
    inodes = _listen_inodes(port)
    if not inodes:
        return []
    pids: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        fd_dir = entry / "fd"
        try:
            fds = list(fd_dir.iterdir())
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if target.startswith("socket:[") and target[8:-1] in inodes:
                pids.append(int(entry.name))
                break
    return pids


def _listen_inodes(port: int) -> set[str]:
    inodes: set[str] = set()
    for name in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(name).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10:
                continue
            # st is column 3; 0A == TCP_LISTEN. local_address is HEXIP:HEXPORT.
            if parts[3] != "0A":
                continue
            try:
                local_port = int(parts[1].rsplit(":", 1)[1], 16)
            except (IndexError, ValueError):
                continue
            if local_port == port:
                inodes.add(parts[9])
    return inodes


def shockbox_health(port: int, pid: int | None = None) -> dict:
    """``/health`` that belongs to ``pid`` and answers as a ShockBox server, else ``{}``.

    Owner-agnostic identity: HTTP needs no cross-account process access, so this is the one
    probe that works when the listener runs as SYSTEM and its command line is unreadable.
    ``service: shockbox`` is required as well as the pid — a stranger that happens to expose a
    pid is not ours, so "cannot inspect" never turns into "it is ours".
    """
    try:
        data = apiclient.ApiClient(port, timeout=2.0).health()
    except (apiclient.ApiError, apiclient.ApiUnreachable):
        return {}
    if not isinstance(data, dict):
        return {}
    if str(data.get("service") or "").lower() != "shockbox":
        return {}
    if pid is not None and int(data.get("pid") or 0) != int(pid):
        return {}
    return data


def is_our_server(pid: int, app_dir: Path, port: int | None = None) -> bool:
    """The install.ps1 Test-IsOurs rule, owner-agnostic.

    POSIX: the command line names ``<app-dir>/server.mjs`` (absolute, or relative to that
    process's own cwd). A server this launcher did not start itself (an adoption candidate)
    must pass this. Windows cannot read another process's command line without WMI/CIM, and a
    SYSTEM process's command line is unreadable to the installing account, so there the
    evidence is the listener pid answering ``/health`` with a ShockBox payload — only after the
    port was already confirmed to belong to that pid. A stranger still fails: wrong pid or no
    ``service: shockbox``. Without a port (a hint-only caller) the old Windows leniency stays.
    """
    mock = _mock_server_pid(pid, app_dir)
    if mock is not None:
        return True
    line = _proc_cmdline(pid)
    if line and sys.platform != "win32":
        server_name = "server.mjs"
        lowered = line.replace("\\", "/").lower()
        if server_name not in lowered:
            return False
        app = app_dir.resolve()
        absolute = str(app).replace("\\", "/").lower() + "/" + server_name
        if absolute in lowered:
            return True
        # `node server.mjs` with the cwd set to the app dir: the brief's evidence as a relative
        # invocation. Resolve it against the process's own cwd, not ours.
        try:
            cwd = Path(os.readlink(f"/proc/{int(pid)}/cwd")).resolve()
        except OSError:
            cwd = None
        if cwd is not None:
            try:
                return (cwd / server_name).resolve() == (app / server_name).resolve()
            except OSError:
                pass
    # Windows image name, or an unreadable command line: ask the port itself. This is also the
    # cross-account case (SYSTEM node), where /health is readable but the process is not.
    if port is not None:
        return bool(shockbox_health(port, pid))
    return sys.platform == "win32" and bool(line)


def is_supervisor_process(pid: int | None, runtime_dir: Path | None = None) -> bool:
    """True when ``pid`` is alive *and* this runtime dir's supervisor, whoever owns it.

    A pid file is a hint, never proof: it outlives its writer (SIGKILL, or a machine that was
    rebooted) and the OS reuses pids, so trusting the number alone reported a supervisor that
    did not exist. Identity is now taken from evidence that works for every owner: the pid is
    alive and the supervisor's heartbeat is fresh, with ``status.json`` naming the same pid when
    it names one. The command line is only a fallback when no runtime dir is given: on Windows
    a SYSTEM supervisor's command line is unreadable to the installing account, and requiring
    it turned "cannot inspect" into "not ours" — which unlinked a live supervisor's pid file.
    A stale heartbeat still fails, so a pid reused after a crash is not adopted.
    """
    if not pid_alive(pid):
        return False
    if runtime_dir is not None:
        try:
            age = time.time() - (runtime_dir / "heartbeat").stat().st_mtime
        except OSError:
            return False
        if age > HEARTBEAT_STALE_S:
            return False
        named = read_json(runtime_dir / "status.json").get("supervisor_pid")
        try:
            return not named or int(named) == int(pid)
        except (TypeError, ValueError):
            return False
    line = _proc_cmdline(int(pid))
    if not line:
        return True
    if sys.platform == "win32":
        # QueryFullProcessImageNameW gives the image, not the argv (`-m shockbox_tui...`).
        return line.rsplit("\\", 1)[-1].lower().startswith("python")
    return "shockbox_tui" in line


def _mock_server_pid(pid: int, app_dir: Path) -> int | None:
    """Tests only: ``SHOCKBOX_TUI_TEST_MOCK_SERVER``, one JSON object per line.

    The adoption rule needs the listening process's command line to *be* ``<app-dir>/server.mjs``.
    The suite's stub is node in front of a Python server, so the listener never matches — correct
    for production, and untestable as written. This override is honest about what it replaces: it
    names which pid counts as "this install's server". Everything else in the adoption path (the
    listener lookup, liveness, /health pid equality, no second spawn) still runs for real.
    """
    raw = os.environ.get("SHOCKBOX_TUI_TEST_MOCK_SERVER")
    if not raw:
        return None
    app = str(app_dir.resolve())
    for entry in raw.splitlines():
        try:
            row = json.loads(entry)
        except ValueError:
            continue
        if row.get("app_dir") != app:
            continue
        try:
            if Path(row["argv0"]).resolve() != (app_dir / "server.mjs").resolve():
                continue
        except (KeyError, OSError):
            continue
        if int(row.get("server_pid") or 0) == int(pid):
            return int(pid)
    return None


def _descendants(pid: int) -> list[int]:
    """Every live descendant of ``pid`` (breadth-first, children after parents). POSIX only."""
    if sys.platform == "win32":
        return []
    children: dict[int, list[int]] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            # stat: pid (comm) state ppid ... — split after the parenthesised comm.
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            parent = int(fields[1])
        except (OSError, IndexError, ValueError):
            continue
        children.setdefault(parent, []).append(int(entry.name))
    out: list[int] = []
    queue = [int(pid)]
    while queue:
        current = queue.pop(0)
        for child in children.get(current, []):
            out.append(child)
            queue.append(child)
    return out


def terminate(pid: int, grace_s: float = STOP_GRACE_S) -> bool:
    """Ask politely, then insist. Returns True when the *whole tree* is gone.

    On POSIX the child is started in its own session, so signalling the pid is safe: node does
    not share the supervisor's group and a Ctrl-C in a terminal cannot reach it — which is also
    why nothing here calls ``killpg`` on a group it did not create. Node may run the server by
    *delegating* to another process (a launcher script, or a wrapper), and that child is in no
    group of ours either: it is found by walking the process tree, bottom-up, so a wrapper never
    outlives its server.
    """
    if not pid_alive(pid):
        return True
    tree = _descendants(pid)
    if sys.platform == "win32":
        # /T takes the tree: node can delegate on Windows too.
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=max(5.0, grace_s),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError:
            pass
        deadline = time.monotonic() + grace_s
        while time.monotonic() < deadline and pid_alive(pid):
            time.sleep(0.05)
        if pid_alive(pid):
            try:
                os.kill(int(pid), signal.SIGKILL)
            except OSError:
                pass
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and pid_alive(pid):
        time.sleep(0.05)
    # Children first, deepest last: a wrapper that exits in response to its child's exit is not
    # forced; one that ignores the signal anyway gets the same treatment.
    for child_pid in reversed(tree):
        if pid_alive(child_pid):
            terminate(child_pid, grace_s)
    return not pid_alive(pid)


def take_lock(path: Path):
    """Exclusive OS lock on ``path``; returns a handle, or None when another holder exists.

    flock on POSIX, LockFileEx on Windows. The handle must stay referenced for the life of the
    process: the lock is released by the kernel when the handle closes *or the process dies*,
    which is the whole point — a SIGKILL cannot leave the lock behind.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        import ctypes
        import msvcrt

        fh = open(path, "a+b")
        try:
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            fh.close()
            return None
        return fh
    import fcntl

    fh = open(path, "a+b")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return None
    return fh


LIFE_MAX_BYTES = 2 * 1024 * 1024  # ~2 MB per file
LIFE_KEEP = 1  # one rotated generation: supervisor.log + supervisor.log.1

def lifecycle_log(paths: Paths) -> LogFile | None:
    """The supervisor's own history: ``runtime/supervisor.log``, 2 MB, two files.

    Same file the launcher redirects our stdout/stderr into, so an OS-level crash and a
    lifecycle line land side by side. Never raises: a supervisor that cannot log is still a
    supervisor, and losing the log must not be the thing that takes ShockBox down.
    """
    try:
        return LogFile(paths.runtime_dir, name="supervisor.log", max_bytes=LIFE_MAX_BYTES, keep=LIFE_KEEP)
    except Exception:
        return None

def life_note(life: LogFile | None, message: str) -> None:
    """One timestamped lifecycle line. Swallows every error, including a full disk."""
    if life is None:
        return
    stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        life.write(f"{stamp} supervisor[{os.getpid()}]: {message}")
    except Exception:
        pass

# ---------------------------------------------------------------------------------------------
# Supervisor
# ---------------------------------------------------------------------------------------------


class Supervisor:
    def __init__(
        self,
        paths: Paths,
        port: int,
        host: str = "127.0.0.1",
        node: str | None = None,
        sounds: str | None = None,
        startup_delay: float = 0.0,
        backoff: tuple[int, ...] = BACKOFF_SEQUENCE,
        healthy_s: float = HEALTHY_S,
        status_interval: float = STATUS_INTERVAL,
        cmd_interval: float = CMD_INTERVAL,
        health_interval: float = HEALTH_INTERVAL,
        stop_grace: float = STOP_GRACE_S,
        stop_timeout: float = 45.0,
    ):
        self.paths = paths
        self.port = int(port)
        self.host = host
        self.node = node  # None = resolve at spawn (SHOCKBOX_NODE, node.exe, PATH)
        self.sounds = sounds
        self.startup_delay = float(startup_delay)
        self.backoff_seq = tuple(int(b) for b in backoff) or BACKOFF_SEQUENCE
        self.healthy_s = float(healthy_s)
        self.status_interval = float(status_interval)
        self.cmd_interval = float(cmd_interval)
        self.health_interval = float(health_interval)
        self.stop_grace = float(stop_grace)
        # Upper bound on waiting for an *unexpected* exit after a stop command; a healthy node
        # closes within a second, this only bounds a wedged one so intent is never dropped.
        self.stop_timeout = float(stop_timeout)

        self.log = LogFile(paths.logs_dir)
        self.life = lifecycle_log(paths)
        self.status: dict[str, Any] = {
            "pid": os.getpid(),
            "port": self.port,
            "state": "starting",
            "since": now_iso(),
            "restarts": 0,
            "last_exit": None,
            "last_error": None,
            "node_pid": None,
            "adopted": False,
            "health": None,
            "next_restart_at": None,
            "app_dir": str(paths.app_dir),
            "supervisor_started": now_iso(),
        }
        self._proc: subprocess.Popen | None = None
        self._stop_intent = False
        self._want_running = False
        self._exiting = False
        self._backoff_i = 0
        self._next_spawn_at: float | None = None
        self._run_started: float | None = None
        self._last_health: float = 0.0
        # The pid the last probe looked for. A fresh spawn invalidates the "recently probed"
        # window: otherwise a start within `health_interval` of the previous pid's probe would
        # wait a whole interval in `starting` for no reason.
        self._probed_pid: int | None = None
        self._health: dict = {}
        self._client = apiclient.ApiClient(self.port, self.host, timeout=2.0)
        self._io_threads: list[threading.Thread] = []
        self._last_status_write = 0.0

    # ---- status ------------------------------------------------------------------
    def _set_state(self, state: str, **extra: Any) -> None:
        assert state in STATES, state
        changed = self.status.get("state") != state
        self.status["state"] = state
        if changed:
            self.status["since"] = now_iso()
        self.status.update(extra)
        self._write_status(force=True)

    def _write_status(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_status_write < self.status_interval:
            return
        self._last_status_write = now
        self.status["updated"] = now_iso()
        # The supervisor is in control of the port: it is the one process whose exact pid the UI
        # needs, and the only place it can be read race-free (os.getpid(), not a pid file that
        # may be mid-write). `node_pid` may differ: node can exec or wrap another process (the
        # test stub is a Node launcher in front of the real server), so /health's pid is
        # reported in `health.pid` and is *not* assumed to equal node_pid.
        self.status["supervisor_pid"] = os.getpid()
        self.status["node_alive"] = (
            self._child_alive() if self._proc is not None else pid_alive(self.status.get("node_pid"))
        )
        # When the next attempt is due, as wall-clock UTC the UI can render directly. Kept None
        # whenever nothing is scheduled (`stopped` after a stop must not look like a pending retry).
        next_at = None
        if self._next_spawn_at is not None:
            remaining = max(0.0, self._next_spawn_at - now)
            next_at = (
                _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0) + _dt.timedelta(seconds=remaining)
            ).isoformat()
        elif self.status.get("state") in ("stopped", "failed"):
            # Not a retry: node is down on purpose (or unrecoverably), so nothing is scheduled
            # and the UI must not show a countdown. It renders from `state` alone.
            next_at = None
        self.status["next_restart_at"] = next_at
        self._heartbeat_seq = getattr(self, "_heartbeat_seq", 0) + 1
        try:
            # status.json changes only when something changes, so it is not evidence of life.
            # The heartbeat file is: a counter plus a fresh mtime, rewritten every interval even
            # when status.json is byte-identical. The UI reads it to tell "alive" from "wedged".
            _atomic_write_json(self.paths.status_file, self.status)
            self.paths.heartbeat_file.write_text(f"{self._heartbeat_seq} {now_iso()}\n", encoding="ascii")
        except OSError as err:  # a full disk must not take the supervisor down
            self.note(f"heartbeat failed (status.json/heartbeat not written): {err}")
        self.flush_log()  # status is current → the log lines behind it are on disk too

    def note(self, message: str) -> None:
        """Supervisor line, in the same dated log as the app (prefix `launcher:`, like run.cmd).

        Also mirrored to ``runtime/supervisor.log`` through :func:`life_note`, so a supervisor
        that started, exited or was replaced leaves its own record even when the dated app log
        was rotated away or never written.
        """
        stamp = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            self.log.write(f"{stamp} launcher: {message}")
        except Exception:
            pass
        life_note(self.life, message)

    def flush_log(self) -> None:
        for handle in (self.log, self.life):
            if hasattr(handle, "flush"):
                try:
                    handle.flush()
                except Exception:
                    pass

    # ---- node --------------------------------------------------------------------
    def _resolve_node(self) -> str:
        if self.node:
            return self.node
        env = os.environ.get("SHOCKBOX_NODE")
        if env:
            return env
        if sys.platform == "win32":
            candidate = r"C:\Program Files\nodejs\node.exe"
            if Path(candidate).exists():
                return candidate
        return "node"

    def node_argv(self) -> list[str]:
        argv = [
            self._resolve_node(),
            "server.mjs",
            "--port",
            str(self.port),
            "--state",
            str(self.paths.state_dir),
            "--log-dir",
            str(self.paths.logs_dir),
        ]
        sounds = self.sounds
        if sounds is None:
            from .settings import sound_dir

            sounds = sound_dir(self.paths.config_json)
        if sounds:
            argv += ["--sounds", str(sounds)]
        return argv

    def _spawn_flags(self) -> int:
        if sys.platform != "win32":
            return 0
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        if os.environ.get("SHOCKBOX_TUI_WINDOWED"):
            flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return flags

    def _spawn(self) -> None:
        argv = self.node_argv()
        self.note("start " + " ".join(argv))
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(self.paths.app_dir),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=0,
                # Same convention as core/log.mjs: the node side writes one line per call and
                # flushes, and a line is what reaches the log file — so `tail -n` sees whole
                # lines, never a fragment of one mid-write.
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=self._spawn_flags(),
                # POSIX: its own session, so a Ctrl-C on the supervisor's terminal (or a hangup)
                # is not also delivered to node — the supervisor decides when node stops.
                start_new_session=(sys.platform != "win32"),
            )
        except OSError as err:
            self.status["last_error"] = f"spawn failed: {err}"
            self.note(f"spawn failed: {err}")
            self._enter_backoff()
            return
        self._proc = proc
        self._run_started = time.monotonic()
        self._stop_intent = False
        self.status["node_pid"] = proc.pid
        self.note(f"spawned node pid {proc.pid}")
        self.status["adopted"] = False
        self.status["last_error"] = None
        self._probed_pid = None  # probe the new pid immediately, not after the interval
        self._set_state("starting")
        thread = threading.Thread(target=self._pump_output, args=(proc,), daemon=True, name="node-output")
        thread.start()
        self._io_threads.append(thread)

    def _pump_output(self, proc: subprocess.Popen) -> None:
        """Copy node's merged output, line by line, into the dated log file."""
        stream = proc.stdout
        if stream is None:
            return
        try:
            # fgets-style readline on the raw pipe. A buffered `for line in stream` iterator
            # read-aheads until EOF (Python 3.12), which made this copy loop never yield: the
            # supervisor stayed in `starting` because its health poll ran behind this thread's
            # GIL slot. readline() returns per line, as core/log.mjs writes them.
            for line in iter(stream.readline, ""):
                self.log.write(line.rstrip("\n"))
        except (ValueError, OSError):
            pass
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def _enter_backoff(self) -> None:
        delay = self.backoff_seq[min(self._backoff_i, len(self.backoff_seq) - 1)]
        self._backoff_i += 1
        self._next_spawn_at = time.monotonic() + delay
        self.note(f"restarting in {delay}s (last exit {self.status.get('last_exit')}: {self.status.get('last_error') or 'no error recorded'})")
        self._set_state("backoff", next_restart_at=None)

    def _handle_exit(self, code: int | None) -> None:
        proc = self._proc
        self._proc = None
        ran = 0.0 if self._run_started is None else time.monotonic() - self._run_started
        self.status["node_pid"] = None
        self.status["last_exit"] = code
        self.note(f"exited {code} after {int(ran)}s")
        self._run_started = None

        if self._stop_intent or not self._want_running:
            self._stop_intent = False
            self._next_spawn_at = None
            if code == 0:
                self.status["last_error"] = None
            self._set_state("stopped")
            return

        if ran >= self.healthy_s:
            self._backoff_i = 0
        self.status["restarts"] = int(self.status.get("restarts") or 0) + 1
        self.status["last_error"] = f"exit {code} after {int(ran)}s"
        self._enter_backoff()

    # ---- adoption / orphans ------------------------------------------------------
    def _health_at(self, pid: int | None = None) -> dict:
        """``/health``, but only when it belongs to ``pid``. Empty for 'wrong process' and
        'not running' alike: a caller decides whether the absent answer means adopt or back off."""
        try:
            data = self._client.health()
        except (apiclient.ApiError, apiclient.ApiUnreachable):
            return {}
        if pid is not None and int(data.get("pid") or 0) != int(pid):
            return {}
        return data

    def _listener_pid(self) -> int | None:
        """The pid actually listening on our port, ours or not."""
        pids = [p for p in listener_pids(self.port) if p != os.getpid()]
        return pids[0] if pids else None

    def _handle_occupied(self) -> bool:
        """Deal with whatever already listens on our port. True when a node we can drive is up.

        Evidence, in this order (the install.ps1 rule): is the listener on the port one of our
        server.mjs processes? If yes and /health reports that same pid, adopt it — a previous
        supervisor died and left node alive, and killing a healthy app to start an identical
        one is pure downtime. If it is ours but unhealthy, stop it. If it is not ours, do not
        touch it: report, and let the spawn fail loudly rather than kill a stranger's process.
        """
        pid = self._listener_pid()
        if pid is None:
            return False
        if not is_our_server(pid, self.paths.app_dir, self.port):
            self.status["last_error"] = f"port {self.port} is held by pid {pid}, which is not this install"
            self.note(self.status["last_error"])
            self._set_state("failed")
            return False
        # The server may still be booting when we get here (a TUI restart starts the supervisor
        # while node is mid-startup, or an orphan was just left by a dead supervisor). Give it a
        # moment to answer before deciding it is unhealthy and killing it.
        health = self._health_at(pid)
        if not health:
            for _ in range(10):  # ≤5s
                time.sleep(0.5)
                if not pid_alive(pid):
                    break
                health = self._health_at(pid)
                if health:
                    break
        if health:
            self.note(f"adopting running server pid {pid} on port {self.port}")
            self.status["node_pid"] = pid
            self.status["adopted"] = True
            self.status["last_error"] = None
            self._run_started = time.monotonic()
            self._set_state("running", health=_health_summary(health))
            return True
        self.note(f"stopping unresponsive server pid {pid} on port {self.port}")
        terminate(pid, self.stop_grace)
        return False

    def _refresh_health(self) -> None:
        node_pid = self.status.get("node_pid")
        if not node_pid:
            self.status["health"] = None
            return
        now = time.monotonic()
        if now - self._last_health < self.health_interval and self._probed_pid == node_pid:
            return
        self._last_health = now
        # An adopted process is the one answering /health by definition. A spawned one may front
        # it (`node server.mjs` can hand off to, or wrap, another process — the test stub does
        # exactly that), so for the child we only require a healthy answer while *it* is alive:
        # a dead process cannot have one. Pid equality is the adoption test, not a liveness test.
        if self.status.get("adopted"):
            health = self._health_at(node_pid)
        else:
            health = self._client.health() if self._node_alive() else {}
            if health and not health.get("ok"):
                health = {}
            if not isinstance(health, dict):
                health = {}
        self._probed_pid = int(node_pid)
        self.status["health"] = _health_summary(health) if health else None
        if health and self.status.get("state") == "starting":
            self._set_state("running", health=_health_summary(health))
        elif health:
            self._write_status()

    # ---- commands ----------------------------------------------------------------
    def _read_command(self) -> dict | None:
        path = self.paths.cmd_file
        data = read_json(path)
        if not data:
            return None
        try:
            age = time.time() - path.stat().st_mtime
        except OSError:
            return None
        if age > STALE_CMD_S:
            try:
                path.unlink()
            except OSError:
                pass
            return None
        return data

    def _clear_command(self, cmd_id: Any) -> None:
        # Only delete the file we executed: the UI may already have written its next command
        # between our read and our unlink, and dropping that one would lose a click.
        current = read_json(self.paths.cmd_file)
        if current.get("id") == cmd_id:
            try:
                self.paths.cmd_file.unlink()
            except OSError:
                pass

    def handle_command(self, action: str) -> None:
        """Execute one action. Idempotent: each branch is a no-op when already in that state."""
        self.note(f"command {action}")
        if action == "start":
            if self._want_running and (self._proc is not None or self.status.get("adopted")):
                return
            self._want_running = True
            self._stop_intent = False
            self._backoff_i = 0
            self._next_spawn_at = None
            if self._proc is not None:
                return
            if self.status.get("adopted") and self._health_at(self.status.get("node_pid")):
                self._set_state("running")
                return
            self._set_state("starting")
            self._spawn()
        elif action == "stop":
            self._want_running = False
            self._stop_node()
        elif action == "restart":
            self._want_running = True
            self._backoff_i = 0
            self._next_spawn_at = None
            self._stop_node()
            if self._proc is None:
                self._set_state("starting")
                self._spawn()
        elif action == "shutdown":
            self._want_running = False
            self._stop_node()
            self._set_state("stopped")
            self._exiting = True
        else:
            self.note(f"ignoring unknown command {action!r}")

    def _stop_node(self) -> None:
        node_pid = self.status.get("node_pid")
        if self._proc is None and not node_pid:
            self._next_spawn_at = None
            self._set_state("stopped")
            return
        self._stop_intent = True
        self._next_spawn_at = None
        if self._proc is not None:
            pid = self._proc.pid
        else:
            pid = int(node_pid)
        self.note(f"stopping node pid {pid}")
        terminate(pid, self.stop_grace)
        if self._proc is not None:
            try:
                self._proc.wait(timeout=self.stop_timeout)
            except subprocess.TimeoutExpired:
                self.note(f"node pid {pid} did not exit within {int(self.stop_timeout)}s")
                try:
                    self._proc.kill()
                    self._proc.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            code = self._proc.returncode
            # The exit handler normally ran this already; if the pipe pump raced us, run it now.
            if self._proc is not None:
                self._handle_exit(code)
        else:
            self.status["node_pid"] = None
            self._set_state("stopped")

    # ---- main loop ---------------------------------------------------------------
    def run(self) -> int:
        self.paths.ensure()
        self.note(f"supervisor {os.getpid()} start for {self.paths.app_dir} port {self.port} argv={sys.argv[1:]}")
        self._install_signal_handlers()
        self._set_state("starting")

        # A stop that was pending when the previous supervisor died (or a TUI `stop` queued
        # while no supervisor was up) must not be mistaken for "start it": settle first.
        first = self._read_command()
        if self.startup_delay > 0:
            self._wait(self.startup_delay)
        if first and first.get("action") == "stop":
            self._clear_command(first.get("id"))
            self._want_running = False
            self._set_state("stopped")
            return 0
        if first and first.get("action") == "shutdown":
            self._clear_command(first.get("id"))
            self._set_state("stopped")
            return 0

        self._want_running = True
        self._set_state("starting")
        if not self._handle_occupied():
            if self.status.get("state") == "failed":
                # Someone else owns the port: do not spawn into a guaranteed EADDRINUSE loop.
                self._want_running = False
            else:
                self._spawn()

        while not self._exiting:
            try:
                self._tick()
            except Exception as err:  # never die on a transient: report and keep supervising
                self.status["last_error"] = f"supervisor: {err}"
                self.note(f"supervisor error: {err}")
            time.sleep(self.cmd_interval)
        self.note(f"supervisor {os.getpid()} exiting")
        self._set_state("stopped")
        return 0

    def _child_alive(self) -> bool:
        """True when the spawned child still runs.

        Deliberately does not call ``Popen.poll()``: that is the only reaper, and it is what
        records ``returncode`` for :meth:`_handle_exit`. ``poll()`` runs first in every
        :meth:`_tick`, so by the time a status write asks, ``returncode`` is already set when
        the child is gone. A zombie (exited, not yet waited) still counts as running here.
        """
        proc = self._proc
        return proc is not None and proc.returncode is None

    def _node_alive(self) -> bool:
        """Is node up? The child's own handle when we spawned it; existence when adopted."""
        if self._proc is not None:
            return self._child_alive()
        return pid_alive(self.status.get("node_pid"))

    def _tick(self) -> None:
        cmd = self._read_command()
        if cmd:
            self._clear_command(cmd.get("id"))
            action = cmd.get("action")
            if isinstance(action, str):
                self.handle_command(action)
            # Keep the heartbeat fresh on the same tick: the UI waits on it for the ack, and a
            # command must be visibly delivered even when the status document does not change.
            self._write_status(force=True)
            if self._exiting:
                return

        if self._proc is not None:
            code = self._proc.poll()
            if code is not None:
                self._handle_exit(code)
        elif self.status.get("adopted"):
            # An adopted server is not our child: a dying pid is the only exit signal there is.
            pid = self.status.get("node_pid")
            if not pid_alive(pid):
                self.status["adopted"] = False
                self.status["node_pid"] = None
                self._handle_exit(None)
        elif self._next_spawn_at is not None and time.monotonic() >= self._next_spawn_at:
            self._next_spawn_at = None
            if self._want_running:
                self._set_state("starting")
                self._spawn()

        self._refresh_health()
        self._write_status()

    def _wait(self, seconds: float) -> None:
        """Sleep in small slices so a stop command still lands promptly during startup."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self._exiting:
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))

    def _install_signal_handlers(self) -> None:
        def on_signal(signum, _frame):
            self.note(f"signal {signum}: stopping node and exiting")
            self._exiting = True

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, on_signal)
            except (OSError, ValueError):
                pass
        if hasattr(signal, "SIGHUP"):
            try:
                signal.signal(signal.SIGHUP, on_signal)
            except (OSError, ValueError):
                pass

    def cleanup(self) -> None:
        """Leave nothing running: called on the way out of :func:`main`."""
        if self._proc is not None:
            self._stop_intent = True
            try:
                self._proc.terminate()
                self._proc.wait(timeout=self.stop_grace)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self._proc.kill()
                except OSError:
                    pass
        elif self.status.get("node_pid"):
            terminate(int(self.status["node_pid"]), self.stop_grace)


def _health_summary(health: dict) -> dict | None:
    if not health:
        return None
    obs = health.get("obs") or {}
    modules = health.get("modules") or {}
    return {
        "ok": bool(health.get("ok")),
        "pid": health.get("pid"),
        "port": health.get("port"),
        "version": health.get("version"),
        "uptime": health.get("uptime"),
        "obs": obs.get("state"),
        "scene": obs.get("scene"),
        "modules": modules,
        "up": sum(1 for status in modules.values() if status == "up"),
        "total": len(modules),
    }


# ---------------------------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m shockbox_tui.supervisor", description=__doc__.splitlines()[0])
    parser.add_argument("--app-dir", required=True, help="ShockBox install directory (contains server.mjs)")
    parser.add_argument("--port", type=int, default=8972)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--runtime-dir", default=None, help="override the runtime directory (tests)")
    parser.add_argument("--node", default=None, help="node executable (default: SHOCKBOX_NODE, then node)")
    parser.add_argument("--sounds", default=None, help="override config.json's soundsDir")
    parser.add_argument("--startup-delay", type=float, default=0.0, help="wait before starting (race window)")
    parser.add_argument("--stop-timeout", type=float, default=45.0)
    parser.add_argument("--status-interval", type=float, default=STATUS_INTERVAL)
    parser.add_argument("--cmd-interval", type=float, default=CMD_INTERVAL)
    parser.add_argument("--health-interval", type=float, default=HEALTH_INTERVAL)
    parser.add_argument("--stop-grace", type=float, default=STOP_GRACE_S)
    args = parser.parse_args(argv)

    paths = Paths.resolve(args.app_dir, args.runtime_dir)
    paths.ensure()
    if paths.runtime_warning:
        # Report, do not exit: a wrong-owner runtime dir is exactly the condition this fix is
        # for, and a supervisor that refuses to start cannot be adopted by the other account.
        print(f"shockbox supervisor: {paths.runtime_warning}", file=sys.stderr)
    life = lifecycle_log(paths)
    # Who owned this runtime before us. This is the line that names a silent replacement: a
    # supervisor dying unnoticed now leaves "start ... previous pid N (dead)" behind it.
    try:
        prev = int((paths.supervisor_pid_file.read_text(encoding="ascii") or "0").strip() or 0)
    except (OSError, ValueError):
        prev = 0
    prior = "none" if not prev else f"pid {prev} ({'alive' if pid_alive(prev) else 'dead'})"
    lock = take_lock(paths.lock_file)
    if lock is None:
        life_note(life, f"start refused: supervisor.lock is held; previous={'none' if not prev else 'pid ' + str(prev)}; exiting 3")
        print(f"shockbox supervisor: another supervisor already holds {paths.lock_file} — exiting", file=sys.stderr)
        return 3
    life_note(life, f"start port={args.port} app={paths.app_dir} previous supervisor={prior} argv={sys.argv[1:]}")

    sup = Supervisor(
        paths,
        port=args.port,
        host=args.host,
        node=args.node,
        sounds=args.sounds,
        startup_delay=args.startup_delay,
        status_interval=args.status_interval,
        cmd_interval=args.cmd_interval,
        health_interval=args.health_interval,
        stop_grace=args.stop_grace,
        stop_timeout=args.stop_timeout,
    )
    try:
        paths.supervisor_pid_file.write_text(str(os.getpid()), encoding="ascii")
    except OSError:
        pass
    sup.life = life  # one handle, the one that already recorded this start
    code = -1

    def _unhandled(exc_type, exc, tb):
        life_note(life, "unhandled exception: " + "".join(traceback.format_exception(exc_type, exc, tb)).rstrip())
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _unhandled
    atexit.register(lambda: life_note(life, f"atexit: pid {os.getpid()} interpreter shutdown, last code {code}"))
    try:
        code = sup.run()
        return code
    finally:
        # A normal loop exit (shutdown, signal, startup `stop`) can still leave node alive when
        # it was adopted: stop it here, because `want_running` was already cleared by those paths.
        if sup.status.get("state") == "stopped":
            sup.cleanup()
        lock.close()
        # The runtime pid file is a hint, not a lock: delete it while we still know it is ours,
        # so a clean exit never leaves a number for the next reader to believe in. (A SIGKILL
        # can still leave one behind — that is why every reader verifies the pid as well.)
        try:
            if paths.supervisor_pid_file.read_text(encoding="ascii").strip() == str(os.getpid()):
                paths.supervisor_pid_file.unlink()
        except OSError:
            pass
        life_note(life, f"exit pid {os.getpid()} code {code}")


if __name__ == "__main__":
    sys.exit(main())
