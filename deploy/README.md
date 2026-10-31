# Deploying ShockBox to the OBS host

One page: what runs, where it lives, how it starts and stops, how to upgrade and how to undo.

## What runs

ShockBox is **not** started by a scheduled task, and nothing starts it at logon. The
[TUI supervisor](tools/tui) owns the server process: it starts it, restarts it when it
crashes, and stops it in order. The desktop shortcut is the way in.

| piece | what it is |
|---|---|
| `Desktop\ShockBox.lnk` | the entry point: runs `deploy\ShockBox-TUI.cmd` |
| `deploy\ShockBox-TUI.cmd` | runs `\.tui-venv\Scripts\python.exe -m shockbox_tui` with the console in UTF-8 |
| `.tui-venv\` (in the app folder) | the TUI's own virtualenv, provisioned by `install.ps1` (`pip install -e tools\tui`) |
| `shockbox_tui` supervisor | starts node, supervises it, and keeps running after the TUI window closes |
| `node server.mjs` | the ShockBox server; all four modules are loaded in one process |
| `deploy\run.cmd` | **manual / legacy only** — a visible console with a restart loop, for when the TUI is not installed. Nothing schedules it. |

OBS browser sources point at `http://127.0.0.1:8972/<page>` (`/wall/render`, `/notify`,
`/dialogs`, `/handfx`, `/handfx/body`), and the admin shell is `http://127.0.0.1:8972/`.

## The command line

The supervisor launches the same server, with the same flags:

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
C:\OBS\ShockBox\            the installed tree (this repo, minus .git / state-dev / node_modules / backups / .tui-venv)
C:\OBS\ShockBox\.tui-venv\  the TUI supervisor's virtualenv
C:\OBS\ShockBox\state\      live state: core/, wall/, notifications/, dialogs/, handfx/, pool.json
C:\OBS\ShockBox\logs\       shockbox-YYYY-MM-DD.log   the app's log (also stdout/stderr)
                            launcher-YYYY-MM-DD.log  the legacy run.cmd loop (manual launches only)
%LOCALAPPDATA%\ShockBox\runtime\   the supervisor's lock (and control path, when it publishes one)
```

The date in every log file name is the **local** day, from `core\log.mjs`'s `localDay()`;
`deploy\run.cmd` asks PowerShell for the same day (`Get-Date -Format yyyy-MM-dd`) rather
than slicing `%date%`, whose layout follows the locale.

State and logs are never overwritten by an install; `install.ps1` copies the tree and leaves
both alone. The app rotates `shockbox-YYYY-MM-DD.log` to `.1` once it passes 8 MB — the
family (live file plus 3 predecessors) is capped at 32 MB, and `logs\` as a whole is kept
under 64 MB.

## Start and stop

Start: double-click **ShockBox** on the desktop. The TUI opens; from it you start and stop
the server. Closing the TUI does not stop the server — the supervisor survives the window,
and the app stays up.

Stop: from the TUI, or `deploy\uninstall.ps1` if you want it down for good.

There is no auto-start at logon. That is deliberate: an unattended server that comes back
after every logon is harder to reason about than one you started on purpose. If you want it
running at logon, the shortcut is the mechanism — put `ShockBox.lnk` (or
`deploy\ShockBox-TUI.cmd`) in your Startup folder.

## Restart policy

The supervisor restarts node when it exits, with the same 2/4/8/16/32/60 s backoff and the
same 5-minute reset as the old launcher: a run that stays up for 5 minutes resets the
delay, a flapping server settles at one attempt a minute instead of spinning. A crash loop
is visible in `logs\shockbox-YYYY-MM-DD.log` (`startup failed:` lines, e.g. `EADDRINUSE`).

`deploy\run.cmd` keeps the identical policy (`ping -n` rather than `timeout`, which refuses
to run with stdin redirected) for the manual case.

## Install and upgrade

Prerequisites: Node at `C:\Program Files\nodejs\node.exe` (the app), and **Python 3.11+**
for the TUI (`py -3` on this rig is 3.13). No admin is needed any more: nothing is
registered with Task Scheduler.

```powershell
# from the repo, on the host:
git pull
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1

# dry run: prints every copy, venv and shortcut command, writes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1 -WhatIf
```

What `install.ps1` does, in order:

1. **Stop** what it is about to replace, by evidence, never by name alone:
   - the **TUI supervisor** — found by its command line (`shockbox_tui`, or the holder of
     `%LOCALAPPDATA%\ShockBox\runtime\supervisor.lock`); asked to `shutdown` over its
     control path if it has one, then killed if it does not exit;
   - the legacy **`run.cmd` launcher loop** (`cmd.exe` whose command line runs `run.cmd`
     from this folder);
   - the **node holding port 8972**, only if its command line runs *this* folder's
     `server.mjs`. A process that merely owns the port, or the HTTP.sys service (pid 4), is
     reported and left alone.
2. Create `state\`, `logs\`, `backups\`; robocopy the tree (excluding `.git`, `state-dev`,
   `node_modules`, `backups`, `.tui-venv`, plus any stray `*.log` and `config*.json`).
   State and logs are never touched.
3. **Migrate off the scheduled task**: if `\ShockBox-Server` is registered, end it and
   unregister it. Idempotent; a host that never had the task prints that there was nothing
   to remove. `ErrorPopups-Server` and `LedWallAgent` are *not* touched.
4. **Provision the TUI**: find `py -3` / `python3` / `python` at 3.11 or newer, create
   `<target>\.tui-venv` if it is missing, and
   `pip install --no-input --disable-pip-version-check -e <target>\tools\tui`. No Python →
   a clear warning and the exact command to re-run; the app itself still works.
5. **Icon and shortcut**: copy `shockbox.ico` from `deploy\` or the repo root, or generate a
   deterministic 16/32/48/256 LED-grid `.ico` with System.Drawing if the project ships none
   (written to `<target>\deploy\shockbox.ico`), then create `Desktop\ShockBox.lnk` →
   `deploy\ShockBox-TUI.cmd`, working directory the app folder, normal window.

It finishes with `no auto-start at logon: start ShockBox from the desktop shortcut`.

**Upgrade from here (WSL/dev box)**: `git pull` in the checkout, then run `install.ps1` on the
host as above. The copy is the upgrade — there is no build step for the app and no
`npm install`. The venv is reused; the editable install picks up the new `tools\tui` code.

Then start the app from the shortcut and check `http://127.0.0.1:8972/health` and
`C:\OBS\ShockBox\logs\`.

## Roll back

The install keeps no previous copy, so a rollback is a git checkout, not a file restore:

```powershell
# in the source checkout
git checkout <previous-tag-or-sha>
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\install.ps1
```

The install stops the running supervisor and server (step 1 above) before copying, so the
rollback starts from a clean process state rather than an old server left running on old
files. A checkout from before the TUI simply has no `tools\tui`: the installer says so,
leaves the venv empty, and `run.cmd` is the way to run the server in that version.

State is not versioned by the install: if a bad version wrote a bad setting, fix it in
`state\core\settings.json` or the module's own document (each is JSON, and `state\<module>\`
is the module's to own). To take ShockBox down entirely:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\uninstall.ps1
```

`uninstall.ps1` stops the TUI supervisor (and the server it runs, by the same evidence rule),
removes the desktop shortcut, removes `.tui-venv`, and unregisters `\ShockBox-Server` if a
previous install left it. It does not delete the folder, the state or the logs, and it never
touches another task.

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
at 8972 through a restart. `install.ps1` removes only `ShockBox-Server`, and only because that
task started the same server the TUI now starts.

## Troubleshooting

| symptom | check |
|---|---|
| nothing on 8972 | is the TUI supervisor running? `Get-Process python*` / the lock file under `%LOCALAPPDATA%\ShockBox\runtime\`; then `logs\shockbox-*.log` |
| the shortcut opens and closes at once | `.tui-venv` is missing — the window prints the pip command; or re-run `install.ps1` |
| `EADDRINUSE` | something else owns 8972 (an old agent?) — `Get-NetTCPConnection -LocalPort 8972`; `install.ps1` only stops it if it runs *this* `server.mjs` |
| two servers fighting | a leftover `\ShockBox-Server` task — `Get-ScheduledTask ShockBox-Server`; `install.ps1` removes it |
| pages load but no state | `--state` path exists and is writable by your user |
| tones silent | `C:\OBS\Sounds\SoundBoard` exists; the pane's tone list tells you what the server sees |
| server exits at once | run `deploy\run.cmd` in a console on the host: the same command, visible |
