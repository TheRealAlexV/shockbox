# The TUI and the supervisor

The Textual controller (`tools/tui/`, package `shockbox_tui`) and the detached supervisor
that owns `node server.mjs`. This page is for someone who inherits the repo cold: what is
running, which process is responsible for which file, and what each file means.

Every claim below names `file:line`. Where the code and an older README disagree, the code wins
and the disagreement is called out.

## 1. The process tree

```
Desktop\ShockBox.lnk
  └─ deploy\ShockBox-TUI.cmd
       └─ <app>\.tui-venv\Scripts\python.exe -m shockbox_tui        (Textual window, foreground)
            └─ python -m shockbox_tui.supervisor                    (detached, survives the window)
                 └─ node server.mjs --port 8972 ...                 (the server)
```

| step | where |
|---|---|
| The shortcut runs the launcher | `deploy/install.ps1:513-523` (TargetPath = `deploy\ShockBox-TUI.cmd`, working dir = the app folder) |
| The launcher resolves the venv and execs the UI | `deploy/ShockBox-TUI.cmd:22-32` |
| `python -m shockbox_tui` is a shim onto `app.main` | `tools/tui/shockbox_tui/__main__.py:1-21` |
| `app.main` builds `Control`, calls `control.start()`, then runs the window | `tools/tui/shockbox_tui/app.py:1275-1298` |
| `start()` → `ensure_supervisor()` → spawns the supervisor | `tools/tui/shockbox_tui/control.py:122-159`, `300-307` |
| The supervisor builds node's argv | `tools/tui/shockbox_tui/supervisor.py:569-587` |

**The supervisor is detached on purpose.** `Control.ensure_supervisor()` spawns it with
`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows (`control.py:113-120`, `150-151`) and
`start_new_session=True` on POSIX (`control.py:152-155`); its stdout/stderr go to
`runtime\supervisor.log`, not the TUI console (`control.py:140`, `145-146`). The module docstring
states the intent: "The supervisor is started detached, so it outlives the TUI by design"
(`control.py:15-16`). Closing the window therefore leaves node running.

> **Caveat, verified in the repo.** The brief for this page said `ensure_supervisor()` creates the
> supervisor through WMI `Win32_Process.Create`. It does not: it calls `subprocess.Popen`
> (`control.py:156`). What keeps the supervisor alive under a launcher that dies is the pair of
> creation flags above — the TUI process has no console handle it could pass on, so a detached
> child is not killed with it. There is no `Win32_Process.Create` anywhere in the repo
> (`grep -rn "Win32_Process.Create"` matches nothing; `Win32_Process` appears only as a *query*
> in the PowerShell stop logic, e.g. `deploy/install.ps1:101`). On POSIX the counterpart is the
> new session: "no controlling terminal, no SIGHUP from the TUI's tty" (`control.py:153-155`).

Two TUI windows are harmless: the supervisor holds an OS lock and the loser exits with status 3
(`control.py:124-127`, `supervisor.py:1040-1043`).

## 2. What each button does

Buttons are declared in `ComposeResult` (`app.py:306-374`) and dispatched through the
`_BUTTONS` table (`app.py:929-962`). Keyboard bindings are `app.py:274-281` (F5 refresh, F9 start,
F10 stop, F8 restart, Ctrl+L clear log, Ctrl+Q quit).

| button | id | call |
|---|---|---|
| Start | `btn-start` | `Control.start()` — `app.py:880-885` → `control.py:300-307` |
| Stop | `btn-stop` | `Control.stop()` — `app.py:887-892` → `control.py:309-314` |
| Restart | `btn-restart` | `Control.restart()` — `app.py:894-901` → `control.py:316-322` |
| Open browser | `btn-open` | `webbrowser.open(control.url())` — `app.py:903-916`, `control.py:392-393` |
| Shut down supervisor | `btn-shutdown` | confirm modal, then `Control.shutdown()` — `app.py:918-927` → `control.py:324-352` |

`start`, `restart` and `shutdown` all begin with `ensure_supervisor()`
(`control.py:302`, `316`, `324`); `stop` does not — it returns the current status unchanged when
no supervisor is responding, because "nothing to stop" is already the requested state
(`control.py:310-311`).

**The "Shut down supervisor" button** is the only path that ends *both* processes. It shows a
`ConfirmScreen` whose question is "Shut down the supervisor and its node process?"
(`app.py:923`) — `ConfirmScreen` is a `ModalScreen[bool]` with a "Shut down" and a "Cancel"
button, Esc cancels (`app.py:199-235`). On confirm, `Control.shutdown()` writes the `shutdown`
command, waits for **both pids** to be gone (`control.py:335-340`), force-terminates anything still
alive after the timeout (`control.py:344-348`), and finally unlinks a leftover `cmd.json` so the
next supervisor does not re-read it (`control.py:349-351`).

Every action runs off the UI thread through `run_action_bg` (`app.py:795-817`); the footer
reports what the server said, never what the click hoped for (`app.py:819-854`).

> **Cross-check.** `docs/ARCHITECTURE.md` also documents the supervisor/TUI half and may be
> edited in the same working tree. This page is derived line-by-line from
> `tools/tui/shockbox_tui/*.py`; where the two disagree, the code below is what runs.

## 3. `status.json` — every field

Written by `Supervisor._write_status()` (`supervisor.py:505-542`). The base document is built in
`__init__` (`supervisor.py:463-477`) and extended by `_set_state` (`supervisor.py:496-503`).

| field | written at | meaning |
|---|---|---|
| `pid` | `supervisor.py:464` | the supervisor's own pid at construction |
| `supervisor_pid` | `supervisor.py:516` | the same pid, re-stamped on **every** write; the UI reads this one (`control.py:184`) |
| `port` | `supervisor.py:465` | the port the supervisor was told to own |
| `state` | `supervisor.py:499` | one of `starting`, `running`, `backoff`, `stopped`, `failed` (`supervisor.py:73`); asserted on every set (`supervisor.py:497`) |
| `since` | `supervisor.py:501` | ISO-8601 UTC when `state` last **changed** (not rewritten on a same-state write) |
| `restarts` | `supervisor.py:468`, incremented at `682` | count of *unexpected* node exits |
| `last_exit` | `supervisor.py:469`, `668` | exit code of the last node exit (`None` when none yet) |
| `last_error` | `supervisor.py:470`; set at `620`, `629`, `676`, `683`, `716`, `903` | one-line reason: spawn failure, `exit <code> after <n>s`, `port <p> is held by pid <n>, which is not this install`, or `supervisor: <err>` |
| `node_pid` | `supervisor.py:471`, `627`, `667`, `734`, `865`, `949` | pid of the node we spawned, or of the adopted server |
| `adopted` | `supervisor.py:472`, `628`, `735`, `948` | true when node was already running and `/health` reported that same pid (`supervisor.py:732-739`) |
| `health` | `supervisor.py:473`, `738`, `747`, `766` | a **summary**, not `/health` verbatim: `{ok, pid, port, version, uptime, obs, scene, modules, up, total}` (`supervisor.py:998-1014`) |
| `next_restart_at` | `supervisor.py:474`, `532` | wall-clock UTC when the next spawn is due; `None` whenever nothing is scheduled (including `stopped`/`failed`) |
| `app_dir` | `supervisor.py:475` | the install folder the supervisor drives |
| `supervisor_started` | `supervisor.py:476` | when this process started (never updated again) |
| `updated` | `supervisor.py:510` | when this document was last written |
| `node_alive` | `supervisor.py:517-519` | the child's own handle while we spawned it, otherwise `pid_alive(node_pid)` |

Writes are atomic (temp file + `os.replace`, `supervisor.py:81-95`) and throttled to
`STATUS_INTERVAL = 2.0 s` unless forced (`supervisor.py:505-508`, `67`); `_set_state` always
forces (`supervisor.py:503`). A write failure is logged, never raised — a full disk must not take
the supervisor down (`supervisor.py:540-541`).

`Control.status()` adds three fields of its own: `age_s` (heartbeat age, `control.py:219-223`),
`stale: true` when that age exceeds `STATUS_STALE_S = 12.0 s` (`control.py:41`, `224-225`), and —
for a stale document that is not `stopped` — `state: "no-supervisor"` plus `last_state` holding
what the document used to say (`control.py:226-229`). With no document at all it returns
`{"state": "no-supervisor", "port": …, "app_dir": …}` (`control.py:216-217`).

## 4. The rest of the runtime directory

`Paths` resolves the runtime dir to `%PROGRAMDATA%\ShockBox\runtime` on Windows and
`$XDG_STATE_HOME/shockbox` (usually `~/.local/state/shockbox`) on POSIX
(`tools/tui/shockbox_tui/paths.py:154-176`). The Windows default is machine-wide because the
supervisor runs as SYSTEM while the window runs as the installing account: a per-account dir
split them, so each side saw an empty runtime dir and started a second supervisor
(`paths.py:11-18`). `ensure()` creates it and, on Windows, applies an inheritable ACL granting
SYSTEM and the installing account modify (`paths.py:87-117`, applied at `230-252`); a directory that already has the
wrong owner is reported through `Paths.runtime_warning`, never fatal. It is deliberately
outside the install tree, because `install.ps1` robocopies over that tree (`paths.py:20-23`).

| file | property | written by | read by |
|---|---|---|---|
| `supervisor.lock` | `paths.py:196-197` | held with `flock`/`LockFileEx` for the process's life (`supervisor.py:394-421`, `1040-1043`) | the next supervisor (single instance) |
| `status.json` | `paths.py:200-201` | the supervisor (§3) | `Control.status()` |
| `heartbeat` | `paths.py:204-212` | the supervisor, every write: `<counter> <iso>\n` (`supervisor.py:533`, `539`) | `Control.supervisor_responding()` / `_status_age()` (`control.py:161-173`, `196-205`) |
| `cmd.json` | `paths.py:215-216` | `Control.send()` — temp file, fsync, `chmod 0600`, `os.replace` (`control.py:245-263`) | the supervisor's `_read_command()` (`supervisor.py:773-788`) |
| `supervisor.pid` | `paths.py:219-220` | the supervisor once, at startup (`supervisor.py:1059`) | `install.ps1` (`Get-SupervisorState`) |
| `supervisor.log` | `paths.py:223-225` | the supervisor: its own lifecycle lines (start, adopt/spawn, restart reason, signal, exit code) through `LogFile`, 2 MB, one rotation; stdout/stderr are appended to the same file by the launcher (`control.py:140`, `145-146`) | the operator, when the supervisor died before writing `status.json`, and for the chain of supervisors that came and went |

**Why the heartbeat is a separate file.** `status.json` only changes when something changes, so
it carries no freshness signal; the heartbeat is rewritten every cycle with a counter and a fresh
mtime, and the UI reads *it* to tell "alive" from "wedged" (`paths.py:204-212`,
`supervisor.py:534-539`, `control.py:196-201`). `Control.send()` accepts either acknowledgement:
the command file disappearing, **or** the heartbeat counter advancing past the value it had when
the command was written — the supervisor bumps the counter on the same tick it executes a command
(`control.py:237-239`, `265`, `278-281`; `supervisor.py:533-539`).

**The supervisor is found by its state, never by its argv.** `install.ps1` decides "a supervisor
is running" from a live pid — `supervisor.pid`, else `status.json`'s `supervisor_pid` — or, when
no pid is on file, from a `heartbeat` younger than 10 s. A live pid wins over a stale heartbeat (a
wedged supervisor still has to be stopped); a dead pid wins over a fresh heartbeat (nothing writes
one after its writer is gone). The lock file is *not* evidence: it is 0 bytes and unreadable while
it is held (the runtime files are read through `FileShare.ReadWrite`), and the supervisor's command
line misses a wrapper, a relaunch, `python -m` or a renamed exe. That mismatch is how an install
once reported "no TUI supervisor running" over a live supervisor.

**Commands are discarded when old.** A `cmd.json` older than `STALE_CMD_S = 120.0 s` is unlinked
unread (`supervisor.py:71`, `777-788`). Valid actions are `start`, `stop`, `restart`, `shutdown`
(`control.py:241-242`); the supervisor logs and ignores anything else (`supervisor.py:833-834`).
The supervisor deletes the file it executed and only that one, so a click that lands between read
and unlink is not lost (`supervisor.py:790-798`).

## 5. Restart policy

```python
BACKOFF_SEQUENCE = (2, 4, 8, 16, 30, 60)   # supervisor.py:64
HEALTHY_S = 300.0                          # supervisor.py:65
STATUS_INTERVAL = 2.0                      # supervisor.py:67
CMD_INTERVAL = 0.25                        # supervisor.py:68
HEALTH_INTERVAL = 2.0                      # supervisor.py:69
STOP_GRACE_S = 8.0                         # supervisor.py:70
STALE_CMD_S = 120.0                        # supervisor.py:71
STATES = ("starting", "running", "backoff", "stopped", "failed")  # supervisor.py:73
```

The sequence is `2, 4, 8, 16, **30**, 60` seconds — not 32. The comment above it calls it "the
restart policy of `deploy/run.cmd`, unchanged" (`supervisor.py:62-63`), and `run.cmd:27` also says
30 s; the old `deploy/README.md` said "2/4/8/16/32/60 s" and was wrong. (The last `/ 60` entry is
reused for every further attempt, `supervisor.py:656-661`.) A run that lasts `HEALTHY_S` resets
the index (`supervisor.py:680-681`). Each unexpected exit increments `restarts` and sets
`last_error` to `exit <code> after <n>s` (`supervisor.py:682-684`).

`_enter_backoff()` logs `restarting in <delay>s` through `note()` (`supervisor.py:656-661`,
`544-550`) — those lines go into the dated app log with a `launcher:` prefix, the same convention
`run.cmd` used (`supervisor.py:544-545`, `deploy/run.cmd:64`).

## 6. Adoption and port ownership

Before spawning, the supervisor asks who is listening on the port (`supervisor.py:165-228`:
`GetExtendedTcpTable` on Windows, `/proc/net/tcp*` inodes on POSIX). Then:

- not ours → `state = failed`, `last_error = "port <p> is held by pid <n>, which is not this
  install"`, and node is **not** spawned into a guaranteed `EADDRINUSE` loop
  (`supervisor.py:703-719`, `892-897`);
- ours and `/health` reports that same pid → **adopt** it (`supervisor.py:723-739`);
- ours but not answering after a 5 s grace → terminate and respawn (`supervisor.py:724-742`).

"What counts as ours" differs by platform: on Windows the supervisor cannot read another
process's command line without WMI/CIM, so the evidence is "the listener pid answered `/health`
with a ShockBox payload" (`supervisor.py:254-261`, `269-270`); on POSIX the command line must
name `<app-dir>/server.mjs` (`supervisor.py:271-288`). This is the same evidence rule
`install.ps1` uses (`deploy/install.ps1:99-107`).

## 7. Logs

Node's stdout and stderr are merged into `<app>\logs\shockbox-<local day>.log` through
`LogFile`, which mirrors `core/log.mjs`: 8 MiB per generation, four kept (`supervisor.py:33-35`,
`tools/tui/shockbox_tui/logtail.py:1-17`). The supervisor's own `launcher:` lines share that file
(`supervisor.py:544-550`). The date is the **local** day (`paths.py:131-139`). A crash before
`status.json` exists is visible only in `runtime\supervisor.log` (`paths.py:223-225`).

`deploy/run.cmd` is a separate, manual path and writes both `shockbox-*.log` and
`launcher-*.log` (`deploy/run.cmd:19-27`, `64`, `74`); the supervisor does not use it.

## 8. Running it by hand

```powershell
# the supported path
deploy\ShockBox-TUI.cmd            # == the desktop shortcut

# options the entry point accepts
.venv\Scripts\python -m shockbox_tui --help
```

| flag | default | source |
|---|---|---|
| `--app-dir` | this repo (parent of `tools/tui`) | `app.py:1267`, `paths.py:51-53` |
| `--port` | `config.json`'s `port`, else 8972 | `app.py:1268`, `paths.py:31`, `settings.py:184-189` |
| `--runtime-dir` | machine-wide `%PROGRAMDATA%\ShockBox\runtime` on Windows, `~/.local/state/shockbox` elsewhere | `app.py:1269`, `paths.py:73-84` |
| `--poll` | `1.5` s | `app.py:1270` |
| `--no-start` | off — by default the window starts the server on open | `app.py:1271`, `1290-1294` |

The window refuses to open when the folder has no `server.mjs` (`app.py:1278-1283`, exit 2). Tests
run with `pytest` from `tools/tui/`; see `tools/tui/README.md` ("Tests") and
`tools/tui/pyproject.toml:28-32`.
