# Deployment: install, run, upgrade, uninstall

Everything about putting ShockBox on the rig: what runs, where it lives, how it starts and stops,
how to upgrade, how to undo. Absorbed from the old `deploy/README.md`, corrected against the code
where the old page was wrong (notably the backoff sequence, §5).

## 1. What runs, and who owns it

ShockBox is **not** started by a scheduled task any more. `install.ps1` ends and unregisters any
`\ShockBox-Server` it finds (`deploy/install.ps1:285-304`), because an old registration would start
a second server at the next logon. The installer finishes with `no auto-start at logon: start
ShockBox from the desktop shortcut` (`deploy/install.ps1:534`).

| piece | what it is |
|---|---|
| `Desktop\ShockBox.lnk` | the entry point; created by the installer (`deploy/install.ps1:510-531`) |
| `deploy\ShockBox-TUI.cmd` | runs `<app>\.tui-venv\Scripts\python.exe -m shockbox_tui` with the console in UTF-8 (`deploy/ShockBox-TUI.cmd:18`, `24`, `32`) |
| `.tui-venv\` (app folder) | the TUI's virtualenv, provisioned by `install.ps1` (`deploy/install.ps1:344-384`) |
| the supervisor (`python -m shockbox_tui.supervisor`) | starts node, restarts it, survives the TUI window (`docs/TUI.md`, `supervisor.py:1-40`) |
| `node server.mjs` | all modules in one process (`server.mjs:189-194`) |
| `deploy\run.cmd` | **manual / legacy only** — a visible console with its own restart loop (`deploy/run.cmd:3-17`) |

Since 2026-10-31 (decided), nothing restarts ShockBox after a logoff or reboot: the user
double-clicks the shortcut. Putting `ShockBox.lnk` in the Startup folder would restore auto-start
without a task, and is the mechanism the old page recommended (`deploy/run.cmd:5-7` says the same
of the supported path).

**Still in Task Scheduler, Disabled:** `ErrorPopups-Server` and `LedWallAgent`. `install.ps1`
deliberately does not touch them (`deploy/install.ps1:18-20`, `289`); `LedWallAgent` was the old
owner of port 8972. See §9 for the one-time order to retire them.

## 2. The command line the supervisor runs

```bat
"C:\Program Files\nodejs\node.exe" server.mjs --port 8972 --state <app>\state --log-dir <app>\logs --sounds "C:\OBS\Sounds\SoundBoard"
```

Built in `Supervisor.node_argv()` (`tools/tui/shockbox_tui/supervisor.py:569-587`), with the
working directory set to the app folder (`supervisor.py:601-618`, `cwd=` at `603`).

| what | value | source |
|---|---|---|
| node executable | `--node`, else `SHOCKBOX_NODE`, else `C:\Program Files\nodejs\node.exe` if it exists, else `node` on PATH | `supervisor.py:557-567`; `run.cmd` does the same existence test at `deploy/run.cmd:35-36` |
| `--port` | 8972 (from `config.json`, else `DEFAULT_PORT`) | `supervisor.py:447`, `573-574`; `paths.py:31`; `settings.py:184-189` |
| `--state` | `<app>\state` | `supervisor.py:575-576`; `paths.py:92-94` |
| `--log-dir` | `<app>\logs` | `supervisor.py:577-578`; `paths.py:88-90` |
| `--sounds` | `config.json`'s `soundsDir`, else `C:\OBS\Sounds\SoundBoard` | `supervisor.py:580-586`; `settings.py:178-181` |

The server itself resolves every flag as **CLI > env > `config.json` > default**
(`server.mjs:9`, `48-62`), and creates the state dir if missing (`server.mjs:64`).

`deploy\run.cmd` runs the same flags from batch variables and owns its own restart loop
(`deploy/run.cmd:35-40`, `74`).

## 3. Where things are

```
C:\OBS\ShockBox\                  the installed tree (copy of the repo, minus what §6 excludes)
C:\OBS\ShockBox\.tui-venv\        the TUI's virtualenv
C:\OBS\ShockBox\config.json       port, host, stateDir, logDir, soundsDir, obs{url,password,enabled}
C:\OBS\ShockBox\state\            core/, wall/, notifications/, dialogs/, handfx/, pool.json
C:\OBS\ShockBox\logs\             shockbox-YYYY-MM-DD.log (+ .1 to .3); launcher-*.log from run.cmd only
%LOCALAPPDATA%\ShockBox\runtime\  supervisor.lock, status.json, heartbeat, cmd.json, supervisor.pid, supervisor.log
```

State and logs live under the install tree: `Paths.logs_dir`/`state_dir` are
`<app_dir>/logs` and `<app_dir>/state` (`paths.py:88-94`), and the runtime dir is the one thing
kept outside, precisely so the installer's copy cannot rotate the lock away (`paths.py:11-13`).
Every runtime file and field is documented in `docs/TUI.md` §3–§4.

The date in a log file name is the **local** day, from `localDay()` in `server.mjs`
(`server.mjs:72-77`); `run.cmd` asks PowerShell for the same day rather than slicing `%date%`
(`deploy/run.cmd:119-135`).

**Log budget.** `core/log.mjs` rotates one file to `.1` past 8 MiB and keeps 3 predecessors; the
ceiling that actually holds is a directory prune in `server.mjs` — 64 MiB for the whole `logs\`
directory, 4 files per family (`shockbox-*`, `launcher-*`), run at start-up and every 15 minutes
(`server.mjs:93-119`, `101`, `106`). The supervisor's `LogFile` applies the same 8 MiB/keep-4 rule
so the two writers of one file agree (`tools/tui/shockbox_tui/logtail.py:1-17`,
`supervisor.py:33-35`).

## 4. Start and stop

- **Start:** double-click **ShockBox** on the desktop. The TUI opens and — by default —
  `app.main` calls `control.start()` before showing the window (`app.py:1290-1294`).
- **Close the window:** node keeps running; the supervisor is detached (`docs/TUI.md` §1).
- **Stop node only:** the TUI's Stop button, or F10 (`app.py:274-281`, `887-892`).
- **Stop everything:** the TUI's **Shut down supervisor** button, behind a confirmation modal
  (`app.py:918-927`) — see `docs/TUI.md` §2.
- **Take it down for good:** `deploy\uninstall.ps1` (`deploy/uninstall.ps1`, §10 below).

## 5. Restart policy

The supervisor restarts node when it exits unexpectedly, with `BACKOFF_SEQUENCE =
(2, 4, 8, 16, 30, 60)` seconds (`supervisor.py:62-65`). A run that stays up `HEALTHY_S = 300 s`
resets the sequence (`supervisor.py:65`, `680-681`), so a flapping server settles at one attempt
per minute.

> The old `deploy/README.md` said `2/4/8/16/**32**/60`. That was wrong. The supervisor's comment
> says "the restart policy of `deploy/run.cmd`, unchanged" (`supervisor.py:62-63`), `run.cmd`'s
> header says `2s, 4s, 8s, 16s, 30s, 60s` (`deploy/run.cmd:27`), and `run.cmd` doubles then caps at
> 60: `BACKOFF` starts at 2, `NEXT = BACKOFF*2`, `if NEXT > 60 then 60` (`deploy/run.cmd:46`, `87-89`).

A crash loop is visible in `logs\shockbox-*.log` as `startup failed:` lines (written by
`server.mjs:331-334`) and, with the supervisor, as `launcher: exited <code> after <n>s` /
`launcher: restarting in <n>s` lines (`supervisor.py:663-684`, `656-660`, `544-550`).

## 6. Install and upgrade

Prerequisites: Node at `C:\Program Files\nodejs\node.exe` (a missing one is a warning, not a
failure — `deploy/install.ps1:71-74`), and **Python 3.11+** for the TUI (`install.ps1:334-339`).
No admin is needed: nothing is registered with Task Scheduler (`deploy/install.ps1:537`).

```powershell
# from the repo, on the host:
git pull
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1

# dry run: prints every copy, venv and shortcut command, writes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1 -WhatIf
```

What `install.ps1` does, in order (line ranges in `deploy/install.ps1`):

1. **Stop what it is about to replace, by evidence, never by name alone** (`183-244`):
   - the **TUI supervisor**, found by its published state: a live `supervisor.pid` (else
     `status.json`'s `supervisor_pid`), or a `heartbeat` younger than 10 s when no pid is on file
     (`119-206`); asked to shut down over a control path if one exists,
     then killed if it does not exit within 5 s (`151-212`);
   - the legacy **`run.cmd` loop** — `cmd.exe` whose command line runs `run.cmd` from this folder
     (`218-223`);
   - the **node holding the port**, only if its command line runs *this* folder's `server.mjs`;
     pid 4 (HTTP.sys) and strangers are reported and left alone (`225-237`, `99-107`).
2. Create `state\`, `logs\`, `backups\` (`249-254`).
3. **Robocopy the tree** with `/E` — never `/MIR` — excluding `.git`, `state-dev`, `node_modules`,
   `backups`, `.tui-venv`, editor dirs, plus `*.log` and `config*.json`; the target's `state`,
   `logs` and `backups` are excluded on the target side too, so live data is never deleted
   (`256-283`). Exit codes 0–7 are success, ≥8 is a failure (`278`).
4. **Migrate off the scheduled task**: end and unregister `\ShockBox-Server` if present; idempotent
   (`285-304`). `ErrorPopups-Server` and `LedWallAgent` are not touched (`289`).
5. **Provision the TUI**: find `py -3` / `python3` / `python` at 3.11+ (`309-342`), create
   `<target>\.tui-venv` if missing (`355-370`), then
   `pip install --no-input --disable-pip-version-check -e <target>\tools\tui` (`375-381`). No
   Python → a loud warning and the exact re-run command; the app itself still works (`349-352`).
6. **Icon**: copy `deploy\shockbox.ico` or the repo-root `shockbox.ico`, else generate a
   deterministic 16/32/48/256 LED-grid `.ico` with System.Drawing (`386-505`).
7. **Shortcut**: `Desktop\ShockBox.lnk` → `deploy\ShockBox-TUI.cmd`, working dir the app folder,
   `WindowStyle = 7` (minimised) (`507-531`).

**Upgrade from here (WSL/dev box):** `git pull` in the checkout, then run `install.ps1` on the
host. The copy *is* the upgrade — no build step, no `npm install`. The venv is reused; the editable
install picks up new `tools\tui` code (`375-381`).

Then start from the shortcut and check `http://127.0.0.1:8972/health` and `C:\OBS\ShockBox\logs\`.

> **Known gap: `control.path` has a reader and no writer.** `install.ps1:151-181`
> (`Send-SupervisorShutdown`) reads `%LOCALAPPDATA%\ShockBox\runtime\control.path` and, if it
> exists, speaks a named pipe or POSTs `{"command":"shutdown"}` to it. **Nothing in this repo writes
> that file.** `Paths.resolve()` derives the runtime dir itself — `SHOCKBOX_RUNTIME_DIR`, else
> `%LOCALAPPDATA%\ShockBox\runtime`, else `$XDG_STATE_HOME/shockbox`
> (`tools/tui/shockbox_tui/paths.py:68-77`) — and the supervisor's only command channel is
> `cmd.json` (`supervisor.py:773-788`). So today the read never matches: `Send-SupervisorShutdown`
> returns `$false` at the first `Test-Path` and the installer falls back to
> `Stop-Process -Force` (`deploy/install.ps1:200-209`).
>
> That still works in practice: the forced exit is a hard kill, so `python -m shockbox_tui.supervisor`
> cannot run its `finally` (`supervisor.py:1064-1068`) and `cleanup()` (`supervisor.py:982-995`). What
> makes that safe is the **next** start: `_listener_pid()` finds node still listening,
> `is_our_server()` accepts it, `_health_at(pid)` reports that same pid, and the new supervisor
> **adopts** it instead of spawning a second server or failing with `EADDRINUSE`
> (`supervisor.py:703-742`). The cost is that node runs one generation stale until the next restart.
> **Owner action:** either have the supervisor write its endpoint into `control.path` at start-up
> (and unlink it on exit), or delete the read from `install.ps1`. Until one is done, treat the
> control path as dead code — and do not document it as a feature. If the writer is added, it must
> speak the two shapes the installer already accepts: a named-pipe name (the script sends the line
> `shutdown`) or an HTTP URL (the script POSTs `{"command":"shutdown"}`)
> (`deploy/install.ps1:159-179`).

## 7. Roll back

The install keeps no previous copy, so a rollback is a git checkout, not a file restore:

```powershell
# in the source checkout
git checkout <previous-tag-or-sha>
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1
```

The install stops the running supervisor and server (step 1) before copying, so a rollback starts
from a clean process state. A checkout from before the TUI has no `tools\tui`: the installer warns
and leaves the venv empty (`372-374`), and `run.cmd` is the way to run that version.

State is not versioned by the install. If a bad version wrote a bad setting, fix it in
`state\core\settings.json` or the module's own document — each is JSON, and `state\<module>\` is
the module's to own (`server.mjs:179-182`).

## 8. Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\uninstall.ps1
# or, first: -WhatIf
```

`uninstall.ps1` stops the supervisor (and the server it runs, by the same evidence rule), removes
the desktop shortcut, removes `.tui-venv`, and unregisters `\ShockBox-Server` if a previous install
left it (`deploy/uninstall.ps1:1-32`; shortcut at `140`, venv at `154`, task at `129`). It does
**not** delete the folder, the state or the logs, and never touches another task
(`deploy/uninstall.ps1:11-15`).

## 9. One-time retirement of the old tasks

ShockBox takes port 8972, which the LED wall agent used, and replaces the popup server on 8787.
Start ShockBox **before** disabling the old tasks, or OBS loses the wall page for the gap:

```powershell
schtasks /Change /TN LedWallAgent /DISABLE
schtasks /Change /TN ErrorPopups-Server /DISABLE
schtasks /End    /TN LedWallAgent
schtasks /End    /TN ErrorPopups-Server
```

Leave them registered but disabled for a few days; delete only once the OBS sources have pointed
at 8972 through a restart. This is the old page's procedure, unchanged
(`deploy/README.md` history; task names also appear in `deploy/install.ps1:18-20`, `289`).

> **Unverified against the live host.** Whether both tasks are *currently* disabled cannot be read
> from this repo — that state lives in Task Scheduler on ADV-DT01. `schtasks /Query /TN <name>` is
> the check.

## 10. Troubleshooting

| symptom | check |
|---|---|
| nothing on 8972 | is the supervisor running? `runtime\status.json` and `runtime\heartbeat` (fresh mtime), then `logs\shockbox-*.log` and `runtime\supervisor.log` |
| the shortcut opens and closes at once | `.tui-venv` is missing — the window prints the pip commands and waits (`deploy/ShockBox-TUI.cmd:36-48`) |
| `EADDRINUSE` | something else owns 8972 — `Get-NetTCPConnection -LocalPort 8972 -State Listen`. `install.ps1` only stops it if it runs *this* `server.mjs` (`deploy/install.ps1:225-237`); the supervisor likewise refuses to adopt a stranger (`supervisor.py:712-719`) |
| a WSL `node server.mjs` answers on 8972 | WSL shares loopback (see `docs/WIRING.md` §3). Compare `/health`'s `pid` with `Get-Process` on Windows |
| two servers fighting | a leftover `\ShockBox-Server` task — `Get-ScheduledTask ShockBox-Server`; `install.ps1` removes it (`deploy/install.ps1:285-304`) |
| pages load but no state | the `--state` path exists and is writable (`server.mjs:64`) |
| tones silent | `C:\OBS\Sounds\SoundBoard` exists; the TUI's tone list shows what the server sees (`app.py:592-602`, `410-411`) |
| server exits at once | run `deploy\run.cmd` in a console on the host: the same command line, visible (`deploy/run.cmd:74`) |
| supervisor "stale" in the TUI | heartbeat older than 12 s (`control.py:41`, `224-225`); `runtime\supervisor.log` and the dated log hold the last words |

## 11. Test-suite notes (2026-10-31)

The `npm test` chain (`package.json:14`) reported two failures for the other lane. Both were
checked by repeated isolated runs on this machine (Linux, Node v24.12.0):

| gate | classification | evidence |
|---|---|---|
| `test/api-smoke.mjs` — `SyntaxError: Unexpected token '<'` | **not reproducible, no root cause found in the repo** | 7/7 isolated runs exit 0 (`node test/api-smoke.mjs`, before and after `test/ratio-commands.mjs`, a test that binds its own port); zero leaked listeners after each gate (`/proc/net/tcp` LISTEN-inode delta). The error text never appears in any repo file or saved run log. The only `JSON.parse` on fetched text in the file is guarded (`test/api-smoke.mjs:70-73`), so a bare `SyntaxError` cannot come from it as committed. It points at *another* consumer of the chain output (a wrapper parsing a non-JSON body as JSON) or at a server that answered a page — neither is reproducible here. Re-run the full `npm test` and capture the failing gate's own output before assuming this file. |
| `test/handfx-browser.mjs` — `electroshock draws from the scene snapshot` returned all zeros | **test defect (wrong probe points), not a product bug** | The shader draws its ring on `u_radius = 0.02 + age * 1.6` (`modules/handfx/pages/js/engine/fx.js:1416-1424`) sampling the scene snapshot (`SNAPSHOT_EFFECTS` at `:286`). The old check probed page-x 0.5 (the hole) and 0.82 (0.49 field units at the 1280×633 run size) — both off the ring, so it read `centre:0, edge:0` while the frame held ~110k lit pixels at max alpha 255. The check now reads the whole frame in field units and asserts the shockwave is drawn *on and outside* its front (`innerEdge >= radius - 0.05`). 6/6 full-file runs pass. |
