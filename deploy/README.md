# Deploying ShockBox to the OBS host

One page: what runs, where it lives, how it restarts, how to upgrade and how to undo.

## What runs

| piece | what it is |
|---|---|
| `\ShockBox-Server` (scheduled task) | runs `wscript.exe "C:\OBS\ShockBox\deploy\start-hidden.vbs"` at logon for `ADV-DT01\Alex`, hidden, no time limit, `IgnoreNew` if already running, `StartWhenAvailable`, no battery stops — the same settings as the old `ErrorPopups-Server` task |
| `deploy\start-hidden.vbs` | starts `deploy\run.cmd` with no window (`WScript.Shell.Run …, 0, False`) |
| `deploy\run.cmd` | the one entry point: runs node, waits for it to exit, restarts it with backoff |
| `node server.mjs` | the ShockBox server; all four modules are loaded in one process |

OBS browser sources point at `http://127.0.0.1:8972/<page>` (`/wall/render`, `/notify`,
`/dialogs`, `/handfx`, `/handfx/body`), and the admin shell is `http://127.0.0.1:8972/`.

## The command line

```bat
"C:\Program Files\nodejs\node.exe" server.mjs --port 8972 --state "%APP%\state" --log-dir "%APP%\logs" --sounds "C:\OBS\Sounds\SoundBoard"
```

with the working directory set to `C:\OBS\ShockBox`. `%APP%` is the folder above `deploy\`, so
an install anywhere else works with no edit.

| flag | value on the rig | why |
|---|---|---|
| `--port` | `8972` | the port the retired LED wall agent used; one server now owns it |
| `--state` | `C:\OBS\ShockBox\state` | settings, pools, per-module documents |
| `--log-dir` | `C:\OBS\ShockBox\logs` | the app log file (see below) |
| `--sounds` | `C:\OBS\Sounds\SoundBoard` | the notification/alert tone clips; a missing folder is a warning, not a failure |

## Where things are

```
C:\OBS\ShockBox\          the installed tree (this repo, minus .git / state-dev / node_modules / backups)
C:\OBS\ShockBox\state\    live state: core/, wall/, notifications/, dialogs/, handfx/, pool.json
C:\OBS\ShockBox\logs\     shockbox-YYYY-MM-DD.log   the app's log (also stdout/stderr)
                          launcher-YYYY-MM-DD.log  every start, exit code and restart wait
```

State and logs are never overwritten by an install; `install.ps1` copies the tree and leaves both
alone. The app rotates `shockbox-YYYY-MM-DD.log` to `.1` once it passes 4 MB.

## Restart policy

`run.cmd` supervises node:

- node exits (crash, `process.exit`, port in use, anything) → the loop logs the exit code and how
  long the run lasted, then restarts.
- backoff doubles from 2 s: 2, 4, 8, 16, 32, 60 s, then 60 s. A run that stays up for 5 minutes
  resets it to 2 s, so a flapping server settles at one attempt a minute instead of spinning.
- the wait is `ping -n <s> 127.0.0.1`, not `timeout`: `timeout` refuses to run when stdin is
  redirected, which it is under wscript.
- a logon restarts everything anyway: the task is a logon trigger, and `IgnoreNew` means a second
  logon while one is running does nothing.

A crash loop is visible in `logs\launcher-YYYY-MM-DD.log` (repeated `exited N after 0s`) and in
the app log (`startup failed:` from `server.mjs`, e.g. `EADDRINUSE`).

## Install and upgrade

Prerequisites: Node at `C:\Program Files\nodejs\node.exe`, and an elevated PowerShell for the task
step (`Register-ScheduledTask` needs admin).

```powershell
# from the repo, on the host:
git pull
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1

# dry run: prints every copy and task command, writes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1 -WhatIf
```

`install.ps1` is idempotent: create the folders, robocopy the tree (excluding `.git`,
`state-dev`, `node_modules`, `backups`, plus any stray `*.log` and `config*.json`), replace the
task from `deploy\ShockBox-Server.xml`, `schtasks /change /enable`, then `schtasks /run` once.
Refuses to run from a folder without `server.mjs`.

**Upgrade from here (WSL/dev box)**: `git pull` in the checkout, then run `install.ps1` on the
host as above. The copy is the upgrade — there is no build step and no npm install.

Then check `http://127.0.0.1:8972/health` and `C:\OBS\ShockBox\logs\`.

## Roll back

The install keeps no previous copy, so a rollback is a git checkout, not a file restore:

```powershell
# in the source checkout
git checkout <previous-tag-or-sha>
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1
```

State is not versioned by the install: if a bad version wrote a bad setting, fix it in
`state\core\settings.json` or the module's own document (each is JSON, and `state\<module>\`
is the module's to own). To take ShockBox down entirely:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\uninstall.ps1
```

`uninstall.ps1` stops and unregisters `\ShockBox-Server` only. It does not delete the folder, the
state or the logs, and it never touches another task.

## Retiring the old tasks (not done by this deploy)

ShockBox takes port 8972, which the LED wall agent used, and replaces the popup server on 8787.
Start ShockBox **before** disabling the old tasks, or OBS loses the wall page for the gap. Order:

```powershell
schtasks /Change /TN LedWallAgent /DISABLE
schtasks /Change /TN ErrorPopups-Server /DISABLE
schtasks /End    /TN LedWallAgent
schtasks /End    /TN ErrorPopups-Server
```

Leave them registered but disabled for a few days; delete only once the OBS sources have pointed
at 8972 through a restart.

## Troubleshooting

| symptom | check |
|---|---|
| nothing on 8972 | `logs\launcher-*.log` — if it is absent, the task never ran (`Get-ScheduledTask ShockBox-Server`) |
| `EADDRINUSE` | something else owns 8972 (an old agent?) — `netstat -ano \| findstr :8972` |
| pages load but no state | `--state` path exists and is writable by the task's user |
| tones silent | `C:\OBS\Sounds\SoundBoard` exists; the pane's tone list tells you what the server sees |
| task runs but exits at once | run `deploy\run.cmd` in a console on the host: the same command, visible |
