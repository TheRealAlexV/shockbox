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
- **`/wall/render` is the only page.** There is no `/wall/portrait` route: `module.json` does not
  declare it, nothing in the server or the shell references it, and `modules/wall/pages/display-portrait.html`
  is unreachable dead weight. The 9:16 picture is a fence inside `/wall/render`, and the view
  list below survives only at the wire level.

## HTTP routes (all under `/api/wall`)

| method | path | params | reply |
|---|---|---|---|
| GET | `/live` | — | `{ok, seq, online, history[-30], commands[], settings, ratio, render, snapshot}` |
| PATCH | `/settings` | any subset of the settings keys | `{ok, changed[], settings, ratio}` |
| POST | `/cmd` | `{cmd, args?, view?}` | dispatcher answer: `{…, ok, note, delivered}`; `{seq, ok:false, note:'refused: scene forces 16:9', ratio}` for a refused toggle |
| GET | `/cmd` | — | `{ok, commands[], seq}` |
| POST | `/state` | `{view:'landscape'\|'portrait', state{…}}` | `{ok, online}`; stores what the page reports as its last-known state. The server still accepts `view:'portrait'` (`modules/wall/server.js:405`), but **no page serves it**: `/wall/render` reports itself as landscape, so the `portrait` slot stays offline |
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
| `ratio` | string `16:9`\|`9:16` | `16:9` | portrait mode |
| `fence` | object `{x,y,w,h}` | `{x:880,y:0,w:1440,h:2560}` | the 9:16 window in landscape pixels |
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
| `/wall/render` | `engine/display.html` + `engine/*.js` | the wall canvas; opens SSE `/events?channels=wall&view=<landscape\|portrait>`, posts `/api/wall/state` ≤1 per 1.5 s, reads `/api/wall/render` | 

Only `/wall/render` is a page. There is **no `/wall/portrait` route**: `pages/display-portrait.html`
exists in the tree but nothing serves it, so a browser source pointed at `/wall/portrait` gets the
shell's 404, not a portrait renderer. Use `/wall/render` with `ratio: 9:16` (or the fence) for the
9:16 picture.

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
