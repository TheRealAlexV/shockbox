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
node server.mjs                      # http://127.0.0.1:8972
SHOCKBOX_PORT=8973 node server.mjs --state ./state-dev
node --test test/                    # unit + contract tests
```

On the rig it runs as the scheduled task `ShockBox-Server` via `ShockBox.cmd start`.

## Layout

```
server.mjs            process entry: config, listeners, shutdown
core/                 registry, events, store, settings, obs client, http server — no module knowledge
modules/<id>/         module.json + server.js + ui/ + pages/ + its own data directory under state/
public/               admin shell (built), shell assets
state/<id>/           live data, outside the code tree, never in git
docs/                 ARCHITECTURE.md and one CONTRACT-*.md per module
test/                 node --test suites, including the migrated popup contract tests
```

## Licence

PolyForm Noncommercial 1.0.0 — free to use, fork and share noncommercially. Commercial use
requires a licence from the author.
