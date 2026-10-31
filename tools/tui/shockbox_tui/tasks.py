"""Run one blocking call off the UI thread and deliver its result back on the UI thread.

Textual's rule is one-directional: a worker thread may not touch widgets, so every result has to
come home through ``App.call_from_thread``. This module is that one crossing, written once,
stdlib only, so it can be reasoned about without a running app.

    thread = run_in_thread(app, lambda: ctl.restart(), on_done)
    # later, on the UI thread:
    def on_done(result, error):   # exactly one of them is None
        ...

Both failure paths are handled and neither is silent:

* ``fn`` raises  → ``on_done(None, str(err))``; nothing propagates out of the thread.
* ``on_done`` raises → printed to stderr, because it runs *inside* a call_from_thread callback
  where an exception would otherwise vanish into Textual's reporter and the UI would sit on a
  "running…" footer forever.

``bg_call`` is the same thing with a timeout: the UI is told as soon as the fn returns *or* the
deadline passes, whichever is first, exactly once. A timed-out call is not killed — Python has no
way to stop a thread — it is simply no longer reported on, which is the honest behaviour for an
HTTP call already bounded by the client's own timeout.
"""

from __future__ import annotations

import sys
import threading
import traceback
from typing import Any, Callable

Done = Callable[[Any, "str | None"], None]


def run_in_thread(app: Any, fn: Callable[[], Any], done: Done) -> threading.Thread:
    """Start ``fn`` on a daemon thread; call ``done(result, error)`` on the UI thread.

    ``done`` is always called exactly once. The returned thread is already started; it is never
    joined (it is a daemon, so a quit does not wait on a slow socket).
    """

    def deliver(result: Any, error: str | None) -> None:
        try:
            done(result, error)
        except Exception:  # noqa: BLE001 - the UI callback is the one thing that must not die
            print("shockbox_tui.tasks: callback failed", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def runner() -> None:
        result: Any = None
        error: str | None = None
        try:
            result = fn()
        except BaseException as err:  # noqa: BLE001 - report everything except the exit signals
            if isinstance(err, (KeyboardInterrupt, SystemExit)):
                raise
            error = str(err) or err.__class__.__name__
        try:
            app.call_from_thread(deliver, result, error)
        except Exception:  # noqa: BLE001 - the app is gone (quit mid-flight): nothing to report to
            print(f"shockbox_tui.tasks: app gone, dropped outcome ({error or result!r})", file=sys.stderr)

    thread = threading.Thread(target=runner, name="shockbox-task", daemon=True)
    thread.start()
    return thread


def bg_call(
    app: Any,
    fn: Callable[[], Any],
    done: Done,
    timeout: float | None = None,
) -> threading.Thread:
    """``run_in_thread`` with a deadline; ``done`` fires once, on the UI thread, result or timeout.

    Without ``timeout`` this is exactly ``run_in_thread``. With one, a call still running at the
    deadline reports ``TimeoutError``: the UI is released rather than left waiting on a socket
    that the client may or may not have closed.
    """
    if timeout is None:
        return run_in_thread(app, fn, done)

    settled = threading.Event()

    def once(result: Any, error: str | None) -> None:
        if settled.is_set():
            return
        settled.set()
        passed_on = [False]

        def deliver() -> None:
            if passed_on[0]:
                return
            passed_on[0] = True
            try:
                done(result, error)
            except Exception:  # noqa: BLE001
                print("shockbox_tui.tasks: callback failed", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)

        try:
            app.call_from_thread(deliver)
        except Exception:  # noqa: BLE001
            print("shockbox_tui.tasks: app gone, dropped outcome", file=sys.stderr)

    thread = run_in_thread(app, fn, once)

    def expire() -> None:
        if settled.is_set():
            return
        once(None, f"timed out after {timeout:g}s")

    timer = threading.Timer(timeout, expire)
    timer.daemon = True
    timer.start()
    return thread
