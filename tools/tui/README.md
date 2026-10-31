# ShockBox TUI

A controller for the ShockBox server that replaces `deploy/run.cmd`: it starts `server.mjs`,
captures its output into the same dated log, restarts it on an unexpected exit with the same
backoff, and edits settings — core settings over HTTP, `config.json` on disk.

> **Status:** the non-UI half. `supervisor`, `control`, `settings`, `apiclient`, `paths` and
> `logtail` are complete and tested; the Textual screen is built on top of `Control` later.

## Two processes, on purpose

```
TUI (foreground)  ──cmd.json──▶  supervisor (detached)  ──▶  node server.mjs
                  ◀─status.json──
```

The supervisor is **detached**: closing the TUI does not take ShockBox down, and the TUI is only
a viewer. It is single-instance by an OS file lock (not a pid file), so a crash cannot leave a
stale lock behind, and a second supervisor exits with a message. If node is left running by a
supervisor that was killed, the next supervisor **adopts** it (when `/health` reports the pid
that owns the port) instead of spawning a second one.

Nothing talks to the supervisor over a socket. Commands are written to `runtime/cmd.json` and
polled every 250 ms; status is written to `runtime/status.json` on every change and at least
every 2 s. Neither file can block the UI, so the UI cannot wedge.

## Run

Requires Python 3.11+ and Node (the app).

```powershell
cd tools\tui
py -3.11 -m venv .venv
.venv\Scripts\pip install -e .
.venv\Scripts\python -m shockbox_tui.supervisor --app-dir C:\OBS\ShockBox --port 8972
```

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

| Path | What |
|---|---|
| `%LOCALAPPDATA%\ShockBox\runtime\` (`~/.local/state/shockbox/` on POSIX) | the TUI's own: lock, `status.json`, `cmd.json`, `supervisor.log` |
| `<app>\logs\shockbox-YYYY-MM-DD.log` | node's stdout+stderr and the supervisor's `launcher:` lines — same file and rotation as `core/log.mjs` (8 MiB × `.1`–`.3`) |
| `<app>\state\` | the app's state, as before |

`config.json` next to `server.mjs` is never copied, printed or logged. `read_config()` masks the
obs-websocket password as `********`; only `read_config(reveal=True)` returns it, and writing the
mask back means "unchanged".

### `status.json`

```json
{
  "pid": 12345, "port": 8972,
  "state": "starting|running|backoff|stopped|failed",
  "since": "2026-10-30T12:00:00+00:00",
  "restarts": 2, "last_exit": 1, "last_error": "exit 1 after 4s",
  "node_pid": 12346, "adopted": false,
  "health": { "ok": true, "pid": 12346, "port": 8972, "obs": "connected", "modules": {}, "up": 5, "total": 5 },
  "next_restart_at": "2026-10-30T12:00:08+00:00",
  "updated": "2026-10-30T12:00:06+00:00"
}
```

`Control.status()` returns `{"state": "no-supervisor"}` when there is none, and adds
`stale: true` when the document has not been rewritten for 15 s.

### `cmd.json`

`{"id": "<uuid>", "action": "start|stop|restart|shutdown"}` — written atomically by the UI,
deleted by the supervisor **after** it acted (deletion is the acknowledgement). Idempotent:
`start` while running is a no-op, `stop` while stopped is a no-op. Commands older than 120 s are
discarded unread.

## Tests

```sh
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest -q
```

The suite starts real subprocesses: a stub app on a port from `bind(0)` and the supervisor as
`python -m shockbox_tui.supervisor`. It covers start/stop, crash backoff, clean shutdown, single
instance and lock recovery after `SIGKILL`, adoption of a server started outside the supervisor,
log tail/follow, and log rollover.

## Relationship to `deploy/`

`deploy/run.cmd` still works and still owns the scheduled-task install. Neither should supervise
at the same time: two supervisors would both spawn node, and the second would fight the port.
When the TUI is installed on the rig, disable the `\ShockBox-Server` task.
