"""Owner-agnostic control: the runtime dir is machine-wide and identity never needs a command line.

The failure these lock down: a SYSTEM-owned supervisor is invisible to a normal account's
``OpenProcess``/``QueryFullProcessImageNameW``. Reading that "cannot inspect" as "not ours"
deleted a live supervisor's pid file and marked a live node ``failed``. So identity here is
process liveness plus the supervisor's own heartbeat/status (or, for the node, ``/health``),
and a genuinely foreign listener is still rejected. Only the ACL application itself cannot run
on POSIX; it is called out where the test stops.
"""

from __future__ import annotations

import json
import os
import time
import types
from pathlib import Path

import pytest

from shockbox_tui import paths as paths_mod
from shockbox_tui import supervisor as sup
from shockbox_tui.control import STATUS_STALE_S, Control


def _status(runtime: Path, pid: int, age: float, named: int | None = None) -> None:
    """A runtime dir as the supervisor leaves it: fresh/stale heartbeat + status.json."""
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "heartbeat").write_text("1\n", encoding="ascii")
    (runtime / "status.json").write_text(
        json.dumps(
            {
                "pid": pid,
                "supervisor_pid": pid if named is None else named,
                "state": "running",
                "port": 8973,
            }
        ),
        encoding="utf-8",
    )
    stamp = time.time() - age
    os.utime(runtime / "heartbeat", (stamp, stamp))


# ---- A. runtime dir -------------------------------------------------------------------------


def test_default_runtime_dir_is_machine_wide_on_windows(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(paths_mod, "sys", types.SimpleNamespace(platform="win32"))
    monkeypatch.setenv("PROGRAMDATA", r"C:\ProgramData")
    monkeypatch.delenv("SHOCKBOX_RUNTIME_DIR", raising=False)
    p = paths_mod.Paths.resolve(app_dir=tmp_path)
    assert "ProgramData" in p.runtime_dir.as_posix()
    assert p.runtime_dir.name == "runtime"


def test_explicit_and_env_runtime_dirs_still_win(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(paths_mod, "sys", types.SimpleNamespace(platform="win32"))
    monkeypatch.setenv("PROGRAMDATA", r"C:\ProgramData")
    monkeypatch.setenv("SHOCKBOX_RUNTIME_DIR", str(tmp_path / "from-env"))
    p = paths_mod.Paths.resolve(app_dir=tmp_path)
    assert p.runtime_dir == (tmp_path / "from-env").resolve()
    explicit = paths_mod.Paths.resolve(app_dir=tmp_path, runtime_dir=tmp_path / "arg")
    assert explicit.runtime_dir == (tmp_path / "arg").resolve()


def test_ensure_reports_an_unusable_runtime_dir_instead_of_crashing(tmp_path: Path):
    blocker = tmp_path / "runtime"
    blocker.write_text("not a directory", encoding="ascii")
    p = paths_mod.Paths(app_dir=tmp_path, runtime_dir=blocker)
    p.ensure()
    assert p.runtime_warning and "does not exist" in p.runtime_warning


# ---- B. supervisor identity -----------------------------------------------------------------


def test_identity_accepts_live_pid_and_fresh_heartbeat_without_a_command_line(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, 4321, age=1.0)
    monkeypatch.setattr(sup, "pid_alive", lambda pid: True)
    monkeypatch.setattr(sup, "_proc_cmdline", lambda pid: "")  # SYSTEM pid: unreadable
    assert sup.is_supervisor_process(4321, runtime) is True


def test_identity_rejects_a_stale_heartbeat(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, 4321, age=STATUS_STALE_S + 5)
    monkeypatch.setattr(sup, "pid_alive", lambda pid: True)
    assert sup.is_supervisor_process(4321, runtime) is False


def test_identity_rejects_a_pid_the_status_does_not_name(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, 4321, age=1.0, named=9999)
    monkeypatch.setattr(sup, "pid_alive", lambda pid: True)
    assert sup.is_supervisor_process(4321, runtime) is False


def test_identity_rejects_a_dead_pid_with_a_fresh_heartbeat(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, 4321, age=0.5)
    monkeypatch.setattr(sup, "pid_alive", lambda pid: False)
    assert sup.is_supervisor_process(4321, runtime) is False


# ---- B. node adoption -----------------------------------------------------------------------


class _FakeClient:
    payload: dict = {}

    def __init__(self, port, *args, **kwargs):
        self.port = port

    def health(self):
        return dict(self.payload)


def test_adoption_accepts_health_identity_for_an_unreadable_listener(tmp_path, monkeypatch):
    monkeypatch.setattr(sup.apiclient, "ApiClient", _FakeClient)
    monkeypatch.setattr(sup, "_proc_cmdline", lambda pid: "")  # cannot inspect: SYSTEM node
    _FakeClient.payload = {"pid": 77, "service": "shockbox", "ok": True}
    assert sup.is_our_server(77, tmp_path, port=8973) is True


def test_adoption_rejects_a_foreign_listener_on_the_port(tmp_path, monkeypatch):
    monkeypatch.setattr(sup.apiclient, "ApiClient", _FakeClient)
    monkeypatch.setattr(sup, "_proc_cmdline", lambda pid: "")
    _FakeClient.payload = {"pid": 77, "service": "nginx", "ok": True}
    assert sup.is_our_server(77, tmp_path, port=8973) is False


def test_adoption_rejects_health_from_a_different_pid(tmp_path, monkeypatch):
    monkeypatch.setattr(sup.apiclient, "ApiClient", _FakeClient)
    monkeypatch.setattr(sup, "_proc_cmdline", lambda pid: "")
    _FakeClient.payload = {"pid": 78, "service": "shockbox", "ok": True}
    assert sup.is_our_server(77, tmp_path, port=8973) is False


# ---- C. control contract --------------------------------------------------------------------


def test_published_pid_survives_an_unreadable_command_line(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, 4321, age=1.0)
    (runtime / "supervisor.pid").write_text("4321", encoding="ascii")
    monkeypatch.setattr(sup, "pid_alive", lambda pid: True)
    monkeypatch.setattr(sup, "_proc_cmdline", lambda pid: "")
    ctl = Control(app_dir=tmp_path, port=8973, runtime_dir=runtime)
    assert ctl.supervisor_pid() == 4321
    assert (runtime / "supervisor.pid").exists(), "a live supervisor's pid file was unlinked"


def test_ensure_supervisor_adopts_a_fresh_heartbeat_without_a_pid_file(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, os.getpid(), age=0.5)  # real, live pid; the cmdline is pytest's, not ours
    ctl = Control(app_dir=tmp_path, port=8973, runtime_dir=runtime)
    monkeypatch.setattr(ctl, "_spawn_supervisor", lambda timeout: pytest.fail("spawned a second supervisor"))
    assert ctl.ensure_supervisor() is True


def test_ensure_supervisor_spawns_when_the_heartbeat_is_stale(tmp_path, monkeypatch):
    runtime = tmp_path / "rt"
    _status(runtime, os.getpid(), age=STATUS_STALE_S + 5)
    ctl = Control(app_dir=tmp_path, port=8973, runtime_dir=runtime)
    calls: list[float] = []
    monkeypatch.setattr(ctl, "_spawn_supervisor", lambda timeout: calls.append(timeout) or False)
    assert ctl.ensure_supervisor() is False
    assert calls, "a stale heartbeat must not be adopted"
