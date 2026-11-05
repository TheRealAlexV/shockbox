"""Where everything lives.

Two different trees, kept apart on purpose:

* **install dir** — the ShockBox checkout (``server.mjs``, ``core/``, ``modules/``). Holds
  ``config.json`` and, by convention, ``logs/`` and ``state/``.
* **runtime dir** — the TUI's own scratch: the supervisor lock, ``status.json``, ``cmd.json``,
  pid files. Windows: ``%PROGRAMDATA%\\ShockBox\\runtime``; POSIX:
  ``$XDG_STATE_HOME/shockbox`` (usually ``~/.local/state/shockbox``).

The Windows runtime dir is **machine-wide**, not per-account. ``install.ps1`` runs the
supervisor as SYSTEM while the TUI runs as the installing user; a per-account
``%LOCALAPPDATA%`` split the two into different directories, so each side saw an empty runtime
dir and started a second supervisor (which then died on EADDRINUSE). One machine-wide dir is
the only layout where the lock, heartbeat, status and command file mean the same thing to both
processes. It is created with an ACL granting SYSTEM and the installing account modify access,
because the default ProgramData inheritance would otherwise leave one side unable to write.

The runtime dir is *not* under the install dir: the install dir is replaced wholesale by
``deploy/install.ps1`` (robocopy), and the lock must not be copied or rotated away while a
supervisor holds it.

Resolution order for the install dir is the same idea as ``server.mjs``: explicit argument
(``--app-dir``) > environment (``SHOCKBOX_APP_DIR``) > the parent of the ``tools/tui`` package
when running from a checkout.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ENV_APP_DIR = "SHOCKBOX_APP_DIR"
ENV_RUNTIME_DIR = "SHOCKBOX_RUNTIME_DIR"
ENV_DATA_DIR = "SHOCKBOX_DATA_DIR"

DEFAULT_PORT = 8972

# A supervisor rewrites its heartbeat at least every 2s. Six intervals of silence means wedged
# or dead; both the control side and the identity predicate use this one number.
HEARTBEAT_STALE_S = 12.0


def _package_root() -> Path:
    return Path(__file__).resolve().parent


def default_app_dir() -> Path:
    """The checkout this package was imported from: ``<repo>/tools/tui/shockbox_tui`` → ``<repo>``."""
    return _package_root().parent.parent.parent


# ---- machine-wide runtime dir ----------------------------------------------------------------


def runtime_dir_writable(path: Path) -> bool:
    """A real write, not ``os.access``: Windows ACLs and read-only tokens disagree with it."""
    probe = path / f".write-probe-{os.getpid()}"
    try:
        probe.write_text("", encoding="ascii")
        return True
    except OSError:
        return False
    finally:
        try:
            probe.unlink()
        except OSError:
            pass


def _current_user_sid() -> str:
    """SID of the account running this process, so the grant survives renamed/domain accounts."""
    done = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    parts = [p.strip().strip('"') for p in done.stdout.strip().split(",")]
    return parts[1] if len(parts) > 1 else ""


def grant_shared_runtime_acl(path: Path) -> str | None:
    """Let SYSTEM and the installing account read/write ``path`` and everything under it.

    Returns a warning (never raises) when the ACL could not be applied: an existing dir with
    the wrong owner is a real, reportable condition, not a reason for the supervisor to die.
    SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544) get full control; the installing
    account gets modify. Inheritance flags are needed or files written by one side stay
    unreadable to the other.
    """
    try:
        sid = _current_user_sid()
    except (OSError, subprocess.SubprocessError) as err:
        return f"runtime dir ACL not applied: cannot resolve the current account SID ({err})"
    grants = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]
    if sid:
        grants.append(f"*{sid}:(OI)(CI)M")
    try:
        done = subprocess.run(
            ["icacls", str(path), "/grant", *grants, "/C"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as err:
        return f"runtime dir ACL not applied: {err}"
    if done.returncode != 0:
        detail = (done.stdout or done.stderr or "").strip().splitlines()
        return f"runtime dir ACL not applied: icacls exited {done.returncode} ({detail[-1] if detail else 'no output'})"
    return None


def runtime_dir_problem(path: Path) -> str | None:
    """Why the runtime dir is unusable for cross-account control, or None when it is fine."""
    if not path.is_dir():
        return f"runtime dir {path} does not exist"
    if not runtime_dir_writable(path):
        return f"runtime dir {path} is not writable by this account; another account's supervisor state is unreachable"
    return None


_acl_applied: set[str] = set()


def local_day(when=None) -> str:
    """``YYYY-MM-DD`` in **local** time — the same rule ``localDay()`` in ``server.mjs`` uses.

    The log name is read by people and matched by ``deploy/run.cmd``; a UTC name splits one
    evening across two files either side of midnight UTC.
    """
    import datetime

    d = when or datetime.datetime.now()
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


@dataclass(frozen=True)
class Paths:
    """Resolved directories. Frozen: the supervisor builds one and never re-resolves."""

    app_dir: Path
    runtime_dir: Path
    # Set by ensure(): a report, never an exception, when the shared dir cannot host both
    # accounts (missing, wrong owner, not writable). Compare=False so it stays metadata.
    runtime_warning: str | None = field(default=None, compare=False)

    @classmethod
    def resolve(
        cls,
        app_dir: str | os.PathLike | None = None,
        runtime_dir: str | os.PathLike | None = None,
    ) -> "Paths":
        app = app_dir or os.environ.get(ENV_APP_DIR) or default_app_dir()
        runtime = runtime_dir or os.environ.get(ENV_RUNTIME_DIR)
        if runtime is None:
            if sys.platform == "win32":
                # Machine-wide on purpose (see the module docstring): the supervisor runs as
                # SYSTEM, the TUI as the installing account, and a per-account dir splits them.
                base = os.environ.get("PROGRAMDATA") or os.environ.get("ALLUSERSPROFILE") or r"C:\ProgramData"
                runtime = Path(base) / "ShockBox" / "runtime"
            else:
                base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
                runtime = Path(base) / "shockbox"
        return cls(app_dir=Path(app).resolve(), runtime_dir=Path(runtime).resolve())

    # ---- install tree ---------------------------------------------------------
    @property
    def server_script(self) -> Path:
        return self.app_dir / "server.mjs"

    @property
    def config_json(self) -> Path:
        return self.app_dir / "config.json"

    @property
    def logs_dir(self) -> Path:
        return self.app_dir / "logs"

    @property
    def state_dir(self) -> Path:
        return self.app_dir / "state"

    @property
    def default_sounds_dir(self) -> str:
        """Rig default from ``server.mjs``; overridable by ``config.json``'s ``soundsDir``."""
        return "C:\\OBS\\Sounds\\SoundBoard"

    # ---- runtime ---------------------------------------------------------------
    @property
    def lock_file(self) -> Path:
        return self.runtime_dir / "supervisor.lock"

    @property
    def status_file(self) -> Path:
        return self.runtime_dir / "status.json"

    @property
    def heartbeat_file(self) -> Path:
        """Proves the supervisor is still alive, independently of status.json.

        status.json changes only when something changes (state, health, restart), so it carries
        no freshness signal by itself. This file is rewritten on every heartbeat with a counter
        and a fresh mtime: the UI reads *it* to decide stale vs alive, and status.json to decide
        what to render.
        """
        return self.runtime_dir / "heartbeat"

    @property
    def cmd_file(self) -> Path:
        return self.runtime_dir / "cmd.json"

    @property
    def supervisor_pid_file(self) -> Path:
        return self.runtime_dir / "supervisor.pid"

    @property
    def startup_log(self) -> Path:
        """Supervisor's own stdout/stderr. Its crash is the one thing status.json cannot report."""
        return self.runtime_dir / "supervisor.log"

    def log_file(self, day: str | None = None) -> Path:
        return self.logs_dir / f"shockbox-{day or local_day()}.log"

    def ensure(self) -> "Paths":
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.runtime_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Cannot create it: record why and let the caller report. Crashing here would take
            # the whole TUI down for a runtime dir that another account may have fixed already.
            pass
        warning = None
        if sys.platform == "win32" and self.runtime_dir.is_dir():
            key = str(self.runtime_dir).lower()
            if key not in _acl_applied:
                warning = grant_shared_runtime_acl(self.runtime_dir)
                if warning is None:
                    _acl_applied.add(key)
        if warning is None:
            warning = runtime_dir_problem(self.runtime_dir)
        if warning:
            object.__setattr__(self, "runtime_warning", warning)
        return self
