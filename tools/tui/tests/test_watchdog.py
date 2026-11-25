"""The poll-driven supervisor watchdog: respawn, rate limit, and the shutdown latch.

The real ``Control`` is not used: ``_watchdog`` only needs ``ensure_supervisor``, and the whole
point is to assert *whether* the poll decides to call it. Supervisor 42512 died without logging
on 2026-11-25 and nothing noticed for ten minutes; these lock the noticing down.
"""

from __future__ import annotations

from types import SimpleNamespace

import shockbox_tui.app as app_module
from shockbox_tui.app import ShockBoxApp

STALE = {"state": "no-supervisor", "stale": True, "age_s": 37.0}
HEALTHY = {"state": "running"}


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def monotonic(self) -> float:
        return self.t


class _FakeControl:
    def __init__(self) -> None:
        self.ensured = 0
        self.raises = False

    def ensure_supervisor(self) -> bool:
        self.ensured += 1
        if self.raises:
            raise OSError("spawn failed")
        return True

    def shutdown(self) -> dict:
        return {"state": "stopped"}

    def start(self) -> dict:
        return {"state": "running"}

    def restart(self) -> dict:
        return {"state": "running", "restarts": 4}


def _app(monkeypatch, clock: _Clock) -> tuple[ShockBoxApp, _FakeControl]:
    fake = _FakeControl()
    monkeypatch.setattr(app_module, "time", SimpleNamespace(monotonic=clock.monotonic))
    return ShockBoxApp(control=fake), fake


def test_stale_heartbeat_starts_a_supervisor(monkeypatch):
    app, fake = _app(monkeypatch, _Clock())
    app._watchdog(STALE)
    assert fake.ensured == 1


def test_missing_supervisor_starts_one(monkeypatch):
    app, fake = _app(monkeypatch, _Clock())
    app._watchdog({"state": "no-supervisor"})
    assert fake.ensured == 1


def test_healthy_supervisor_is_left_alone(monkeypatch):
    app, fake = _app(monkeypatch, _Clock())
    app._watchdog(HEALTHY)
    app._watchdog({"state": "running", "age_s": 1.0})
    assert fake.ensured == 0


def test_shutdown_latch_mutes_the_watchdog_until_start(monkeypatch):
    clock = _Clock()
    app, fake = _app(monkeypatch, clock)
    app._do_shutdown()
    assert app._userStopped is True

    clock.t = 60.0
    app._watchdog(STALE)
    app._watchdog(HEALTHY)  # a healthy poll must not clear the latch either
    clock.t = 120.0
    app._watchdog(STALE)
    assert fake.ensured == 0
    assert app._userStopped is True

    app._do_start()
    assert app._userStopped is False
    clock.t = 180.0
    app._watchdog(STALE)
    assert fake.ensured == 1


def test_restart_clears_the_shutdown_latch(monkeypatch):
    app, _ = _app(monkeypatch, _Clock())
    app._do_shutdown()
    app._do_restart()
    assert app._userStopped is False


def test_rate_limit_allows_one_start_per_interval(monkeypatch):
    clock = _Clock()
    app, fake = _app(monkeypatch, clock)
    for _ in range(5):
        app._watchdog(STALE)
    assert fake.ensured == 1

    clock.t = app_module.WATCHDOG_INTERVAL_S - 0.1
    app._watchdog(STALE)
    assert fake.ensured == 1

    clock.t = app_module.WATCHDOG_INTERVAL_S
    app._watchdog(STALE)
    assert fake.ensured == 2


def test_a_failed_spawn_does_not_escape(monkeypatch):
    app, fake = _app(monkeypatch, _Clock())
    fake.raises = True
    app._watchdog(STALE)  # must not raise: a watchdog that kills the TUI is worse than none
    assert fake.ensured == 1
