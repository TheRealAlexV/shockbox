"""Control + supervisor, against a real subprocess.

Every test here starts actual processes: ``node`` running a stub ``server.mjs`` as the app, and
the supervisor as ``python -m shockbox_tui.supervisor``. Ports come from binding port 0, so a
busy machine and the real rig (8972) are both irrelevant.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from support import (
    MOCK_ENV,
    TESTS,
    alive as _alive,
    free_port,
    mock_server,
    start_supervisor,
    wait_status,
    wait_until,
    write_stub_launcher,
)
from shockbox_tui.control import Control

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX process assertions (SIGKILL, /proc)")


# ---------------------------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------------------------


@pytest.fixture
def rig(tmp_path: Path, app_dir: Path):
    """A Control pointed at a fresh install and runtime dir, plus teardown that kills all."""
    port = free_port()
    runtime = tmp_path / "runtime"
    write_stub_launcher(app_dir, port)
    ctl = Control(app_dir=app_dir, port=port, runtime_dir=runtime)
    yield ctl
    # Teardown: always through Control (it waits, then terminates whatever is left, so a wedged
    # supervisor cannot make cleanup itself hang). Then a last sweep for anything still alive.
    try:
        ctl.shutdown()
    except Exception:
        pass
    if ctl.supervisor_responding() or _alive(ctl.status().get("supervisor_pid")):
        log = ctl.paths.startup_log
        print(
            f"\n[rig] supervisor still alive after shutdown: status={ctl.status()} "
            f"log={'<none>' if not log.exists() else log.read_text()[-3000:]!r} "
            f"node_log_tail={ctl.tail_log(10)!r}"
        )
    for _ in range(3):
        status = ctl.status()
        killed = False
        for key in ("node_pid", "pid", "supervisor_pid"):
            pid = status.get(key)
            if pid and _alive(pid):
                killed = True
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except OSError:
                    pass
        # The stub is the pid the server answers with; a launcher in front of it is not ours.
        try:
            served = ctl.health()
        except Exception:
            served = None
        if served and _alive(served.get("pid")):
            killed = True
            try:
                os.kill(int(served["pid"]), signal.SIGKILL)
            except OSError:
                pass
        if not killed:
            break
        import time

        time.sleep(0.3)


def direct_supervisor(ctl: Control, *extra: str, env: dict | None = None) -> subprocess.Popen:
    """Start a supervisor directly (not via Control), as a test would on the rig."""
    return start_supervisor(ctl, *extra, env=env)


# ---------------------------------------------------------------------------------------------
# 1. start → running, stop → stopped and no restart
# ---------------------------------------------------------------------------------------------


def test_start_then_stop(rig):
    ctl = rig
    status = ctl.start()
    assert status["state"] == "running", status
    health = wait_until(lambda: ctl.health(), timeout=10)
    node_pid = status["node_pid"]
    assert health and health["ok"], health
    # What node reports is the server inside it (node may exec/wrap another process); the
    # supervisor's contract is that *some* healthy pid answers on our port.
    assert node_pid and _alive(node_pid)
    assert _alive(health["pid"]), health
    assert health["port"] == ctl.port
    # The contract in the brief: the status document carries all of these.
    for key in ("pid", "port", "state", "since", "restarts", "last_exit", "last_error", "node_pid", "health"):
        assert key in status, key
    assert status["health"]["ok"] is True
    assert status["adopted"] is False

    status = ctl.stop()
    assert status["state"] == "stopped", status
    assert not _alive(node_pid)
    assert status["next_restart_at"] is None
    assert status["restarts"] == 0
    assert status["node_alive"] is False

    # "No auto-restart": leave it stopped for several poll cycles and watch. The supervisor is
    # alive the whole time (stopped is a state, not an exit), so its status stays readable.
    import time

    for _ in range(6):
        time.sleep(0.5)
        status = ctl.status()
        assert status["state"] == "stopped", status
        assert status["restarts"] == 0
        assert ctl.supervisor_responding() is True
    assert ctl.health() is None
    assert _listeners(ctl.port) == []


# ---------------------------------------------------------------------------------------------
# 2. unexpected exit → backoff restart, restarts counter increments
# ---------------------------------------------------------------------------------------------


def test_unexpected_exit_backs_off_and_restarts(tmp_path: Path, app_dir: Path):
    port = free_port()
    ctl = Control(app_dir=app_dir, port=port, runtime_dir=tmp_path / "rt")
    write_stub_launcher(app_dir, port, mode="crash")
    try:
        ctl.start()  # may already be in `starting` or `backoff` by the time it returns
        status = wait_status(ctl.status, state="backoff", timeout=15)
        assert status is not None, ctl.status()
        assert status["restarts"] >= 1
        assert status["last_exit"] in (1, 3), status
        assert status["next_restart_at"], status

        later = wait_status(ctl.status, key="restarts", minimum=2, timeout=25)
        assert later is not None, ctl.status()
        assert later["restarts"] >= 2
        # It never gave up: backoff is a delay, not a failure.
        assert later["state"] in ("backoff", "starting", "running")
    finally:
        try:
            ctl.shutdown()
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------
# 3. shutdown leaves no child alive
# ---------------------------------------------------------------------------------------------


def test_shutdown_leaves_no_child(rig):
    ctl = rig
    status = ctl.start()
    node_pid = status["node_pid"]
    sup_pid = status["supervisor_pid"]
    assert node_pid and _alive(node_pid)
    # `supervisor_pid` is the process holding the lock; `pid` is kept for the brief's schema.
    assert sup_pid and _alive(sup_pid)
    assert status["pid"] == sup_pid
    assert status["node_alive"] is True
    # The listener is the pid the server reports, which a launcher process may front.
    assert _listeners(ctl.port) == [ctl.health()["pid"]]

    ctl.shutdown()
    wait_until(lambda: not _alive(node_pid), timeout=10)
    wait_until(lambda: not _alive(sup_pid), timeout=10)
    assert not _alive(node_pid)
    assert not _alive(sup_pid)
    assert ctl.supervisor_pid() is None
    # Not "responding" is the heartbeat judgement: give it one heartbeat interval, because the
    # last beat may be seconds old at the instant shutdown returned.
    wait_until(lambda: ctl.supervisor_responding() is False, timeout=15)
    assert ctl.supervisor_responding() is False
    assert _listeners(ctl.port) == []


# ---------------------------------------------------------------------------------------------
# 4. single instance, and a SIGKILLed supervisor's lock is not stale
# ---------------------------------------------------------------------------------------------


def test_second_supervisor_refuses_while_first_holds_lock(rig):
    ctl = rig
    first = direct_supervisor(ctl)
    try:
        assert wait_until(lambda: ctl.status().get("state") == "running", timeout=20)

        second = direct_supervisor(ctl)
        out, _ = second.communicate(timeout=20)
        assert second.returncode == 3, out
        assert b"another supervisor" in out
        # …and the first one was not disturbed.
        assert ctl.status()["state"] == "running"
    finally:
        first.terminate()
        first.wait(timeout=15)


def test_lock_is_recoverable_after_sigkill_and_node_is_adopted(rig):
    ctl = rig
    first = direct_supervisor(ctl)
    served = None
    try:
        assert wait_until(lambda: ctl.status().get("state") == "running", timeout=20)
        node_pid = ctl.status()["node_pid"]
        assert node_pid and _alive(node_pid)

        # SIGKILL: no cleanup, no lock release path. node is left behind, still serving.
        first.kill()
        first.wait(timeout=10)  # this also reaps it
        assert first.returncode == -signal.SIGKILL
        # A killed supervisor writes nothing more, so its heartbeat goes stale — and its process
        # is gone outright; both are checked, because either alone would be enough.
        wait_until(lambda: ctl.supervisor_responding() is False, timeout=15)
        assert not _alive(first.pid)
        assert ctl.supervisor_responding() is False
        assert _alive(node_pid)

        served = int(ctl.health()["pid"])
        assert served != node_pid  # the stub launcher delegates; the listener is its child
        third = direct_supervisor(ctl, env={MOCK_ENV: mock_server(served, ctl.paths.app_dir)})
        try:
            assert wait_until(lambda: ctl.supervisor_pid(), timeout=20), "lock was not recoverable"
            adopted = wait_status(ctl.status, state="running", timeout=20)
            assert adopted is not None, ctl.status()
            assert adopted["adopted"] is True, adopted
            assert adopted["node_pid"] == served
            assert _listeners(ctl.port) == [served]
        finally:
            third.terminate()
            third.wait(timeout=15)
    finally:
        if first.poll() is None:
            first.kill()
        # The orphaned server is nobody's child now; remove it so the rig stays clean.
        if served and _alive(served):
            try:
                os.kill(served, signal.SIGKILL)
            except OSError:
                pass

# ---------------------------------------------------------------------------------------------
# 5. adoption of a server started outside the supervisor
# ---------------------------------------------------------------------------------------------


def test_adopts_existing_server(tmp_path: Path, app_dir: Path, monkeypatch):
    port = free_port()
    runtime = tmp_path / "rt"
    runtime.mkdir()
    pid_file = runtime / "stub.pid"
    # The A/B orphan: a server started by the other process, which this supervisor did not
    # start. Its command line really is `<app-dir>/server.mjs`; that file runs the Python stub
    # on this test's port (node/.mjs for the same process shape as production).
    (app_dir / "server.mjs").write_text(
        "import runpy, sys\n"
        f"sys.argv = [{str(TESTS / 'stub_server.py')!r}, '--port', {str(port)!r},"
        f" '--pid-file', {str(pid_file)!r}] + sys.argv[1:]\n"
        f"runpy.run_path({str(TESTS / 'stub_server.py')!r}, run_name='__main__')\n",
        encoding="utf-8",
    )
    foreign = subprocess.Popen(
        [sys.executable, str(app_dir / "server.mjs")],
        cwd=str(app_dir),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    ctl = Control(app_dir=app_dir, port=port, runtime_dir=runtime)
    # The A/B orphan's command line is already `<app-dir>/server.mjs` (it runs the file); the
    # listener itself is the python stub that process starts. Tell the supervisor's evidence
    # check which pid serves, as in the SIGKILL test — see mock_server in support.
    monkeypatch.setenv(MOCK_ENV, mock_server(foreign.pid, app_dir))
    try:
        assert wait_until(lambda: ctl.health() is not None, timeout=10)
        foreign_pid = int(pid_file.read_text())
        assert ctl.health()["pid"] == foreign_pid
        assert wait_until(lambda: _listeners(port) == [foreign_pid], timeout=10)

        status = ctl.start()
        assert status["state"] == "running", status
        assert status["adopted"] is True, status
        assert status["node_pid"] == foreign_pid
        # Still exactly one listener: no second spawn into an occupied port.
        assert _listeners(port) == [foreign_pid]
        assert ctl.health()["pid"] == foreign_pid
    finally:
        try:
            if ctl.supervisor_responding():
                ctl.shutdown()
        except Exception:
            pass
        for proc in (foreign,):
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


# ---------------------------------------------------------------------------------------------
# 6. output capture: node's stdout lands in the dated log, tail sees it
# ---------------------------------------------------------------------------------------------


def test_output_is_captured_into_the_dated_log(rig):
    ctl = rig
    status = ctl.start()
    assert status["state"] == "running", status
    assert wait_until(lambda: any("stub: listening" in line for line in ctl.tail_log(500)), timeout=10)
    log = ctl.paths.log_file()
    assert log.exists()
    text = log.read_text(encoding="utf-8")
    assert "launcher: start node server.mjs" in text
    assert "stub: pid" in text


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------


def _alive(pid: int | None) -> bool:
    """Alive *and not a zombie*: a killed-but-unreaped child still has a pid, and a test that
    only asks os.kill(pid, 0) would call it alive forever until pytest exits."""
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    try:
        state = Path(f"/proc/{int(pid)}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return True
    return state != "Z"


def _listeners(port: int) -> list[int]:
    from shockbox_tui.supervisor import listener_pids

    return sorted(p for p in listener_pids(port) if _alive(p))
