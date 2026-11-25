# WIRING — the physical and logical topology

One Windows machine (host name `ADV-DT01`, per `deploy/ShockBox-Server.xml`), with WSL running on
the same silicon. This page is the map: what runs where, which process talks to which, and which
base URL a given browser source or key press actually reaches.

Every claim names `file:line`. Where something lives outside this repo (the host's OBS profile, the
registry, Task Scheduler) it is marked **external** and the repo-side evidence for it is given.

## 1. The boxes

```
┌──────────────────────── ADV-DT01 (Windows) ────────────────────────────┐
│                                                                        │
│  OBS Studio ──── obs-websocket (client) ──────────┐                    │
│    └ browser sources ── http://127.0.0.1:8972/… ──┤                    │
│  Stream Deck (Elgato) ── hotkeys ── AppKey ───────┤                    │
│  Sunshine (game/desktop stream host)              │                    │
│                                                   ▼                    │
│                          node server.mjs  ── listens on 127.0.0.1:8972
│                          (one process, all four modules)               │
│                                  ▲                                     │
│                          python shockbox_tui.supervisor                │
│                                  ▲ cmd.json / status.json / heartbeat  │
│                          ShockBox.Tray.exe (WinForms)                  │
│                                                                        │
├──────────────────────────── same hardware ─────────────────────────────┤
│  WSL (mirrored networking): loopback shared with Windows               │
│    /home/alex/OBS/shockbox  = dev checkout   → base URL 8973           │
│    C:\OBS\ShockBox          = deployed copy  → base URL 8972           │
│    /home/alex/OBS/tools/sd-soundctl = deck profile tooling             │
└────────────────────────────────────────────────────────────────────────┘
```

The server binds loopback by default: `HOST = arg('host', … || cfg.host || '127.0.0.1')`
(`server.mjs:49`) and `httpServer.listen(HOST, PORT)` (`server.mjs:239`). It is not reachable from
another machine unless `host` is changed in `config.json` or `--host` is passed.

## 2. Two copies of the code, two base URLs

| tree | role | base URL | evidence |
|---|---|---|---|
| `C:\OBS\ShockBox` | the deployed copy (`install.ps1` default `-Target`) | `http://127.0.0.1:8972` | `deploy/install.ps1:45`, `48-49` |
| `/home/alex/OBS/shockbox` | the dev checkout (this repo) | `http://127.0.0.1:8973` | `package.json:13` (`npm run dev`), `README.md:36-37` |

The deployed copy is a robocopy of the checkout (`deploy/install.ps1:256-283`). The checkout is
not special-cased anywhere: `server.mjs` reads its port from CLI > env > `config.json` > 8972
(`server.mjs:48`), and `config.json` is *excluded from the copy* (`deploy/install.ps1:262`). The
documented way to run the dev copy beside the deployed one is the `dev` script —
`node server.mjs --port 8973 --state ./state-dev` (`package.json:13`, also shown as
`SHOCKBOX_PORT=8973 … --state ./state-dev` in `README.md:36-37`) — so it neither binds 8972 nor
writes into the deployed `state\`. 8973 is a choice of that script, not a property of the tree.

Consequences for a maintainer:

- Editing `/home/alex/OBS/shockbox` changes nothing that is running. The running server is the
  copy at `C:\OBS\ShockBox`; the upgrade is "run `install.ps1`" (`docs/DEPLOY.md` §6).
- The deck's registry bindings and the OBS browser sources are hard-coded to
  `http://127.0.0.1:8972` (`~/OBS/deploy/streamdeck-bindings/bind-handfx-keys.ps1:27`;
  OBS profile is **external**). A dev server on 8973 will not receive deck presses.
- `config.json` holds `port`, `host`, `stateDir`, `logDir`, `soundsDir`, `compatPort` and
  `obs{url,password,enabled}`; the TUI edits it and reports `needs_restart` because node reads it
  only at start-up (`tools/tui/shockbox_tui/settings.py:5-10`, `246-280`, `34-41`).

## 3. WSL shares loopback — the mirrored-networking trap

WSL is the same physical machine. With `networkingMode=mirrored` in `.wslconfig`, a listener in
WSL and a listener on Windows compete for the *same* `127.0.0.1:<port>`. (`.wslconfig` is
**external** — it is not in this repo, so the mode cannot be checked from here.)

What that means concretely:

- A `node server.mjs --port 8972` started inside WSL occupies 8972 for Windows too. The Windows
  supervisor then sees a listener it cannot drive and refuses: `state = failed`, `last_error =
  "port 8972 is held by pid <n>, which is not this install"` (`supervisor.py:712-719`). Whether a
  WSL process is "ours" depends on the POSIX branch of `is_our_server`, which is not what runs on
  Windows.
- A WSL sidecar started to *test* something on 8972 will therefore break the real server, and
  `winps 'Invoke-WebRequest 127.0.0.1:8972/health'` can report the **WSL** process as if it were
  the app.
- **The only reliable discriminator is the pid.** `GET /health` answers `pid: process.pid` of the
  process serving that socket (`core/server-http.mjs:210-222`, `pid` at `214`). Compare it with
  `Get-Process -Id <pid>` on Windows and `ps -p <pid>` in WSL: exactly one will know it. The
  supervisor uses the same rule to decide adoption (`supervisor.py:687-696` compares
  `data["pid"]` with the listener pid).

## 4. `win` / `winps` — and why detached processes matter

`win` and `winps` are shell scripts in `~/.local/bin` that ssh to `alex@127.0.0.1:22` and run the
command on Windows. Neither is in this repo (**external**), but the rule they impose is visible in
the code that uses them:

- `winps` takes its script **positionally**, never `-Command`. The deck's binding script documents
  the form `winps '"C:\OBS\deploy\streamdeck-bindings\bind-handfx-keys.ps1" -Check'`
  (`~/OBS/deploy/streamdeck-bindings/bind-handfx-keys.ps1:9-16`), and the README repeats
  it: "`winps` takes the script **positionally**" (`~/OBS/deploy/streamdeck-bindings/README.md:59-60`).
- Anything started **inside** a `winps` invocation dies when that ssh call returns, because it is a
  child of the remote shell. The supervisor survives for a different reason: it is spawned by a
  long-lived parent (the TUI process) with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`
  (`control.py:113-120`, `150-156`), not from a short-lived remote shell.

> **Correction to the brief.** The brief said `Control.ensure_supervisor()` creates
> the supervisor through WMI `Win32_Process.Create`. It does not — it calls `subprocess.Popen`
> (`control.py:156`), and the flags are what detach it. No file in the repo calls
> `Win32_Process.Create`; `Win32_Process` appears only as a WMI *query* in the PowerShell stop
> logic (`deploy/install.ps1:101`, `113`, `234`; `deploy/uninstall.ps1:57`, `66`). If a process
> must outlive an ssh session *and* be started from one, WMI `Win32_Process.Create` is the usual
> tool — but that is not what this code does, and this page does not claim it.

## 5. OBS ⇄ ShockBox: ShockBox is the client

Direction matters and it is easy to get backwards:

- **ShockBox is an obs-websocket *client*.** `core/obs.mjs` hand-rolls the protocol: it opens
  `new WebSocket(url)`, sends `Identify` on `Hello`, and issues `Request`s
  (`core/obs.mjs:1-8`, `34-72`, `82-106`, `141-168`). The default URL is
  `ws://127.0.0.1:4455` and it reconnects with backoff (`core/obs.mjs:19`, `74-80`).
- **What it uses OBS for:** `CurrentProgramSceneChanged` (ratio forcing), scene-item surgery for
  the wall gates, source-URL updates on deploy, screenshots (`core/obs.mjs:7-8`). The ratio watcher
  lives in the wall module and subscribes through that client (`modules/wall/server.js:71-87`).
- **OBS is the *server* of that socket**, and the *client* of ShockBox's HTTP pages: every browser
  source points at `http://127.0.0.1:8972/…` and OBS's embedded browser fetches them.

Page routes, as declared by the modules (these are what an OBS browser source should point at):

| module | route | file |
|---|---|---|
| wall | `/wall/render` | `modules/wall/module.json:15` |
| notifications | `/notify` | `modules/notifications/module.json:23` |
| dialogs | `/dialogs` | `modules/dialogs/module.json:22` |
| handfx (ShockFX) | `/shockfx` | `modules/handfx/module.json:126-129` |
| handfx body (ShockFX) | `/shockfx/body` | `modules/handfx/module.json:136-137` |

The old `/handfx` and `/handfx/` URLs 301 to `/shockfx`, so a browser source saved before the
rename still resolves.

The admin shell is whatever `public/` serves at `/` (`server.mjs:58`, `core/server-http.mjs:191-205`).
Which of these each OBS scene actually uses is **external** (the OBS scene collection).

Settings that pair with OBS are core settings, not environment: `obsEnabled`, `obsUrl`,
`forceScenes`, `compatPort`, `publicUrl` (`server.mjs:127-142`), and `/health` reports the OBS
state and scene (`core/server-http.mjs:219` reports `obs: {state, scene}`, fed by
`obsStatus` in `server.mjs:227-234`).

## 6. Sounds

The notification/alert tone directory is passed to the server as `--sounds`, defaulting to
`C:\OBS\Sounds\SoundBoard` (`server.mjs:57`; supervisor side `supervisor.py:580-586`; `config.json`
key `soundsDir`). Core does not read it — the modules get it through the registry context
(`server.mjs:169`, `56-57`) and the notifications module serves the list the TUI shows
(`app.py:410-411`, `592-602`). A missing folder is a warning, not a failure (`docs/DEPLOY.md` §6).

## 7. The Stream Deck side (summary — details in `docs/DECK.md`)

The deck does not talk to ShockBox directly. A key is a Stream Deck **Hotkey** action; Windows
Explorer turns the hotkey into a `ShellExecute` command line under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\AppKey\<vk>`, and that line runs `curl`
against `http://127.0.0.1:8972/api/{wall,handfx}/cmd`
(`~/OBS/deploy/streamdeck-bindings/bind-handfx-keys.ps1:17-27`, `41-77`). A deck plugin
cannot POST on its own (`~/OBS/deploy/streamdeck-bindings/README.md:11-14`).

## 8. What is in this repo vs. what is not

| in the repo | external |
|---|---|
| server, modules, TUI, installer, `run.cmd`, the deck **binding** script | `C:\OBS\ShockBox` itself (the deployed copy) |
| the deck **profile** patcher (in `/home/alex/OBS/tools/sd-soundctl/`) | the Stream Deck profile JSON, in `%APPDATA%\Elgato\StreamDeck` |
| nothing about OBS scenes | the OBS scene collection, browser source URLs, obs-websocket password |
| nothing about WSL config | `/etc/wsl.conf`, `.wslconfig`, whether mirrored networking is on |
| nothing about Task Scheduler state | `LedWallAgent`, `ErrorPopups-Server`, `SDStart`, `StreamDeck-Launch` |
| — | `win`, `winps` in `~/.local/bin` |

`deploy/` in **this** repo does not contain `streamdeck-bindings/`; that directory lives in the
parent `~/OBS/deploy/`, next to the sibling projects (`ls /home/alex/OBS/deploy/streamdeck-bindings/`).
The patcher also points at it as `deploy/streamdeck-bindings/…` relative to the OBS project root
(`~/OBS/tools/sd-soundctl/patch-shockbox-keys.py:16-19`, `353-354`), which resolves to
`/home/alex/OBS/deploy/streamdeck-bindings/`, not to this repo.
