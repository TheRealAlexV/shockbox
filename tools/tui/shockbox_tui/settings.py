"""Settings: the server's via HTTP, the launcher's via ``config.json``.

Two documents, two owners, and they must not be confused:

* ``state/core/settings.json`` — owned by ``core/settings.mjs``, reached through
  ``/api/core/settings``. Modules follow the same shape under ``/api/<id>/settings``. The TUI
  never writes these files; a PATCH is the only path, so validation stays in one place.
* ``config.json`` next to ``server.mjs`` — read only at node start-up: port, host, stateDir,
  logDir, ``soundsDir``, and ``obs`` (``url``, ``password``, ``enabled``). A change here needs a
  server restart; the TUI offers that as a separate action rather than doing it silently.

**The obs-websocket password never leaves the process that has to use it.** ``read_config``
returns it only when asked with ``reveal=True``; ``masked`` is what a UI may render, and
``write_config_patch`` accepts a write-only sentinel so "unchanged" is expressible without ever
holding the value. Nothing here logs, and nothing returns the file body wholesale.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .apiclient import ApiClient, ApiError, ApiUnreachable

# What a form shows in the password row when a password is set. Writing it back is a no-op.
SECRET_MASK = "********"

# config.json keys the TUI may edit, with the type each one must have.
CONFIG_SCHEMA: dict[str, type | tuple[type, ...]] = {
    "port": int,
    "host": str,
    "stateDir": str,
    "logDir": str,
    "soundsDir": str,
    "compatPort": int,
}
OBS_KEYS = ("url", "password", "enabled")


class ConfigError(Exception):
    """A value the user typed cannot be written as-is. Message is safe to display."""


def _load_json(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {}


def _atomic_write_json(path: Path, data: dict) -> None:
    """Write-then-rename. A server reading config.json at start-up never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        if path.exists():
            # Keep the original's mode: the file can hold a secret and must not become 0644
            # just because it was rewritten.
            try:
                shutil.copymode(path, tmp)
            except OSError:
                pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def masked_secret(value: str | None) -> str:
    return SECRET_MASK if value else ""


def read_config(config_path: os.PathLike | str, reveal: bool = False) -> dict:
    """config.json as a dict. The obs password is replaced by :data:`SECRET_MASK` unless
    ``reveal=True``; ``obsPasswordSet`` always says whether one exists."""
    cfg = _load_json(Path(config_path))
    obs = cfg.get("obs")
    if isinstance(obs, dict):
        obs = dict(obs)
        password = obs.get("password") or ""
        obs["password"] = password if reveal else masked_secret(password)
        obs["passwordSet"] = bool(password)
        cfg["obs"] = obs
    else:
        cfg["obs"] = {"password": "", "passwordSet": False}
    return cfg


def _check_value(key: str, value: Any) -> str:
    """Validate a path/string config value."""
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{key} must be a non-empty string")
    return value.strip()


def _check_int(key: str, value: Any) -> int:
    """Validate a numeric config value; accepts the string a text field produces."""
    raw = value
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ConfigError(f"{key} must be a whole number")
    if isinstance(value, str):
        raw = value.strip()
        if not (raw.isdigit() or (raw.startswith("-") and raw[1:].isdigit())):
            raise ConfigError(f"{key} must be a whole number")
    number = int(raw)
    if not (0 <= number <= 65535):
        raise ConfigError(f"{key} must be between 0 and 65535")
    return number


def write_config_patch(config_path: os.PathLike | str, changes: dict) -> dict:
    """Merge ``changes`` into config.json atomically and return the masked result.

    Accepted keys: the scalars in :data:`CONFIG_SCHEMA`, ``obs.url``, ``obs.enabled``,
    ``obs.password``. A password equal to :data:`SECRET_MASK` (or ``None``) means "leave it",
    so a form can round-trip the masked value without ever asking for the secret.
    Raises :class:`ConfigError` for an unknown key or a value of the wrong type.
    """
    path = Path(config_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cfg = _load_json(path)

    for key, value in changes.items():
        if key.startswith("obs."):
            sub = key[4:]
            if sub not in OBS_KEYS:
                raise ConfigError(f"unknown setting {key!r}")
            obs = cfg.get("obs")
            obs = dict(obs) if isinstance(obs, dict) else {}
            if sub == "enabled":
                if not isinstance(value, bool):
                    raise ConfigError("obs.enabled must be true or false")
                obs["enabled"] = value
            elif sub == "url":
                if not isinstance(value, str) or not value.strip().lower().startswith(("ws://", "wss://")):
                    raise ConfigError("obs.url must start with ws:// or wss://")
                obs["url"] = value.strip()
            else:  # password — write-only
                if value is None or value == SECRET_MASK:
                    pass
                elif not isinstance(value, str):
                    raise ConfigError("obs.password must be a string")
                else:
                    obs["password"] = value
            cfg["obs"] = obs
            continue
        if key not in CONFIG_SCHEMA:
            raise ConfigError(f"unknown setting {key!r}")
        expected = CONFIG_SCHEMA[key]
        if expected is str:
            cfg[key] = _check_value(key, value)
        elif expected is int:
            cfg[key] = _check_int(key, value)
        else:  # pragma: no cover - schema is a module constant
            raise ConfigError(f"unknown setting {key!r}")
    
    _atomic_write_json(path, cfg)
    return read_config(path)


def sound_dir(config_path: os.PathLike | str, default: str = "C:\\OBS\\Sounds\\SoundBoard") -> str:
    cfg = _load_json(Path(config_path))
    value = cfg.get("soundsDir")
    return value if isinstance(value, str) and value.strip() else default


def port_of(config_path: os.PathLike | str, default: int = 8972) -> int:
    cfg = _load_json(Path(config_path))
    try:
        return int(cfg.get("port") or default)
    except (TypeError, ValueError):
        return default


def parse_when(value: str | None) -> float:
    """ISO-8601 timestamp (``status.json``'s ``since``/``supervisor_started``) → epoch seconds.

    Accepts a trailing ``Z`` and an explicit offset (``+02:00``); a naive stamp is read as local
    time, which is how the supervisor writes them. Anything unparseable returns ``0.0`` rather
    than raising — an uptime that reads "—" is better than a stuck screen.
    """
    if not value or not isinstance(value, str):
        return 0.0
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        stamp = _dt.datetime.fromisoformat(text)
    except ValueError:
        return 0.0
    if stamp.tzinfo is None:
        stamp = stamp.astimezone()  # naive -> local, matching how it was written
    return stamp.timestamp()


class Settings:
    """Server settings through HTTP plus the local config.json half.

    The UI gets one object: :meth:`describe` returns everything the settings screen renders,
    :meth:`patch` routes each key to the right owner (HTTP for server settings, config.json for
    the launcher's), and reports what needs a restart.
    """

    def __init__(self, client: ApiClient, config_path: os.PathLike | str, module_ids: tuple[str, ...] = ()):
        self.client = client
        self.config_path = Path(config_path)
        self.module_ids = tuple(module_ids)

    # ---- server settings -------------------------------------------------------
    def describe(self) -> dict:
        """All editable settings, grouped by owner.

        ``{"core": {key: {...}}, "<module>": {key: {...}}, "config": {key: value}}``.
        Server sections are empty (not an exception) when the server is not answering: the
        screen still renders and says why.
        """
        out: dict[str, Any] = {"core": {}, "config": read_config(self.config_path)}
        try:
            out["core"] = self.client.settings()
            for module_id in self.module_ids:
                try:
                    out[module_id] = self.client.module_settings(module_id)
                except (ApiError, ApiUnreachable):
                    out[module_id] = {}
        except (ApiError, ApiUnreachable) as err:
            out["error"] = str(err)
        return out

    def patch(self, changes: dict, module: str | None = None) -> dict:
        """Apply ``changes`` and return ``{"changed": [...], "needs_restart": bool, "settings": {...}}``.

        ``module=None`` patches core; ``module="notifications"`` patches that module. Keys
        prefixed ``obs.`` (and the scalars ``port``/``host``/``stateDir``/``logDir``/
        ``soundsDir``/``compatPort``) are written to config.json and reported as needing a
        restart — they are only read when node starts.
        """
        server_changes = {k: v for k, v in changes.items() if not _is_config_key(k)}
        config_changes = {k: v for k, v in changes.items() if _is_config_key(k)}
        changed: list[str] = []
        needs_restart = False

        if config_changes:
            write_config_patch(self.config_path, config_changes)
            changed.extend(sorted(config_changes))
            needs_restart = True

        if server_changes:
            if module:
                result = self.client.patch_module_settings(module, server_changes)
                changed.extend(result.get("changed") or [])
                settings = result.get("settings") or {}
            else:
                changed.extend(self.client.patch_settings(server_changes))
                settings = self.client.settings()
        else:
            settings = {}

        return {
            "changed": changed,
            "needs_restart": needs_restart,
            "settings": settings,
            "config": read_config(self.config_path),
        }


def _is_config_key(key: str) -> bool:
    """Keys that live in config.json and are only read when node starts."""
    return key.startswith("obs.") or key in ("port", "host", "stateDir", "logDir", "soundsDir")
