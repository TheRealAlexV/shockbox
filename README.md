# ShockBox

One Node process that serves OBS stream overlays, built as **modules**. No build step, no npm
dependency: `server.mjs` imports only Node built-ins.

| module | what it does now |
|---|---|
| `wall` | LED wall renderer for a 1280×720 OBS browser source (`/wall/render`): LED grid, patterns, presets, blackout, bloom/streak/flare grading, a movable 9:16 fence, text slots, and a ratio key that a live forcing scene (Desktop, Theater, PHub, OnlyFans, CominOut) overrides to 16:9 |
| `notifications` | the 405×720 toast strip (`/notify`) in iOS / Android / Win11 / macOS looks, spawned from the shared message pool, stacked and auto-closing, with a per-banner tone |
| `dialogs` | fake Win95 / Win11 / macOS alert dialogs (`/dialogs`) with buttons and storm mode, from the same pool (message `kind` decides which module renders it), with a per-alert tone |
| `handfx` | hand tracking and WebGL2 effects (`/shockfx`) plus a body-tracking page (`/shockfx/body`): 23 effects, MediaPipe in the page, everything computed client-side |

ShockFX effects (23): `fireball`, `lightning`, `sparkring`, `embers`, `smoke`, `aura`, `wires`,
`frost`, `portal`, `disco`, `slime`, `inkflow`, `shatter`, `cyber`, `bloomlife`, `echo`,
`bodyonfire`, `bodysmoke`, `frozenbody`, `edit`, `electroshock`, `meteor`, `shoot`. Body tracking
(pose + selfie segmenter on `/shockfx/body`) drives `bodyonfire`, `bodysmoke` and `frozenbody`. All
rendering happens in the page: no camera frame, landmark, mask or per-frame state reaches the
server; the page posts a status line (`/ack`) only.

The message pool (`/api/pools`, core) is shared by notifications and dialogs.

Tones: both popup modules play clips from one directory — `--sounds <dir>`, env
`SHOCKBOX_SOUNDS`, config `soundsDir`, default `C:\OBS\Sounds\SoundBoard` — served at
`/audio/<name>` with an extension allow-list and a traversal guard, listed at
`/api/{notifications,dialogs}/audio/list`. The player (`modules/notifications/sound.mjs`) runs in
the page: one `<audio>` per clip, created only when `sound` is on, played once for each newly
seen banner/alert at `volume`, retried once after an autoplay block. Defaults:
notifications `sound:true`, `volume:0.6`, `tone:iphone_16_messege_tone.mp3`; dialogs
`sound:true`, `volume:0.6`, `tone:error_CDOxCYm.mp3`.

## Run

```bash
node server.mjs                       # http://127.0.0.1:8972 — admin shell at /
node server.mjs --sounds ~/Sounds     # a sound directory other than C:\OBS\Sounds\SoundBoard
SHOCKBOX_PORT=8973 node server.mjs --state ./state-dev
npm run dev                           # port 8973, state ./state-dev
```

The admin shell lists each module's pane; pages are served by ShockBox itself — point an OBS
browser source at `http://127.0.0.1:8972/<page>`.

## Tests

`npm test` runs the 10 gates below, in order, and stops on the first failure. Each boots its own
server and its own headless Chrome on free ports, so it is safe while the live server runs.

CI (`.github/workflows/test.yml`, on `push` **and** `pull_request`) runs `npm test` **and**
`npm run test:handfx-visual:strict` as two separate jobs. `npm run test:ci` approximates that
locally, but it runs the visual proof in **report mode** — a local convenience, not what CI runs.
`node test/glsl-check.mjs` is not part of `npm test`. Full detail, including the TUI's pytest
suite: [`docs/TESTING.md`](docs/TESTING.md).

| gate | proves |
|---|---|
| `test/log-rotation.mjs` | the 8 MB rotation, `.1` numbering, and the 32 MB / 64 MB caps |
| `test/ratio.mjs` | the scene-forced ratio state machine: entry, leave, restore, reconnect |
| `test/ratio-commands.mjs` | `ratio.toggle` / `ratio.force16x9` are answered by the server, not forwarded to a page |
| `test/api-smoke.mjs` | core routes ahead of module routes, the pool, `/events` channels, module assets |
| `test/pane-browser.mjs` | the wall pane in headless Chrome: renders, no overflow, a refused ratio toggle surfaces the truth |
| `test/pane-drag.mjs` | a real pointer drag of the fence: snaps to cells, previews live, commits to `/render` |
| `test/wall-browser.mjs` | the render page: engine mounts, bus commands land, the fence reaches the shader, frames animate |
| `test/handfx-browser.mjs` | handfx page + pane with a fake camera: COOP/COEP isolation, `/api/handfx/*`, bus dispatch, effect registry, zero hands on the fake device, no GL error |
| `test/panes-notify-dialogs.mjs` | the Notifications and Alerts panes in the shell, painting from the server, not local state |
| `test/sound.mjs` | the tone path: a temp sound directory is listed and served, traversal and bad extensions are refused, a missing directory lists empty and 404s, and in headless Chrome a new banner/alert builds one `<audio>` and calls `play()` once while a page load over existing banners and `sound:false` stay silent |

Separate gates (not in `npm test`):

- `npm run test:handfx` — `test/handfx-browser.mjs` alone.
- `npm run test:handfx-visual` — renders every one of the 23 effects on the real page, reads the
  canvas back, and fails if an effect draws nothing, if two effects draw the same thing, or if an
  effect violates the frame-haze bounds: composited over a white card it must not become a
  near-white flat wash (mean > 252 with chroma < 3 and < 3 % dark pixels), and its scene alpha must
  not cover more than 97 % of the frame (`smoke`, `disco`, `inkflow`, `echo`, `edit`, `embers`,
  `wires`, `shoot` are exempt by name). By default it **reports**: every check runs and failures are
  printed with their numbers, but the exit code stays 0 unless the page cannot boot. `--strict`
  (`npm run test:handfx-visual:strict`) exits 1 on any failed check — that is the local gate **and**
  the CI gate (`.github/workflows/test.yml:79-81`). Report mode is local-only, kept because
  `disco`/`slime` sit near the thresholds on a software GL stack.
- `npm run test:sound` — `test/sound.mjs` alone.
- `node test/glsl-check.mjs` — compiles the wall engine shaders in headless Chrome.

## Adding a module

A module is a folder under `modules/` with a `module.json` and an entry file. No core edit, no
build. Fields, hooks, bus and steps: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#6-adding-a-module).
Per-module API contracts: `docs/CONTRACT-{wall,notifications,dialogs,handfx}.md`.

## Deploy

On the rig: `C:\OBS\ShockBox`. Start it by double-clicking the **ShockBox** desktop shortcut; the
chain from there is

`ShockBox.lnk` → `deploy\ShockBox-TUI.cmd` → `.tui-venv\Scripts\python.exe -m shockbox_tui`
→ the TUI's detached supervisor → `node server.mjs`, listening on port 8972.

The supervisor is the process owner: it owns the port, restarts node with backoff, and survives
closing the TUI window. Nothing starts ShockBox at logon or after a reboot — the scheduled task
`ShockBox-Server` was retired (`deploy/install.ps1:285-304` ends and unregisters it), and no
`ShockBox.cmd` exists. If you want it running at logon, put the shortcut in your Startup folder;
see `deploy/README.md:63-72`. TUI detail: [`docs/TUI.md`](docs/TUI.md).

## Licence

PolyForm Noncommercial License 1.0.0 (Copyright Alexander Vanino, 2026) — see [`LICENSE`](LICENSE).
Commercial use requires a paid licence: alex@vaninollc.com. The vendored MediaPipe runtime under
`modules/handfx/vendor/` is Apache-2.0 and keeps its own licence.
