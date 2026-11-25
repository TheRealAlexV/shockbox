# The tray app and the supervisor

`tray/ShockBox.Tray` (C# / .NET 8 WinForms) is the way the box is operated. It owns the tray
icon, the window, and the watchdog; the python supervisor it adopts or spawns owns
`node server.mjs`. This page is for someone who inherits the repo cold: what runs, which process
is responsible for which file, and what each file means.

The Textual TUI that used to sit here (`tools/tui/shockbox_tui/app.py`) was retired, and with it
the `textual` dependency. `tools/tui` survives as the supervisor package — `supervisor.py`,
`control.py`, `paths.py`, `settings.py`, `apiclient.py`, `logtail.py` — and nothing in it imports
the UI.

Every claim about the tray names `file:line` and was read from the source. Claims about the
supervisor's restart policy are carried over from the supervisor's own code and its former page;
the supervisor was not modified by the retirement.

## 1. The process tree

```
Desktop\ShockBox.lnk
  └─ <app>\ShockBox.Tray.exe                                    (tray icon, foreground)
       ├─ python -m shockbox_tui.supervisor                      (detached, survives the window)
       │    └─ node server.mjs --port 8972 ...                   (the server)
       └─ ShockBox.Tray.exe --send ...                           (CLI, no icon, no window)
```

| step | where |
|---|---|
| The shortcut runs the exe | `deploy/install.ps1:884-901` (`TargetPath` = `<app>\ShockBox.Tray.exe`, working dir = the app folder, `WindowStyle = 1`) |
| A missing exe warns instead of writing a broken link | `deploy/install.ps1:902-904` |
| The tray adopts or spawns the supervisor | `tray/ShockBox.Tray/Supervisor.cs:225-270` |
| The supervisor builds node's argv | `tools/tui/shockbox_tui/supervisor.py:569-587` |

**One tray per machine.** A global mutex `Global\ShockBox.Tray` enforces it, with a `Local\`
fallback when a restricted token refuses the global name; a second launch is a request to show
the existing window, not a second icon (`Program.cs:12-15`, `278-295`).

## 2. Adoption versus spawn

`Supervisor.EnsureSupervisor()` is called on start, restart and by the watchdog. Its core
(`Supervisor.cs:225-270`) decides in this order:

1. **Adopt** when `runtime\supervisor.pid` names a live process *and* `runtime\heartbeat` is
   fresher than 12 s (`HEARTBEAT_STALE_S`, six heartbeat intervals — `Supervisor.cs:105-112`).
   Adoption is the normal path: the supervisor outlives every UI that talks to it, and a
   supervisor left running by an earlier tray, or started as SYSTEM, is adopted like one this
   account spawned. Log line: `adopt: supervisor pid N alive, heartbeat X.Xs old`.
2. **Spawn** otherwise, through `.tui-venv\Scripts\python.exe -m shockbox_tui.supervisor`,
   detached, writing to `runtime\supervisor.log`. Log line: `spawn: supervisor pid N alive,
   heartbeat fresh`.

Proof of life is never the pid file alone: `IsAlive` requires a live pid **and** a fresh
heartbeat (`Supervisor.cs:154-162`), because either one alone lies after a hard kill or a paused
process.

Commands are the supervisor's existing file contract: `Send()` writes `runtime\cmd.json`
(`start` / `stop` / `restart` / `shutdown`) and the supervisor polls it every 250 ms. There is no
socket between the tray and the supervisor.

## 3. The watchdog

A `System.Threading.Timer` fires every 10 s (`WATCHDOG_INTERVAL_S`, the same rate the old TUI
used — `TrayContext.cs:29-30`, `78-82`). On each tick (`TrayContext.cs:224-261`) it:

- reads `status.json` and the heartbeat, and repaints the icon, tooltip and menu line;
- if the supervisor is absent or its heartbeat is stale, calls `EnsureSupervisor(skipIfBusy: true)`
  — the skip is what stops a slow spawn from queueing a second one, since spawning through that
  window is exactly how two supervisors appear;
- never respawns once the user has pressed **Shut down**: the latch is set only by shutdown and
  cleared by start/restart. **Stop** deliberately does not latch — stopping node is not a request
  to stop watching it (`TrayContext.cs:44-52`, `110-132`).

Each decision is one timestamped line in `tray.log`; the old watchdog's one real defect was that
its decisions went to a stderr nobody captured, so a respawn looked like a mystery
(`TrayLog.cs:1-10`).

## 4. The tray menu

The menu is rebuilt on open from one definition, so the CLI cannot drift from what the icon shows
(`TrayContext.cs:344-374`):

| item | action |
|---|---|
| *status line* (disabled) | `ShockBox <state> · node <pid>` — `TrayContext.cs:376-400` |
| Start | `--send start` |
| Stop | `--send stop` — stops node, leaves the supervisor watching |
| Restart | `--send restart` |
| Shut down… | confirm, then `--send shutdown` — ends both processes and latches the watchdog |
| Open window | the WebView2 shell on `http://127.0.0.1:<port>/` — `MainForm.cs:7-16` |
| Open in browser | the same URL in the default browser |
| Open log folder | `logs\` in the app folder |
| Quit | exits the tray; the supervisor and node keep running |

Closing the window does not quit: it hides and disposes the web view, and the window is rebuilt on
the next show (`MainForm.cs:40-56`). The web view profile lives in
`%LOCALAPPDATA%\ShockBox\WebView2`, not next to the exe, because the deployed tree may be
read-only or shared (`MainForm.cs:28-34`).

## 5. The CLI

Local inspection and scripted control, with no icon, window or message sink:

```
ShockBox.Tray.exe [--send start|stop|restart|shutdown] [--status] [--menu]
```

- `--send <verb>` goes through the same `Supervisor.Send` the menu uses (`Program.cs:186-196`).
- `--status` reads the same files the watchdog reads and prints supervisor pid, heartbeat age,
  `status.json` state and node pid (`Program.cs:206-240`).
- `--menu` prints the menu with 1-based numbering and `enabled=`, so a tester can see exactly what
  the shell would show (`Program.cs:184-205`).
- `--menu-show` is also handled (`Program.cs:54`) but is **not** listed in the usage string — it
  is accepted, not documented, and should be either added to the usage line or removed.

The exe is a `WinExe`, so a console caller sees nothing unless the app attaches to the parent
console; it skips that when stdout is redirected so piped output stays in the caller's file
(`Program.cs:34-40`).

## 6. `tray.log` and the runtime directory

`tray.log` lives in the machine-wide runtime dir, next to everything the supervisor publishes:
`%PROGRAMDATA%\ShockBox\runtime` on Windows, `$XDG_STATE_HOME/shockbox` (usually
`~/.local/state/shockbox`) on POSIX — resolved the same way `paths.py` resolves it
(`Supervisor.cs:9-60`). The Windows dir is machine-wide on purpose: the supervisor may run as
SYSTEM while the tray runs as the installing account, and a per-account split is what once let two
supervisors each see an empty runtime dir.

| file | writer | meaning |
|---|---|---|
| `tray.log` | tray | lifecycle and watchdog decisions, `YYYY-MM-DD HH:mm:ss tray[pid]: text` (`TrayLog.cs:16-30`) |
| `status.json` | supervisor | state, node pid, port, next restart — see §7 |
| `heartbeat` | supervisor | rewritten every ~2 s; its mtime is the freshness signal |
| `supervisor.pid` | supervisor | the pid the tray adopts |
| `supervisor.lock` | supervisor | single-instance OS file lock |
| `supervisor.log` | supervisor | detached stdout/stderr |
| `cmd.json` | tray, CLI | the verb the supervisor polls for |

A tray log that cannot be written is swallowed: a read-only runtime dir must never take the tray
down with it (`TrayLog.cs:31-38`).

## 7. State, as the tray reports it

The tray maps `status.json` plus heartbeat age onto seven icon states, each with a distinct colour
so a glance works without reading (`TrayContext.cs:467-500`):

| state | colour | when |
|---|---|---|
| Running | green | supervisor alive, node alive, health ok |
| Starting | amber | supervisor alive, node not up yet |
| Backoff | amber | supervisor alive, next restart scheduled |
| Stopped | grey | supervisor alive, node stopped on request |
| Stale | orange | supervisor alive but heartbeat older than 12 s |
| Failed | red | supervisor reports a failed state |
| No supervisor | dark grey | no `status.json`, or nothing alive |

The supervisor's own restart policy is unchanged by the retirement: 2/4/8/16/30/60 s backoff, reset
by a run that stays up 300 s (`supervisor.py:62-65`), with `status.json` written atomically and
throttled to 2 s (`supervisor.py:81-95`, `505-542`).

## 8. Promoting the icon

The tray icon itself is drawn at runtime: a 16×16 antialiased dot in the state colour, cached for
the life of the process (`TrayContext.cs:460-500`). There is no `.ico` embedded in the exe — the
csproj declares no `ApplicationIcon` (`ShockBox.Tray.csproj:1-20`).

What Explorer, the taskbar and the desktop shortcut show comes from one file, `deploy\shockbox.ico`:

- `install.ps1` copies `deploy\shockbox.ico` or a repo-root `shockbox.ico` if either exists, and
  otherwise generates a 16/32/48/256 LED-grid `.ico` with `System.Drawing`
  (`install.ps1:764-770`, `865-876`);
- the shortcut sets `IconLocation` to that file (`install.ps1:893`).

So promoting a new icon is: drop the `.ico` at `deploy\shockbox.ico` in the checkout, re-run
`install.ps1`, and the shortcut picks it up — no rebuild. To brand the exe itself as well, add
`<ApplicationIcon>shockbox.ico</ApplicationIcon>` to the csproj and rebuild; that is not done
today, and nothing requires it while the shortcut is the only entry point.

## 9. Running it by hand

```
# from the installed tree, C:\OBS\ShockBox
ShockBox.Tray.exe                # the icon
ShockBox.Tray.exe --status       # what the watchdog sees
ShockBox.Tray.exe --menu         # the menu, numbered
ShockBox.Tray.exe --send restart # the menu's Restart, no icon
```

The supervisor and its tests are run from `tools/tui` (`tools/tui/README.md`); it needs Python
3.11+ and no third-party package.
