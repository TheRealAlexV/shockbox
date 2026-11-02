# Testing ShockBox

Every gate boots its own server on a free port and its own headless Chrome, with its own temp
state directory, so a full run is safe while the live server and OBS are up.

**Zero npm dependencies is a policy, not an accident.** There is no `npm install` step in CI
(`.github/workflows/test.yml:3-4`): a test that needs a package is a defect, not an install.
The browser gates shell out to a system Chrome and speak CDP over Node's built-in `WebSocket`.

## The ten `npm test` gates

`npm test` (`package.json:14`) runs exactly these, in this order, and stops on the first failure:

| # | gate | proves |
|---|---|---|
| 1 | `test/log-rotation.mjs` | the 8 MB rotation, `.1` numbering, and the 32 MB / 64 MB caps |
| 2 | `test/ratio.mjs` | the scene-forced ratio state machine: entry, leave, restore, reconnect |
| 3 | `test/ratio-commands.mjs` | `ratio.toggle` / `ratio.force16x9` are answered by the server, not forwarded to a page |
| 4 | `test/api-smoke.mjs` | core routes ahead of module routes, the pool, `/events` channels, module assets |
| 5 | `test/pane-browser.mjs` | the wall pane in headless Chrome: renders, no overflow, a refused ratio toggle surfaces the truth |
| 6 | `test/pane-drag.mjs` | a real pointer drag of the fence: snaps to cells, previews live, commits to `/render` |
| 7 | `test/wall-browser.mjs` | the render page: engine mounts, bus commands land, the fence reaches the shader, frames animate |
| 8 | `test/handfx-browser.mjs` | handfx page + pane with a fake camera: COOP/COEP isolation, `/api/handfx/*`, bus dispatch, effect registry, zero hands on the fake device, no GL error |
| 9 | `test/panes-notify-dialogs.mjs` | the Notifications and Alerts panes in the shell, painting from the server, not local state |
| 10 | `test/sound.mjs` | the tone path: a temp sound directory is listed and served, traversal and bad extensions are refused, a missing directory lists empty and 404s, and in headless Chrome a new banner/alert builds one `<audio>` and calls `play()` once while a page load over existing banners and `sound:false` stay silent |

Shorter scripts run subsets: `npm run test:wall` is gates 2, 3, 5, 6; `npm run test:handfx` is
gate 8; `npm run test:sound` is gate 10 (`package.json:16-20`).

## Gates outside `npm test`

- **`npm run test:handfx-visual`** (`test/handfx-visual.mjs`) renders every one of the 23 effects
  on the real page, reads the canvas back, and fails if an effect draws nothing, if two effects
  draw the same thing, or if an effect violates the frame-haze bounds (composited over a white
  card it must not become a near-white flat wash — mean > 252 with chroma < 3 and < 3 % dark
  pixels — and its scene alpha must not cover more than 97 % of the frame; `smoke`, `disco`,
  `inkflow`, `echo`, `edit`, `embers`, `wires` and `shoot` are exempt by name).
- **`npm run test:handfx-visual:strict`** is the same script with `--strict`.

**Report vs strict.** By default the visual gate **reports**: every check runs and failures are
printed with their numbers, but the exit code stays 0 unless the page cannot boot. `--strict`
exits 1 on any failed check.

- **Strict is the local gate.** Run `npm run test:handfx-visual:strict` before you push a change
  to an effect, a shader or the frame-haze bounds.
- **Report mode is local-only.** CI does not use it — `.github/workflows/test.yml:79-81` runs
  `npm run test:handfx-visual:strict`.
- `npm run test:ci` (`package.json:15`) is `npm test && node test/handfx-visual.mjs`, i.e. the
  report-mode variant; it is a convenience for a local "does the visual gate run at all" check,
  **not** what CI runs.
- The thresholds sit close to the edge on a software GL stack, so strict mode is the honest gate
  on the SwiftShader path (`--use-angle=swiftshader`) and a marginal failure there is worth
  reading before assuming flakiness.

- **`node test/glsl-check.mjs`** compiles the wall engine shaders in headless Chrome. It is not
  wired into `npm test` and has no `package.json` script — run it by path.

## CI

`.github/workflows/test.yml` runs on both `push` and `pull_request` (`test.yml:5-7`), as two
independent jobs:

| job | runs | timeout |
|---|---|---|
| `gates` — fast gates | `npm test` (`test.yml:45-46`) | 15 min |
| `handfx-visual` — handfx visual | `npm run test:handfx-visual:strict` (`test.yml:79-81`) | 20 min (15 for the step) |

So CI runs **`npm test` and the strict visual gate**, not report mode.

## Chrome

The browser gates find Chrome as `process.env.CHROME` (and `test/handfx-visual.mjs` also accepts
`CHROME_PATH`), otherwise they probe `/usr/bin/google-chrome`, `/usr/bin/chromium` and
`/usr/bin/chromium-browser` (`test.yml:24-27`). CI installs one real Chrome with
`browser-actions/setup-chrome` and symlinks it under all three probed names, exporting both
`CHROME` and `CHROME_PATH` (`test.yml:33-43`), so no environment variable is required.

Locally, if none of those paths exists, set one:

```bash
CHROME=/path/to/chrome npm test
CHROME_PATH=/path/to/chrome node test/handfx-visual.mjs --strict
```

## The TUI suite

The TUI (`tools/tui/`, Python) has its own pytest suite; it is not part of `npm test` and needs
no Chrome. Run it from `tools/tui/` with the project virtualenv:

```bash
tools/tui/.venv/bin/python -m pytest -p no:randomly    # deterministic order
tools/tui/.venv/bin/python -m pytest                   # pytest-randomly order
```

Run it **both ways**. The suite installs `pytest-randomly` (`tools/tui/pyproject.toml:22`), so the
default run shuffles test order; `-p no:randomly` restores file order. A test that only passes in
one of the two modes has an order-dependent bug (shared temp directory, a leaked subprocess, a
mutated module global), and only one of the modes will show it. If the virtualenv does not exist,
create it as `deploy\install.ps1` does: `python -m venv tools/tui/.venv && tools/tui/.venv/bin/python -m pip install --no-input -e tools/tui[dev]`.

**Baseline (2026-10-31):** 52 tests, ~145 s, green in both modes. A run that is materially slower
is usually a leaked `server.mjs` child: every test starts real subprocesses and
`pyproject.toml:31` sets a 300 s per-test timeout so a hang fails the suite instead of hanging CI.

## Quick checklist before a push

```bash
npm test
npm run test:handfx-visual:strict
node test/glsl-check.mjs
tools/tui/.venv/bin/python -m pytest -p no:randomly
tools/tui/.venv/bin/python -m pytest
```
