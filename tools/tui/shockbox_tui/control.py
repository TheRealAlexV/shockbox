"""What the UI calls. One object, no Textual, no threads — the UI polls it.

    ctl = Control(app_dir="C:/OBS/ShockBox", port=8972)
    ctl.status()                  -> dict       status.json, or {"state": "no-supervisor"}
    ctl.start()/stop()/restart()/shutdown()
    ctl.tail_log(200, follow=True) -> list[str]
    ctl.health() -> dict | None
    ctl.settings() -> dict
    ctl.patch({...}) -> dict

Every method returns or raises within a bounded time: commands are written to a file the
supervisor polls (no IPC that can hang), status is read from a file the supervisor writes, and
HTTP calls carry a timeout. "Not running" is a state, not an exception — the UI renders it.

The supervisor is started detached, so it outlives the TUI by design: the user asked for the
server to survive closing the window, and a supervisor inside the TUI would die with it.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from . import apiclient
from .apiclient import ApiClient, ApiError, ApiUnreachable
from .logtail import tail as _tail
from .paths import DEFAULT_PORT, Paths
from .settings import Settings, read_config

NO_SUPERVISOR = "no-supervisor"
# A supervisor rewrites its heartbeat at least every 2s; 12s of silence means wedged or dead.
# Six intervals, so a paused VM, a loaded disk or a scheduler hiccup cannot fake a death.
STATUS_STALE_S = 12.0
ACTION_TIMEOUT_S = 20.0


def _alive(pid: int | None) -> bool:
    """Process exists and is not a zombie."""
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


class ControlError(Exception):
    """A command could not be delivered: the runtime dir is unusable. Not a normal state."""


def _terminate(pid: int) -> bool:
    """Import-on-use: supervisor imports this module's siblings, and control is its entry point."""
    from .supervisor import terminate

    return terminate(pid)


class Control:
    def __init__(
        self,
        app_dir: str | os.PathLike | None = None,
        port: int | None = None,
        runtime_dir: str | os.PathLike | None = None,
        python: str | None = None,
        node: str | None = None,
        client: ApiClient | None = None,
    ):
        self.paths = Paths.resolve(app_dir, runtime_dir)
        cfg_path = self.paths.config_json
        if port is None:
            from .settings import port_of

            port = port_of(cfg_path, DEFAULT_PORT)
        self.port = int(port)
        self.python = python or sys.executable
        self.node = node
        self.client = client or ApiClient(self.port, timeout=2.5)
        self.settings_obj = Settings(self.client, cfg_path)
        self._follow_offset: int | None = None

    # ---- supervisor lifecycle ----------------------------------------------------
    def supervisor_argv(self) -> list[str]:
        argv = [
            self.python,
            "-m",
            "shockbox_tui.supervisor",
            "--app-dir",
            str(self.paths.app_dir),
            "--port",
            str(self.port),
            "--runtime-dir",
            str(self.paths.runtime_dir),
        ]
        if self.node:
            argv += ["--node", self.node]
        return argv

    @staticmethod
    def _detach_flags() -> int:
        if sys.platform != "win32":
            return 0
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if os.environ.get("SHOCKBOX_TUI_WINDOWED"):
            flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return flags

    def ensure_supervisor(self, timeout: float = ACTION_TIMEOUT_S) -> bool:
        """Start the supervisor if it is not alive. True when it is (now) up.

        Two TUI instances racing here is harmless: the supervisor's OS lock lets exactly one
        win, and the loser exits immediately.
        """
        if self.supervisor_responding():
            return True
        self.paths.ensure()
        # A supervisor that died hard may have left a status.json claiming "running"; start()
        # would then wait on a lie. Remove both files so the only evidence is the new one's.
        for path in (self.paths.status_file, self.paths.heartbeat_file):
            try:
                path.unlink()
            except OSError:
                pass
        env = dict(os.environ)
        env.setdefault("PYTHONPATH", str(Path(__file__).resolve().parent.parent))
        log_handle = open(self.paths.startup_log, "ab")
        try:
            popen_kwargs: dict[str, Any] = {
                "cwd": str(self.paths.app_dir if self.paths.app_dir.exists() else Path.cwd()),
                "stdin": subprocess.DEVNULL,
                "stdout": log_handle,
                "stderr": subprocess.STDOUT,
                "close_fds": True,
                "env": env,
            }
            if sys.platform == "win32":
                popen_kwargs["creationflags"] = self._detach_flags()
            else:
                # New session: no controlling terminal, no SIGHUP from the TUI's tty, and its
                # process group is its own. This is the POSIX equivalent of DETACHED_PROCESS.
                popen_kwargs["start_new_session"] = True
            subprocess.Popen([self.python, "-m", "shockbox_tui.supervisor", *self.supervisor_argv()[3:]], **popen_kwargs)
        finally:
            log_handle.close()
        return self._wait(lambda: self.supervisor_responding(), timeout)

    def supervisor_responding(self) -> bool:
        """Alive if its heartbeat is fresh.

        A supervisor deliberately gone (`shutdown`) leaves a `stopped` document behind forever —
        the only proof it is gone is a heartbeat that stopped. So a heartbeat older than
        ``STATUS_STALE_S`` (twice the 2s interval, plus room for a slow disk) means not
        responding, whether the process exited, was SIGKILLed or wedged.
        """
        status = self._read_status()
        if not status or status.get("state") == NO_SUPERVISOR:
            return False
        age = self._status_age()
        return age is not None and age <= STATUS_STALE_S

    def supervisor_pid(self) -> int | None:
        """The pid of the running supervisor, from status.json, or None.

        `supervisor_responding()` is a heartbeat judgment and can lag a dead process by seconds;
        for "is it really gone" and "is it really there", this is the number to check.
        """
        if not self.supervisor_responding():
            return None
        data = self._read_status()
        pid = data.get("supervisor_pid") or data.get("pid")
        return int(pid) if pid and _alive(pid) else None

    # ---- status ------------------------------------------------------------------
    def _read_status(self) -> dict:
        try:
            with open(self.paths.status_file, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _status_age(self) -> float | None:
        """Seconds since the supervisor last said it was alive, or None when it never has.

        The heartbeat file, not status.json: a steady `running` supervisor rewrites the same
        status bytes forever, but bumps the heartbeat every 2s.
        """
        try:
            return time.time() - self.paths.heartbeat_file.stat().st_mtime
        except OSError:
            return None

    def status(self) -> dict:
        """The supervisor's status document, always with a ``state`` key.

        ``{"state": "no-supervisor"}`` when there is none (never created, or the heartbeat is
        stale). A stale document is returned *with* ``stale: True`` and its last known fields,
        because "the supervisor wedged 3 minutes ago with node running" is more useful than
        nothing. ``age_s`` is the heartbeat age.
        """
        data = self._read_status()
        if not data:
            return {"state": NO_SUPERVISOR, "port": self.port, "app_dir": str(self.paths.app_dir)}
        out = dict(data)
        age = self._status_age()
        age = None if age is None else round(age, 1)
        status = self._read_status()
        out = dict(status) if status else {}
        out["age_s"] = age
        if age is None or age > STATUS_STALE_S:
            out["stale"] = True
            if out.get("state") != "stopped":
                # A wedged supervisor may still have node running; say what the socket says.
                out["state"] = NO_SUPERVISOR
                out["last_state"] = data.get("state")
        return out

    # ---- commands ----------------------------------------------------------------
    def send(self, action: str, timeout: float = ACTION_TIMEOUT_S) -> dict:
        """Write a command for the supervisor and wait for it to be acknowledged.

        The ack is either the command file being gone (the supervisor deletes it after acting)
        or the heartbeat counter advancing past the value it had when we wrote — the supervisor
        bumps it on the same tick it executes a command. Both are cheap reads; a timeout is not
        an error the UI must crash on — the command may still run, and ``acked: False`` says so.
        """
        if action not in ("start", "stop", "restart", "shutdown"):
            raise ValueError(f"unknown action {action!r}")
        self.paths.ensure()
        seq_before = self._heartbeat_seq()
        cmd = {"id": uuid.uuid4().hex, "action": action, "at": _dt.datetime.now(_dt.timezone.utc).isoformat()}
        path = self.paths.cmd_file
        fd, tmp = tempfile.mkstemp(prefix="cmd.", suffix=".tmp", dir=str(self.paths.runtime_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(cmd, fh)
                fh.flush()
                os.fsync(fh.fileno())
            # Atomic, and read-only for everyone else: 0600 on POSIX. The command file can be
            # re-read by any observer of the runtime dir; it holds nothing secret today, and
            # keeping it private is the rule that survives the next command that does.
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except OSError as err:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise ControlError(f"cannot write {path}: {err}") from None

        acked = self._wait(lambda: not self._cmd_pending(cmd["id"], seq_before), timeout)
        return {"action": action, "id": cmd["id"], "acked": acked}

    def _cmd_pending(self, cmd_id: str, seq_before: int | None = None) -> bool:
        try:
            with open(self.paths.cmd_file, "r", encoding="utf-8") as fh:
                current = json.load(fh).get("id")
        except (OSError, ValueError):
            current = None
        if current != cmd_id:
            # Gone (executed) or replaced by a newer command (ours is lost, but the UI is not
            # going to learn anything more by waiting).
            return False
        if seq_before is not None:
            seq = self._heartbeat_seq()
            if seq is not None and seq >= seq_before + 1:
                return False  # executed: the supervisor bumped the heartbeat on the same tick
        return True

    def _heartbeat_seq(self) -> int | None:
        try:
            return int(self.paths.heartbeat_file.read_text(encoding="ascii").split(" ", 1)[0])
        except (OSError, ValueError, IndexError):
            return None

    def _discard_command(self, action: str) -> None:
        """Remove a leftover command file of this ``action`` (best effort, never raises)."""
        try:
            with open(self.paths.cmd_file, "r", encoding="utf-8") as fh:
                if json.load(fh).get("action") != action:
                    return
            self.paths.cmd_file.unlink()
        except (OSError, ValueError):
            return

    def start(self) -> dict:
        """Ensure a supervisor exists, then start node. Returns the status after the call."""
        up = self.ensure_supervisor()
        if not up:
            raise ControlError(f"supervisor did not come up — see {self.paths.startup_log}")
        self.send("start")
        self._wait(lambda: self.status().get("state") in ("running", "backoff", "failed"), timeout=ACTION_TIMEOUT_S)
        return self.status()

    def stop(self) -> dict:
        if not self.supervisor_responding():
            return self.status()  # nothing to stop: already in the state the caller wants
        self.send("stop")
        self._wait(lambda: self.status().get("state") in ("stopped", "failed"), timeout=ACTION_TIMEOUT_S)
        return self.status()

    def restart(self) -> dict:
        up = self.ensure_supervisor()
        if not up:
            raise ControlError(f"supervisor did not come up — see {self.paths.startup_log}")
        self.send("restart", timeout=ACTION_TIMEOUT_S * 2)
        self._wait(lambda: self.status().get("state") == "running", timeout=ACTION_TIMEOUT_S)
        return self.status()

    def shutdown(self) -> dict:
        """Stop node and the supervisor. Returns once neither process exists.

        Waits on the pids, not on the heartbeat alone: a supervisor that exits inside the same
        2s window leaves a heartbeat that is still technically fresh, and "the supervisor is
        gone" is a claim about processes.
        """
        status = self.status()
        if not self.supervisor_responding():
            self._wait(lambda: not _alive(status.get("supervisor_pid")), timeout=ACTION_TIMEOUT_S)
            return self.status()
        sup_pid, node_pid = status.get("supervisor_pid"), status.get("node_pid")
        self.send("shutdown", timeout=ACTION_TIMEOUT_S)
        gone = self._wait(
            lambda: not _alive(sup_pid) and not _alive(node_pid),
            timeout=ACTION_TIMEOUT_S * 2,
        )
        # A supervisor that does not exit on its own within the timeout is wedged, not busy: a
        # shutdown is "stop node and exit", nothing to wait on. Killing it here keeps the UI's
        # promise (the button means the processes are gone) and recovers a stuck control loop.
        if not gone:
            for pid in (node_pid, sup_pid):
                if _alive(pid):
                    _terminate(int(pid))
            self._wait(lambda: not _alive(sup_pid) and not _alive(node_pid), timeout=10)
        # If the supervisor died before its unlink, the command file would be re-read by the next
        # supervisor and shut it down on arrival. Dropping it here is idempotent and cheap.
        self._discard_command("shutdown")
        return self.status()

    # ---- observation ---------------------------------------------------------------
    def tail_log(self, n: int = 200, follow: bool = False) -> list[str]:
        """Last ``n`` lines of today's log.

        ``follow=True`` returns only what is new since the previous ``follow=True`` call —
        i.e. an append between two calls is what the second call returns. The first
        ``follow=True`` call behaves like a plain tail (nothing has been consumed yet).
        """
        path = self.paths.log_file()
        if follow:
            if self._follow_offset is None:
                lines, offset = _tail(path, n)
            else:
                lines, offset = _tail(path, n, since_offset=self._follow_offset)
            self._follow_offset = offset
            return lines
        lines, _ = _tail(path, n)
        return lines

    def health(self) -> dict | None:
        """``/health`` as the server answered it, or None when it is not answering."""
        try:
            return self.client.health()
        except (ApiError, ApiUnreachable):
            return None

    # ---- settings ------------------------------------------------------------------
    def settings(self) -> dict:
        """Server settings (core + modules) and the masked local config."""
        return self.settings_obj.describe()

    def patch(self, changes: dict, module: str | None = None) -> dict:
        return self.settings_obj.patch(changes, module=module)

    def config(self, reveal: bool = False) -> dict:
        """config.json; the obs password is masked unless ``reveal=True``."""
        return read_config(self.paths.config_json, reveal=reveal)

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    # ---- module routes --------------------------------------------------------------
    # Thin pass-throughs for the screens. They do NOT swallow errors: a failed PATCH must read
    # as a failure in the UI, and "unreachable" is something only the caller knows how to label.
    def modules(self) -> list:
        """``GET /api/modules`` rows: ``[{id, status, ...}]``."""
        return self.client.modules()

    def wall_live(self) -> dict:
        """One wall snapshot: ``{ok, seq, online, history, commands, settings, ratio, render}``."""
        return self.client.get("/api/wall/live")

    def wall_cmd(self, cmd: str, args: dict | None = None) -> dict:
        """``POST /api/wall/cmd`` — a validated bus command; the server's own ``ok`` rides back."""
        body: dict = {"cmd": cmd}
        if args:
            body["args"] = args
        return self.client.request("POST", "/api/wall/cmd", body)

    def wall_patch(self, changes: dict) -> dict:
        """``PATCH /api/wall/settings`` — persists and broadcasts in one call."""
        return self.client.patch("/api/wall/settings", changes)

    def notify(self, path: str, body: dict | None = None, method: str = "POST") -> dict:
        """``<method> /api/notifications<path>``; ``GET``/``DELETE`` pass no body."""
        return self.client.request(method, "/api/notifications" + path, body)

    def dialog(self, path: str, body: dict | None = None, method: str = "POST") -> dict:
        """``<method> /api/dialogs<path>``."""
        return self.client.request(method, "/api/dialogs" + path, body)

    def handfx(self, cmd: str, args: dict | None = None) -> dict:
        """``POST /api/handfx/cmd`` — one of ``status()['cmds']``."""
        body: dict = {"cmd": cmd}
        if args:
            body["args"] = args
        return self.client.request("POST", "/api/handfx/cmd", body)

    def handfx_status(self) -> dict:
        """``GET /api/handfx/status`` — effects registry, model/runtime facts, settings."""
        return self.client.get("/api/handfx/status")

    def handfx_skins(self) -> list:
        """Projectile skins the page implements, from the status document's ``skins``/settings."""
        status = self.handfx_status()
        skins = status.get("skins")
        if isinstance(skins, list) and skins:
            return list(skins)
        # Older builds publish them as the `skins` mapping's own keys (a per-effect map).
        mapping = (status.get("settings") or {}).get("skins")
        if isinstance(mapping, dict):
            found = [v for v in mapping.values() if isinstance(v, str)]
            if found:
                return found
        return ["projectile", "heart"]

    def handfx_fire(self, skin: str | None = None) -> dict:
        """``projectile.fire``, optionally wearing ``skin``. The server refuses an unknown one."""
        return self.handfx("projectile.fire", {"skin": skin} if skin else None)

    # ---- helpers -------------------------------------------------------------------
    @staticmethod
    def _wait(predicate, timeout: float, interval: float = 0.05) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(interval)
        return bool(predicate())
