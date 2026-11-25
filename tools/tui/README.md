# tools/tui — the supervisor

The python half of ShockBox. It is not a UI: the tray app (`tray/ShockBox.Tray`) is the UI, and
this package is the detached supervisor it adopts or spawns, plus the modules that supervisor uses
to read status, write commands and edit settings.

The supervisor owns `node server.mjs`: it starts node, captures its output into the same dated log,
restarts it on an unexpected exit with the same backoff, and keeps running after the
tray's window closes. It imports nothing outside the standard library — **no third-party
dependencies** (`pyproject.toml`, `dependencies = []`).

The full description — process tree, adoption versus spawn, the watchdog, every `status.json`
field, the runtime directory, the restart policy — is in [`docs/TRAY.md`](../../docs/TRAY.md).
This page is only what a developer needs to run the package and its tests from here.

## Two processes, on purpose

```
ShockBox.Tray.exe (foreground)  ──cmd.json──▶  supervisor (detached)  ──▶  node server.mjs
                                ◀─status.json──
```

Closing the tray's window does not take ShockBox down: the supervisor is spawned detached
(`shockbox_tui/control.py:113-159`) and is single-instance by an OS file lock
(`shockbox_tui/supervisor.py:394-421`, `1040-1043`). Nothing talks over a socket: commands are
written to `runtime/cmd.json` and polled every 250 ms; status is written to `runtime/status.json`
on every change and at least every 2 s, with a separate `runtime/heartbeat` file proving liveness
(`shockbox_tui/paths.py:111-119`). See `docs/TRAY.md` §6–§7 for the field-by-field contracts.

## Run

Requires Python 3.11+ (`pyproject.toml`, `requires-python`) and Node (the app).

```powershell
cd tools\tui
py -3.11 -m venv .venv
.venv\Scripts\pip install -e .
.venv\Scripts\python -m shockbox_tui.supervisor --app-dir C:\OBS\ShockBox
```

The tray spawns exactly that command through `<app>\.tui-venv\Scripts\python.exe`
(`tray/ShockBox.Tray/Supervisor.cs:225-270`). On the rig you normally never run it by hand — the
tray's watchdog starts it if it is missing.

Or, from Python (what the tray's `--send` and `--status` call):

```python
from shockbox_tui.control import Control

ctl = Control(app_dir=r"C:\OBS\ShockBox", port=8972)
ctl.start()                      # ensure supervisor, then start node
ctl.status()                     # {'state': 'running', ...} — never raises when stopped
ctl.tail_log(200)                # last 200 lines of today's log
ctl.health()                     # /health, or None
ctl.settings()                   # core + module settings + masked config.json
ctl.patch({"forceScenes": ["Desktop"]})
ctl.restart()
ctl.shutdown()                   # stop node and the supervisor
```

## Files

| path | what |
|---|---|
| `shockbox_tui/supervisor.py` | the detached supervisor: owns node, restarts it, writes status |
| `shockbox_tui/control.py` | the control surface the tray calls; no threads, no UI |
| `shockbox_tui/settings.py`, `apiclient.py`, `paths.py`, `logtail.py` | settings, HTTP, paths, log file |
| `%PROGRAMDATA%\ShockBox\runtime\` (`~/.local/state/shockbox/` on POSIX) | lock, `status.json`, `heartbeat`, `cmd.json`, `supervisor.pid`, `supervisor.log` (`shockbox_tui/paths.py:101-135`); the tray adds `tray.log` |
| `<app>\logs\shockbox-YYYY-MM-DD.log` | node's stdout+stderr and the supervisor's `launcher:` lines — same file and rotation as `core/log.mjs` (`shockbox_tui/logtail.py:1-17`) |
| `<app>\state\` | the app's state, as before (`shockbox_tui/paths.py:92-94`) |

`config.json` next to `server.mjs` is never copied, printed or logged. `read_config()` masks the
obs-websocket password as `********`; only `read_config(reveal=True)` returns it, and writing the
mask back means "unchanged" (`shockbox_tui/settings.py:86-103`, `155-161`).

## Tests

```sh
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest -q
```

The suite starts real subprocesses: a stub app on a port taken from `bind(0)` (`tests/support.py:48`)
and the supervisor as `python -m shockbox_tui.supervisor` (`tests/test_control.py:1-8`). It covers
start/stop, crash backoff, clean shutdown, single instance and adoption, log tail/follow/rollover
and settings (`tests/test_control.py:172`, `220`, `268`; `tests/test_logtail.py:76`, `87`). The UI
tests went with the Textual app. `tests/test_control.py` hangs in its `rig` fixture teardown — a
known, pre-existing fault; skip it with `--ignore=tests/test_control.py` when it bites.
