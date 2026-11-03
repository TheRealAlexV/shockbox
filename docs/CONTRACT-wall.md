# CONTRACT-wall — the LED wall

Purpose: the LED wall's command bus, look settings and page bookkeeping — one rendered page for
OBS plus the admin pane that drives it.

Source: `modules/wall/server.js`, `commands.mjs`, `ratio.mjs`, `module.json`, `ui/pane.js`,
`engine/`.

## module.json claims

```json
{
  "id": "wall", "title": "LED Wall", "version": "1.0.0", "mount": "server.js",
  "pages": [
    { "route": "/wall/render", "file": "engine/display.html" }
  ]
}
```

- Channels: `wall` (commands, `state.snapshot` events) and `wall-state` (state snapshots to panes).
  Neither is declared in `module.json`; a client asking `?channels=wall,wall-state` gets both.
- No `order` (defaults to 100). No `settings` block in the manifest — the settings schema below is
  built in `server.js`, not by the registry.
- **One page, two routes, ratio-agnostic at mount.** `/wall/render` and `/wall/portrait` both serve
  `engine/display.html`; it has no pixel size and no aspect of its own (`html, body { width:100%;
  height:100% }`, canvas sized by the engine), so it mounts on whatever surface OBS gives it. The
  shape is a *setting*: `ratio` is `default` (resolve through the core-wide `ratio` key), `16:9` or
  `9:16`. `/wall/portrait` pins 9:16 (`LEDWALL_PAGE.forceRatio`) because that source is nothing but
  the window.
- **The fence is derived, never stored.** For 9:16 the server computes the window from the wall's
  own geometry — `height = canvas height`, `width = height × 9/16`, `x = (canvas − width) / 2,
  y = 0`, snapped to whole cells — and emits it as `{cells, px, pitch, cols, rows}` on every frame.
  `16:9` emits `fence: null`. A `fence` object in the settings document is legacy: nothing reads it.
- **Runtime switch, no reload.** `boot.js` applies `d.ratio` from every settings frame through
  `engine.setRatio()`: the page re-grids (112x63 ↔ 63x112) and re-lays out in place, and 9:16 on a
  16:9 surface becomes the centred full-height column (`engine._sizeCanvas`) with the black
  surface either side. The old `?fit=portrait` flag and `engine/display-portrait.html` are gone.

## HTTP routes (all under `/api/wall`)

| method | path | params | reply |
|---|---|---|---|
| GET | `/live` | — | `{ok, seq, online, history[-30], commands[], settings, ratio, render, snapshot}` |
| PATCH | `/settings` | any subset of the settings keys | `{ok, changed[], settings, ratio}` |
| POST | `/cmd` | `{cmd, args?, view?}` | dispatcher answer: `{…, ok, note, delivered}`; `{seq, ok:false, note:'refused: scene forces 16:9', ratio}` for a refused toggle |
| GET | `/cmd` | — | `{ok, commands[], seq}` |
| POST | `/state` | `{view:'landscape'\|'portrait', state{…}}` | `{ok, online}`; stores what the page reports as its last-known state. `/wall/portrait` reports `view:'portrait'`, so the `portrait` slot is online whenever that source is running (`/wall/render` reports landscape) |
| GET | `/state` | — | `{ok, seq, gates, views, online, history}` |
| PUT | `/state` | `{gates:{landscapeLive?,portraitLive?}}` | `{ok, gates}`; 400 on any other key |
| GET | `/render` | — | `{ok, settings:{look,ratio,fence,rev}, online:{landscape,portrait}, seq}` |
| POST | `/broadcast` | `{patch:{fence}, note?, live?}` | `{ok, seq}`; `patch` may carry `fence` only, ≤16 KB |
| PUT | `/fence` | `{fence:{x,y,w,h} \| null}` | `{ok, fence, rev}`; persists and broadcasts |
| GET | `/history` | `?limit=` (default 50, max ring) | `{ok, commands:[{seq,cmd,view,t}]}` |
| POST | `/replay` | `{since}` | `{ok, reset:false, seq, frames:[{seq,cmd,args,view}]}` or `{ok, reset:true, seq}` |

`/replay` is the module's own ring, independent of the SSE hub's replay; the shipped page does not
use it (it reconnects and relies on the hub's `?since=`/`reset`).

## Bus commands

Channel `wall`. `POST /api/wall/cmd {cmd, args, view}` validates, numbers (`seq`), pushes to the
module ring and publishes `{seq, channel:'wall', cmd, args, view}`.

| cmd | args | effect |
|---|---|---|
| `preset.next` / `preset.prev` | — | page steps the preset |
| `preset.set` | `{name: /^[A-Za-z0-9 ._:-]{1,64}$/}` | page loads that preset |
| `preset.index` | `{delta}` xor `{set}`, finite, \|v\|≤100 | page moves the preset index |
| `pattern.next` / `pattern.prev` | — | page steps the pattern |
| `pattern.set` | `{name}` (same pattern) | page sets the pattern |
| `pattern.index` | `{delta}` xor `{set}` | page moves the pattern index |
| `blackout.on` / `blackout.off` / `blackout.toggle` | — | page blanks the wall |
| `fence.toggle` | — | page shows/hides the 9:16 fence |
| `reload` | — | page reloads |
| `text.send` | one of `{text}`, `{item}`, `{poolId}`, `{slot≥1}`; optional `{duration: 0..600}`, `{view: landscape\|portrait\|both}` | page shows text in its slots |
| `text.clear` | — | page clears the text |
| `text.reveal` | — | page reveals the held text |
| `text.enabled` | `{on: boolean, view?}` | page enables/disables the text overlay |
| `settings.patch` | `{patch: object (≤64 keys, ≤16 KB), view?}` | page applies a look patch locally |
| `ratio.toggle` | — | **server-answered**: 9:16 ↔ 16:9 in the settings document; refused while a forcing scene is active |
| `ratio.force16x9` | — | **server-answered**: sets `ratio` to 16:9; answers "already forced by the active scene" without touching the stored ratio |

`settings.patch` (the command) and `PATCH /settings` (the route) are separate paths into the page
and the document.

State snapshots go out on `wall` as `emit('wall','state.snapshot', snap)` (not replayable) and on
`wall-state` as `publish('wall-state','snapshot', state)`; `snap` is
`{seq, rev, reason, look, ratio, fence}` plus any live patch.

## Settings (document `state/wall/settings.json`)

| key | type | default | effect |
|---|---|---|---|
| `pattern` | string | `wave` | named pattern (pane lists: random, wave, bottomCenter, sweep, bars, ripple, plasma, chase, sweepMirror, comet, matrix, spectrum, orbits, rain, equalizer, static, heartbeat) |
| `preset` | string | `default` | named look preset |
| `brightness` | number 0–2 | 1 | output brightness |
| `speed` | number 0–4 | 1 | animation speed |
| `ratio` | string `default`\|`16:9`\|`9:16` | `default` | `default` resolves through the core-wide `ratio` key; `9:16` shows the derived window |
| `fence` | object `{x,y,w,h}` \| null | `null` | legacy: the window is derived from the ratio, nothing reads this |
| `fenceOutDim` | number 0–1 | 0.18 | dimming outside the fence |
| `gridCols` | number 16–200 | 112 | LED columns (landscape) |
| `gridColsPortrait` | number 16–120 | 63 | LED columns (portrait) |
| `gridRows` | number 0–160 | 0 | LED rows (0 = derive from the aspect) |
| `cellShape` | number 0.5–2 | 1 | cell roundness |
| `ledSize` | number 0.3–2.5 | 1 | LED dot size |
| `transitionSpeed` | number 0.1–4 | 1 | pattern transition |
| `flashDensity` | number 0–0.6 | 0.25 | flash rate |
| `waveFrequency` | number 0.5–10 | 3 | wave frequency |
| `persistence` | number 0–0.95 | 0.5 | LED decay |
| `paletteWeight` | number 0–1 | 1 | palette blend |
| `hdrGain` | number 1–8 | 1 | HDR gain before bloom |
| `streakOpacity` | number 0–0.5 | 0.12 | anamorphic streak strength |
| `flareIntensity` | number 0–1 | 0.6 | flare strength |
| `flareLength` | number 0.2–3 | 1 | flare length |
| `flareRotation` | number 0–45 | 0 | flare angle |
| `bloom` | number 0–2 | 0.55 | bloom strength |
| `bloomThreshold` | number 0–1 | 0.7 | bloom threshold |
| `bloomRadius` | number 0.5–2 | 1 | bloom radius |
| `exposure` | number 0.2–3 | 1 | grading |
| `saturation` | number 0–2 | 1 | grading |
| `contrast` | number 0.5–1.8 | 1 | grading |
| `lift` | number −0.2–0.2 | 0 | black lift |
| `vignette` | number 0–1 | 0.35 | vignette |
| `grain` | number 0–0.3 | 0.03 | film grain |
| `dither` | number 0–1, integer | 1 | dithering on/off |
| `acsTonemap` | number 0–1, integer | 0 | ACES tonemap on/off |

`forceScenes` is **not** a wall setting: it is core's (`state/core/settings.json`), read by the
ratio watcher through `ctx.core.settings` (`server.js:89`).

## Pages

| route | file | expects |
|---|---|---|
| `/wall/render` | `engine/display.html` + `engine/*.js` | the wall canvas on a full surface; opens SSE `/events?channels=wall&view=<landscape\|portrait>`, posts `/api/wall/state` ≤1 per 1.5 s, reads `/api/wall/render`. Its shape follows the `ratio` on every settings frame: 16:9 fills the surface with 112x63 cells, 9:16 lays out 63x112 in the centred full-height column that the derived fence describes. No query flag and no fixed page size |
| `/wall/portrait` | `engine/display.html` (same file) | the same canvas pinned to 9:16 (`LEDWALL_PAGE = {ratio:'9:16', view:'portrait', forceRatio:true}`), for the OBS strip at 720x1280. Lays out 63x112 natively and ignores the document's ratio; the derived fence is not applied (this page *is* the window) |

Both pages carry `COOP: same-origin` / `COEP: require-corp` from their `pages[]` entry, and each has
its own `<base href="/mod/wall/engine/">` so the shared classic scripts resolve.

`pages[]` in `module.json` is the only page mechanism: the registry (`core/registry.mjs`) resolves a
page route from an entry's `pages`, and serves that page's sibling files under the page's own URL.
`/mod/<id>/…` only serves the raw module files, with no route and no headers, so it is not an
alternative mount.

Pane: `ui/pane.js` in the admin shell — settings form (writes `PATCH /settings`), preview with a
draggable fence (`POST /broadcast` while dragging, `PUT /fence` on release), ratio and blackout
keys (`POST /cmd`), reads `/api/wall/live`.

## State files (`state/wall/`)

- `settings.json` — the look document.
- `state.json` — `{gates:{landscapeLive,portraitLive}, views:{landscape,portrait}, lastSnapshot, ratioState:{lastScene,before,forcing,restore}}`.
  Best-effort: a corrupt file does not stop the module coming up.

## Test gate

`npm test` runs `test/ratio.mjs` (state machine with no OBS), `test/ratio-commands.mjs` (server
answers ratio commands), `test/pane-browser.mjs` (pane in headless Chrome), `test/pane-drag.mjs`
(pointer drag persists to `/render`) and `test/wall-browser.mjs` (render page: engine mounts, bus
commands land, fence reaches the shader, frames animate). `npm run test:wall` is the first four.
`test/glsl-check.mjs` compiles the engine shaders in headless Chrome; it is **not** part of
`npm test`.
