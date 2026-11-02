# ShockBox TUI

A controller for the ShockBox server: it starts `server.mjs`, captures its output into the same
dated log, restarts it on an unexpected exit with the same backoff, and edits settings — core
settings over HTTP, `config.json` on disk.

The full description — process tree, every button, every `status.json` field, the runtime
directory, the restart policy — is in [`docs/TUI.md`](../../docs/TUI.md). This page is only what a
developer needs to run the package and its tests from here.

## Two processes, on purpose

```
TUI (foreground)  ──cmd.json──▶  supervisor (detached)  ──▶  node server.mjs
                  ◀─status.json──
```

Closing the TUI does not take ShockBox down: the supervisor is spawned detached
(`shockbox_tui/control.py:113-159`) and is single-instance by an OS file lock
(`shockbox_tui/supervisor.py:394-421`, `1040-1043`). Nothing talks over a socket: commands are
written to `runtime/cmd.json` and polled every 250 ms; status is written to `runtime/status.json`
on every change and at least every 2 s, with a separate `runtime/heartbeat` file proving liveness
(`shockbox_tui/paths.py:111-119`). See `docs/TUI.md` §3–§4 for the field-by-field contracts.

## Run

Requires Python 3.11+ (`pyproject.toml`, `requires-python`) and Node (the app).

```powershell
cd tools\tui
py -3.11 -m venv .venv
.venv\Scripts\pip install -e .
.venv\Scripts\python -m shockbox_tui --app-dir C:\OBS\ShockBox
```

`python -m shockbox_tui` is the same entry the desktop shortcut uses through
`deploy\ShockBox-TUI.cmd` (`shockbox_tui/__main__.py:1-21`,
`shockbox_tui/app.py:1275-1298`). Options: `--app-dir`, `--port`, `--runtime-dir`, `--poll`,
`--no-start` (`shockbox_tui/app.py:1267-1271`).

Or, from Python (what the TUI does):

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
| `shockbox_tui/control.py` | what the UI calls; no Textual, no threads |
| `shockbox_tui/app.py` | the Textual screen |
| `shockbox_tui/settings.py`, `apiclient.py`, `paths.py`, `logtail.py` | settings, HTTP, paths, log file |
| `%LOCALAPPDATA%\ShockBox\runtime\` (`~/.local/state/shockbox/` on POSIX) | lock, `status.json`, `heartbeat`, `cmd.json`, `supervisor.pid`, `supervisor.log` (`shockbox_tui/paths.py:101-135`) |
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
and the supervisor as `python -m shockbox_tui.supervisor` (`tests/test_control.py:1-8`). Across the
48 tests it covers start/stop, crash backoff, clean shutdown, single instance and adoption, log
tail/follow/rollover, settings and the Textual screen (`tests/test_control.py:172`, `220`, `268`;
`tests/test_logtail.py:76`, `87`; `tests/test_app.py:470`).
