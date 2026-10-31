"""Where everything lives.

Two different trees, kept apart on purpose:

* **install dir** — the ShockBox checkout (``server.mjs``, ``core/``, ``modules/``). Holds
  ``config.json`` and, by convention, ``logs/`` and ``state/``.
* **runtime dir** — the TUI's own scratch: the supervisor lock, ``status.json``, ``cmd.json``,
  pid files. Windows: ``%LOCALAPPDATA%\\ShockBox\\runtime``; POSIX:
  ``$XDG_STATE_HOME/shockbox`` (usually ``~/.local/state/shockbox``).

The runtime dir is *not* under the install dir: the install dir is replaced wholesale by
``deploy/install.ps1`` (robocopy), and the lock must not be copied or rotated away while a
supervisor holds it.

Resolution order for the install dir is the same idea as ``server.mjs``: explicit argument
(``--app-dir``) > environment (``SHOCKBOX_APP_DIR``) > the parent of the ``tools/tui`` package
when running from a checkout.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

ENV_APP_DIR = "SHOCKBOX_APP_DIR"
ENV_RUNTIME_DIR = "SHOCKBOX_RUNTIME_DIR"
ENV_DATA_DIR = "SHOCKBOX_DATA_DIR"

DEFAULT_PORT = 8972


def _package_root() -> Path:
    return Path(__file__).resolve().parent


def default_app_dir() -> Path:
    """The checkout this package was imported from: ``<repo>/tools/tui/shockbox_tui`` → ``<repo>``."""
    return _package_root().parent.parent.parent


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
                base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home())
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
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        return self
