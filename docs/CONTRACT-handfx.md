# CONTRACT-handfx — hand and body FX

Purpose: hand tracking and layered WebGL2 effects for an OBS browser source — 23 effects, plus a
body-tracking page whose segmentation mask drives three of them. Everything is computed in the
page; no camera frame, landmark or mask reaches the server.

Source: `modules/handfx/server.js`, `module.json`, `ui/pane.js`, `pages/`, `pages/js/engine/`,
`vendor/`.

## module.json claims

```json
{
  "id": "handfx", "title": "Hand FX", "version": "1.0.0", "order": 40, "mount": "server.js",
  "channels": ["handfx"],
  "pages": [
    { "route": "/handfx", "file": "pages/overlay.html", "title": "Hand FX overlay",
      "headers": { "Cross-Origin-Opener-Policy": "same-origin",
                   "Cross-Origin-Embedder-Policy": "require-corp",
                   "Cross-Origin-Resource-Policy": "cross-origin" } },
    { "route": "/handfx/body", "file": "pages/body.html", "title": "Hand FX body tracking",
      "headers": { "Cross-Origin-Opener-Policy": "same-origin",
                   "Cross-Origin-Embedder-Policy": "require-corp",
                   "Cross-Origin-Resource-Policy": "cross-origin" } }
  ]
}
```

Both pages are served via the core header hook so MediaPipe's wasm can run (`crossOriginIsolated`).
`mountPrefix: '/vendor/'` + `mountFile` serve the vendored runtime from
`/api/handfx/vendor/…`.

**Export shape:** the default export is an object whose `channels`, `mountPrefix` and `mountFile`
are getters that build the API on first touch (`self(ctx)`), because the context only arrives in
`init(ctx)`/`routes(ctx)`. Core reads the members off that object; it never calls a mount function.

## HTTP routes (all under `/api/handfx`)

| method | path | params | reply |
|---|---|---|---|
| GET | `/status` | — | `{cmds[], effects[{id,title,gesture,from}], model{local,name,url}, bodyModels{pose,segmenter,local}, body{lastMaskAt,pageOpen,lastPoseAt}, runtime{vendored,simdWasm,nosimdWasm,base}, page, bodyPage, isolation{…}, settings, lastCmd}` |
| PATCH | `/settings` | any subset of the settings keys | `{ok, changed[], settings}`; an effect id the registry does not know → 400 |
| POST | `/cmd` | `{cmd, args?}` | `{ok, seq}`; document-owning commands add `changed`, `enabled` or `mirror` plus `settings`; unknown `cmd` → 400 |
| POST | `/ack` | the page's status line | `{ok:true}` |
| GET/HEAD | `/model` | `?kind=pose\|segmenter` (default: hand model) | the model file (octet-stream, `max-age=86400`); 404 `{ok:false, error:'no local model', url}` |
| GET/HEAD | `/vendor/<path>` | — | a file under `modules/handfx/vendor/`, MIME-typed; wasm is `immutable` for a year |

**No `GET /settings`.** The earlier draft listed one; the source has only `PATCH /settings`
(state is read from `/status`).

`:kind` on `/model` selects `pose` or `segmenter`; the literal `pose` and `segmenter` are the only
values with meaning — `model/body` and `/model/pose` are not routes, they are the same `/model`
route with `?kind=`.

## Command bus (channel `handfx`)

`POST /cmd` validates against `CMDS`, publishes, and answers. Every publish is stamped by the server
with `args.at` and `args.id`, so a ring replay after an SSE reconnect does not double-fire a
one-shot.

| cmd | args | server behaviour |
|---|---|---|
| `effect.next` / `effect.prev` | — | publish only; the page owns the cursor and reports it on `/ack` |
| `effect.set` | `{value: [ids]}` or `{id}` | with `value`: validates every id, writes `settings.effects`, publishes; with `id`: validates and publishes (the page moves its cursor) |
| `tracking.toggle` | — | flips `settings.enabled`, publishes with `{enabled}`, answers `{enabled, settings}` |
| `mirror.toggle` | — | flips `settings.mirror`, publishes with `{mirror}`, answers `{mirror, settings}` |
| `projectile.fire` | `{skin?: 'projectile'\|'heart'}` | records `settings.skins.shoot` when `skin` is given, publishes |
| `edit.clear` | — | publish only; the page wipes the operator's drawn canvas |
| `reload` | — | publish only; the page reloads |

Frames: `publish('handfx', cmd, {…args, at, id})` — `{seq, channel:'handfx', cmd, args}` on the
wire. Status lines go out as the event `page`:
`emit('handfx','page', {effect, tracking, model, hands(0..4), gesture, body, error, at})`, emitted
from `POST /ack` — never as a frame.

## Settings (document `state/handfx/settings.json`)

| key | type | default | effect |
|---|---|---|---|
| `enabled` | boolean | true | effects render at all; the page keeps tracking to report honest state |
| `mirror` | boolean | true | selfie view (landmarks mirrored) |
| `sensitivity` | number 0.4–2 | 1 | scales detection/tracking confidence (higher = more hands, more false positives) |
| `deviceId` | string (≤128) | `""` | camera device id (`deviceId: {exact}`); empty = first camera |
| `resolution` | enum `480p`\|`720p`\|`1080p` | `720p` | ideal capture size |
| `debugOverlay` | boolean | false | camera picture + 21 landmarks drawn under the effects |
| `effects` | string[] | fireball, lightning, sparkring, embers, smoke | ordered list of live effect ids |
| `intensity` | object id → number | every id at 1 | per-effect multiplier (0–2), read by the page |
| `nextGesture` | enum `bothFingertips`\|`palmTouch`\|`bothPalmsUp`\|`fist` | `bothFingertips` | shown in the pane; **read by no page code** |
| `bufferScroll` | number 0–1.5 | 0.35 | how far an effect rises from a low palm |

**Read by nothing:** `nextGesture` is stored, displayed in the pane (`ui/pane.js:377`) and never
read by `pages/js/` — the page's next-effect gesture is hardcoded to `palmTouch`
(`pages/js/overlay/main.js:40`). The default (`bothFingertips`) is also the lightning gesture.

## Pages

| route | file | expects |
|---|---|---|
| `/handfx` | `pages/overlay.html` + `js/overlay/main.js` | isolated document; camera + MediaPipe `HandLandmarker`; SSE `/events?channels=handfx`; reads `/api/handfx/status`; posts `/ack` with effect/tracking/model/hands/gesture; receives body masks from the body page over its own channel |
| `/handfx/body` | `pages/body.html` | isolated; MediaPipe pose + selfie segmenter; posts `{source:'body', open:true}` to `/ack` as a heartbeat; sends the mask to the overlay page |

Engine modules (`pages/js/engine/`), importable by page and pane: `tracker.js` (camera, MediaPipe,
synthetic hand), `gestures.js` (pure classifier, motion, gate), `fx.js` (WebGL2 renderer, effect
registry, anchors), `fx-glsl.js` / `fx-glsl2.js` (GLSL ES 3.00, no extensions), `pose.js` (hand
geometry).

### Effect registry (23)

`fireball`, `lightning`, `sparkring`, `embers`, `smoke`, `aura`, `wires`, `frost`, `portal`,
`disco`, `slime`, `inkflow`, `shatter`, `cyber`, `bloomlife`, `echo`, `bodyonfire`, `bodysmoke`,
`frozenbody`, `edit`, `electroshock`, `meteor`, `shoot`.

- `bodyonfire`, `bodysmoke`, `frozenbody` read the body mask and draw nothing until one exists.
- `inkflow`, `echo` use the history buffer; `electroshock`, `echo` sample a per-frame snapshot of
  the accumulated scene.
- `edit` is the operator's drawn canvas, `shoot` the projectile (skin from `settings.skins`).

Gestures (`main.js` `GESTURE_EFFECTS`): `palmUp`→fireball, `bothFingertips`→lightning,
`palmFront`→sparkring/frost/portal/electroshock, `swipe`→smoke/inkflow/echo,
`palmTouch`→next effect, `bothPalmsUp`→embers/bloomlife, `bothRaised`→disco/meteor,
`fist`→shatter/cyber/edit, `point`→shoot; `bodyAny` is the body mask.

## Pane

`ui/pane.js` in the admin shell: preview, honest camera/model/tracking states, effect registry and
order, skin switch, per-device camera list, settings form (`PATCH /api/handfx/settings`), deck keys
through `POST /api/handfx/cmd`, `/status` polling. It shows "preview only" while the overlay holds
the camera.

## Honest states (page and pane must not fake these)

- camera: `off`, `asking`, `on`, `denied`, `held` (another document owns it), `error` — distinct
  messages, never "tracking" when it is not.
- model: `idle`, `loading`, `ready`, `failed`, `cached` (downloaded from the CDN once).
- no hands is `hands: 0, gesture: 'none'`.
- synthetic replay is labelled as such.

## Privacy

`getUserMedia` runs only from a user gesture (the pane's Start preview, the overlay's Start
camera). `tracking.toggle` only starts a camera the page was already given. `/ack` is a status
line (≤2/s in practice); no frame, landmark, mask or use-time intensity is ever sent.

## State files (`state/handfx/`)

- `settings.json`. `vendor/` and `models/` live in the code tree; `models/*` is git-ignored and
  served locally when present, otherwise the overlay downloads it once into Cache Storage
  (`handfx:models-v1`).

## Vendoring and licensing

`@mediapipe/tasks-vision@0.10.14` (Apache-2.0) vendored whole: `vision_bundle.mjs`, the no-SIMD
loader and binary, the SIMD binary. The model (`hand_landmarker.task`, Apache-2.0) is served
locally when present. Exact URLs, sizes and licences: `modules/handfx/vendor/README.md`.

## Test gate

- `test/handfx-browser.mjs` (`npm run test:handfx`, part of `npm test`): COOP/COEP on the page and
  `crossOriginIsolated`, `/api/handfx/*`, vendor/model serving (a skipped model download is
  reported), settings validation, bus dispatch to the page, effect registry in the pane, camera
  path, zero hands on the fake device, synthetic gestures, effects rendering with no GL error.
- `test/handfx-visual.mjs` (`npm run test:handfx-visual`, **not** in `npm test`): renders every
  registered effect on the real page, reads the canvas back and fails if an effect draws nothing
  or two effects draw the same thing. It also runs **frame-haze assertions**: after compositing
  over a white card, an effect must not be a near-white wash (mean > 252 with chroma < 3 and < 3 %
  pixels darker than 235) and must not cover > 97 % of the frame with scene alpha; `smoke`,
  `disco`, `inkflow`, `echo`, `edit`, `embers`, `wires` and `shoot` are exempt by name.
