# ShockBox

One served app for OBS stream overlays, built as a set of **modules**:

| module | what it is |
|---|---|
| `wall` | the LED wall renderer (one page, 16:9, with a 9:16 fence toggle) + the wall admin pane |
| `notifications` | small toasts (iOS / Android / Win11 / macOS styles) with a message pool, queue and repeats |
| `dialogs` | fake Windows / macOS alert dialogs with buttons, cursor and storm mode |
| `handfx` | wasm hand/body tracking + layered WebGL2 effects (lightning, fireball, body on fire, smoke, portal, …) |

Every front end is served by ShockBox itself. Adding a feature is adding a folder under `modules/`
— there is no core edit, no build step for a module, and no dependency to install.

## Run

```bash
node server.mjs                      # http://127.0.0.1:8972 — admin shell at /#/wall
SHOCKBOX_PORT=8973 node server.mjs --state ./state-dev
npm test                             # every gate: unit, contract, and real-browser checks
```

`npm test` runs the gates in order and exits non-zero on the first failure:

| gate | what it proves |
|---|---|
| `test/ratio.mjs` | the scene-forced ratio state machine (entry, leave, restore, reconnect) |
| `test/ratio-commands.mjs` | `ratio.toggle` / `ratio.force16x9` are answered by the server, not forwarded to a page |
| `test/api-smoke.mjs` | core routes ahead of module routes, the shared pool, `/events` channels, module assets |
| `test/pane-browser.mjs` | the wall admin pane in headless Chrome: real pointer drag, controls that write the schema, no console errors |
| `test/pane-drag.mjs` | the drag gesture end to end: window moves, snaps to whole cells, commits to the state file, grip keeps 9:16 |
| `test/wall-browser.mjs` | the render page in headless Chrome: engine mounts, bus commands land, the 9:16 fence reaches the shader, frames animate |

They boot their own server and their own Chrome on free ports — no rig, no OBS and no
`state/` needed, so they are safe to run while the live server is up.

On the rig it runs as the scheduled task `ShockBox-Server` via `ShockBox.cmd start`.

## Layout

```
server.mjs            process entry: config, listeners, shutdown
core/                 registry, events, store, settings, obs client, http server — no module knowledge
modules/<id>/         module.json + server.js + ui/ + pages/ + its own data directory under state/
public/               admin shell: rail, hash router, settings form, health drawer (no build step)
state/<id>/           live data, outside the code tree, never in git
docs/                 ARCHITECTURE.md and one CONTRACT-*.md per module
test/                 the gates above — plain node scripts, each booting what it needs
```

## Licence

PolyForm Noncommercial 1.0.0 — free to use, fork and share noncommercially. Commercial use
requires a licence from the author.
