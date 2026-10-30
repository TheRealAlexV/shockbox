# CONTRACT-handfx — draft for the module contract (designer owns the final file)

Status: written by the handfx implementation; **not** placed at `docs/CONTRACT-handfx.md` because
that path is held by the designer. Copy or merge this into the real file, then delete this note.

## What the module is

`modules/handfx/` is ShockBox's fourth page-served module: hand tracking and WebGL2 effects for an
OBS browser source. Three parts:

| part | file | what it owns |
|---|---|---|
| module API | `modules/handfx/server.js` | settings schema (in `module.json`), routes, command bus, vendor/model serving |
| overlay page | `pages/overlay.html` + `pages/js/overlay/main.js` | camera, MediaPipe `HandLandmarker`, gesture beat, effect rendering, honest status |
| admin pane | `ui/pane.js` + `ui/pane.css` | preview, hands/gestures (as reported), effect registry, camera device, honest states |

`pages/js/engine/` is plain ES modules, importable from both the page and the pane:
`tracker.js` (camera + MediaPipe + synthetic hand), `gestures.js` (pure classifier, motion, gate),
`fx.js` (WebGL2 renderer, registry, anchors), `fx-glsl.js` (every shader), `pose.js` (hand geometry).

## Page registration

`module.json`:

```json
"pages": {
  "handfx": {
    "route": "/handfx",
    "file": "pages/overlay.html",
    "title": "Hand FX",
    "headers": {
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "cross-origin"
    }
  }
}
```

The page (and its sibling files — `main.js`, `engine/*.js`, `style.css`) is served with those
headers. The page asserts `crossOriginIsolated === true` at boot and says so loudly if not, because
MediaPipe's wasm needs it.

### The core header hook (generic)

Core had no way for a module to ask for response headers. The hook is **`pages.<name>.headers`**:
any HeadersInit-shaped object of lowercase names to string values. `core/server-http.mjs`
(`cleanHeaders`) validates the shape and strips anything core sets itself (content-type,
content-length, cache-control, CORS, …); `serveFile(..., { headers })` applies it to the page and to
the page's static siblings. Nothing in core mentions handfx or COOP by name.

`GET /api/<id>/routes` (built by the registry) includes `headers` per page, so a tool can see what
a page will be served with.

### The mount-prefix hook (generic)

A module that serves a directory of large files (a vendored runtime, a model) cannot declare a
route per file. The module API may declare:

```js
mountPrefix: '/vendor/',                   // the directory name, under /api/<id>/
mountFile(req, res, url, filePath) { … }   // called for GET/HEAD under /api/<id>/vendor/
```

Core's HTTP server walks up modules when no route matched and hands the request to the first
`mountFile` whose prefix matches, with the path after the prefix. It returns `undefined` when it
wrote the response. No core file names handfx; any module may use it.

**Export shape** (worth knowing before writing a module): the registry does `mod.default || mod`
and then reads `.init(ctx)`, `.routes(ctx)`, `.channels`, `.mountPrefix`, `.mountFile`, `.dispose()`
off that object — it never calls a `mount(ctx)` function. `modules/handfx/server.js` keeps its real
API inside `build(ctx)` and exposes it through a few getters that build on first touch
(`self(ctx)`), because the context only arrives in `init`/`routes`.

## Settings document (the server's, operator-owned)

`module.json` `settings` — every one is set from the pane, all of them are rendered there:

| key | type | default | meaning |
|---|---|---|---|
| `enabled` | bool | true | effects render at all (the page also keeps tracking to report honest state) |
| `effects` | string list | fireball, lightning, sparkring, embers, smoke | the ordered effect list; a write with an id this build does not implement is refused (400) |
| `intensity` | object | {} (absent = 1) | per-effect intensity, 0–2; the page reads it, the server never renders |
| `nextGesture` | enum | bothFingertips | gesture a deck key uses to step the list (accepted, applied by the page) |
| `sensitivity` | number 0.4–2 | 1 | MediaPipe detection/tracking confidence, inverted |
| `mirror` | bool | true | view mirrored (the normal OBS camera look) |
| `deviceId` | string | "" | camera deviceId; empty = browser default |
| `resolution` | enum 480p/720p/1080p | 720p | ideal camera capture size |
| `debugOverlay` | bool | false | camera picture + landmark skeleton under the effects |
| `bufferScroll` | number 0–1.5 | 0.35 | how far a fireball lifts off a low palm |

**Effect selection vs. server**: the effect *set* and its order are the operator's document; which
effect the page is "on" (its cursor) belongs to the page. The page reports the cursor on `/ack`;
the pane displays it. The server never learns a frame, a landmark, a gesture or an intensity
*value in use* — `/ack` is a status line (`effect, tracking, model, hands, gesture, error`).

## Routes (all under `/api/handfx`)

| method | path | body → answer |
|---|---|---|
| GET | `/status` | `{cmds, effects[{id,title,gesture,from}], model{local,name,url}, runtime{vendored,simdWasm,nosimdWasm,base}, isolation{…}, page{…}, settings{key:{…,value}}, lastCmd}` |
| GET | `/settings` | `{settings, page}` |
| PATCH | `/settings` | any subset of the table above → `{changed[], settings}`; unknown effect id → 400 |
| POST | `/cmd` | `{cmd, args?}` → `{ok, seq, cmd}`; unknown → 400. Commands that own the document write it first (`mirror.toggle`, `tracking.toggle`) |
| GET | `/model` | the model file (local only; 404 when absent, with `model.url` in `/status`) |
| GET | `/vendor/<path>` | the vendored runtime, via the mountPrefix hook |
| POST | `/ack` | the page's status line → published on the channel as `page` |

## Command bus

Channel `handfx` (SSE `/events`). Frame shape is core's: `{seq, channel, cmd, args, view}` for a
command, `{event, channel, data}` for a status line. Commands:

| cmd | args | effect |
|---|---|---|
| `effect.next` / `effect.prev` | — | step the page's list cursor |
| `effect.set` | `{id}` | put the cursor on an id (unknown id: accepted by the server, ignored by the page) |
| `tracking.toggle` | — | start/stop camera tracking on the page (a page that has had no user action refuses — a browser cannot open a camera from a socket) |
| `mirror.toggle` | — | flips `settings.mirror` |
| `reload` | — | reloads the page |

Every publish is stamped by the server with `args.at` and `args.id`; the page drops ids it has
already applied, so a ring replay after an SSE reconnect never double-fires a one-shot.

## Honest states (what the pane and the page must never fake)

- camera permission **denied**, **held by another document**, **insecure origin**, **no device**
  are distinct messages, never "tracking".
- the model **not vendored**, **failed**, or **downloaded from the CDN** are distinct messages.
- **no hands** is `hands: 0, gesture: "none"`, never a placeholder gesture.
- **synthetic replay** is labelled as such on the page, on the badge and in the pane.
- one camera, one document: the pane shows *preview only* while the overlay holds the camera; the
  overlay's camera is opened by a click in the pane (or on the page), never by a bus command alone.
- the pane's own tab is not cross-origin isolated (only the overlay page is); the pane says so
  rather than implying the isolation applies to it.

## Camera privacy

- `getUserMedia` is only called from a user gesture: the pane's *Start preview*, or the overlay's
  *Start camera*. `tracking.toggle` starts only if the page had a real interaction in the last
  20 s and is visible; otherwise it prints why it refused.
- A secure context is required by the browser: `http://127.0.0.1:PORT` and `http://localhost:PORT`
  are secure; a LAN IP is not, and both the page and the pane say exactly that.
- No camera frame, landmark, gesture or use-time intensity leaves the page. The only things sent
  are the status line (`/ack`, ≤2/s), effect cursor steps and the operator's settings writes.

## Effects

| id | gesture (ported) | mode | ports from |
|---|---|---|---|
| `fireball` | open palm up — a ball floats above it | add | `fireball-controller/main.py` (`is_hand_open`) |
| `lightning` | both hands, index/middle tips arched together — an arc between every pair of tips | add | the old Hand FX lightning |
| `sparkring` | open palm towards the camera | add | the old Hand FX ring |
| `embers` | ambience while any hand is present | add | the old Hand FX embers |
| `smoke` | sideways hand sweeping across | source-over | the old Hand FX smoke |

Layers per frame: camera (debug only) → per-effect pass into the layer → composite onto the scene
(add or over) → 4× bloom → tonemap. All GLSL ES 3.00, no extensions.

## Vendoring and licensing

See `modules/handfx/vendor/README.md` for the exact URLs, sizes and licences. Short version:
`@mediapipe/tasks-vision@0.10.14` (Apache-2.0) is vendored whole — `vision_bundle.mjs`, the no-SIMD
loader and binary, the SIMD binary — and the model (`hand_landmarker.task`, Apache-2.0) is served
locally when present or downloaded once into Cache Storage (`handfx:models-v1`). The default
runtime is the no-SIMD build: it needs nothing from the network. The SIMD loader is fetched from
jsDelivr by exact URL (the only CDN asset at page runtime) and only on the `simd` path.

## Tests

`test/handfx-browser.mjs` (in `npm test`): boots its own server + Chrome on free ports, fake media
device, asserts the isolation header and the page's `crossOriginIsolated`, the module's routes, the
vendor/model serving (model download conditional on network → reported skipped), settings
validation, bus dispatch to the page, the effect registry in the pane, the camera path not
throwing, honest zero hands on the fake device, the synthetic poses classifying as the shipped
gestures, all five effects rendering with no GL error, and no uncaught page exceptions.
