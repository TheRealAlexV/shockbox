# CONTRACT-handfx — ShockFX (hand and body FX)

Purpose: hand tracking and layered WebGL2 effects for an OBS browser source — 23 effects, plus a
body-tracking page whose segmentation mask drives three of them. Everything is computed in the
page; no camera frame, landmark or mask reaches the server.

Source: `modules/handfx/server.js`, `module.json`, `ui/pane.js`, `pages/`, `pages/js/engine/`,
`vendor/`.

## module.json claims

```json
{
  "id": "handfx", "title": "ShockFX", "version": "1.0.0", "order": 40, "mount": "server.js",
  "channels": ["handfx"],
  "pages": [
    { "route": "/shockfx", "file": "pages/overlay.html", "title": "ShockFX overlay",
      "headers": { "Cross-Origin-Opener-Policy": "same-origin",
                   "Cross-Origin-Embedder-Policy": "require-corp",
                   "Cross-Origin-Resource-Policy": "cross-origin" } },
    { "route": "/shockfx/body", "file": "pages/body.html", "title": "ShockFX body tracking",
      "headers": { "Cross-Origin-Opener-Policy": "same-origin",
                   "Cross-Origin-Embedder-Policy": "require-corp",
                   "Cross-Origin-Resource-Policy": "cross-origin" } }
  ]
}
```

Both pages are served via the core header hook so MediaPipe's wasm can run (`crossOriginIsolated`).
`mountPrefix: '/vendor/'` + `mountFile` serve the vendored runtime from
`/api/handfx/vendor/…`. The manifest's `pages` array is the only page list the registry reads
(`core/registry.mjs:116`); the duplicate `files.pages` block that used to sit beside it was never
read and has been removed.

The module id is still `handfx` (it names the API prefix, the state folder and the setting keys),
and the native filter's registered kind id is still `handfx_filter` — OBS scene items reference
it. Only the titles changed. The old page URLs 301 to the new ones (`server.mjs`,
`legacyFxRoutes`), so browser sources saved before the rename keep working.

**Export shape:** the default export is an object whose `channels`, `mountPrefix` and `mountFile`
are getters that build the API on first touch (`self(ctx)`), because the context only arrives in
`init(ctx)`/`routes(ctx)`. Core reads the members off that object; it never calls a mount function.

## HTTP routes (all under `/api/handfx`)

| method | path | params | reply |
|---|---|---|---|
| GET | `/status` | — | `{cmds[], effects[{id,title,gesture,from}], model{local,name,url}, bodyModels{pose,segmenter,local}, body{lastMaskAt,pageOpen,lastPoseAt}, trackingSource, effectiveSource, draws, anchors, lastDrawAt, lastAckAt, runtime{vendored,simdWasm,nosimdWasm,base}, page, bodyPage, isolation{…}, settings, lastCmd}` |
| PATCH | `/settings` | any subset of the settings keys | `{ok, changed[], settings}`; an effect id the registry does not know → 400 |
| POST | `/cmd` | `{cmd, args?}` | `{ok, seq}`; document-owning commands add `changed`, `enabled` or `mirror` plus `settings`; unknown `cmd` → 400 |
| POST | `/ack` | the page's status line; `{preview:true}` is dropped entirely | `{ok:true}` (`{ok:true, preview:true}` for a preview) |
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
| `trackingSource` | enum `auto`\|`camera`\|`synthetic` | `auto` | which hand source the page runs; also served top-level on `/status` and shown by the pane's `hand source` select |
| `underlay` | boolean | true | camera picture under the effects; the pane's live preview forces it off **in its own iframe only** and never patches it |
| `bufferScroll` | number 0–1.5 | 0.35 | how far an effect rises from a low palm |

`nextGesture` was removed: it was stored and shown in the pane but read by no page code (the page
has always hardcoded `palmTouch` as the next-effect gesture), and its default (`bothFingertips`)
is the lightning gesture, so no single intended behaviour could be wired without changing what
two fingertips do. The pane row and the setting are gone; the page keeps `palmTouch`.

`/status` also carries `trackingSource` (the setting) and `effectiveSource`
(`camera`|`synthetic`|`none`, the page's own anchor source). `auto` + `effectiveSource:"synthetic"`
is the camera fallback — read `cameraError`/`relayError`/`cameraSource` for why — not the operator
choosing synthetic.

### Merge semantics (what wins when a page and the document disagree)

The page receives settings on two paths — the snapshot/`/status` seed and every `settings` bus
event — and the renderer merges each one onto what it already has in `setSettings()`
(`pages/js/engine/fx.js:551-564`):

- **`intensity` merges key-by-key** onto the current map (`Object.assign({}, current, incoming)`,
  `fx.js:556`): patching one effect's intensity leaves the other 22 alone. A missing key falls back
  to `1` at draw time (`fx.js:619`), and an intensity clamped to `≤0.001` stops that effect drawing
  without removing it from the list (`fx.js:620`).
- **`skins` replaces the whole map** when present, and is left untouched when absent (`fx.js:557-559`),
  which is what lets deleting a key fall back to the default orb. It is a map of effect id →
  `'projectile' | 'heart'`; the renderer's registry accepts exactly those two (`SKINS`,
  `modules/handfx/server.js:78`), and **only `shoot` wears a skin today** (`server.js:274-278` writes
  `skins.shoot`; `module.json` `skins.help` says the same). An unknown skin is a 400, never coerced.
- **`effects` replaces** the list, and any effect not in it stops drawing immediately
  (`fx.js:563`). `effect.set` is the only command that writes it.
- **`bufferScroll`** is a plain scalar overwrite; the renderer reads it as the lift of an effect
  rising from a low palm, `(1 - y) * bufferScroll * 0.6` in field heights (`fx.js:1304`), and the
  overlay defaults it to `0.35` when absent (`pages/js/overlay/main.js:106`).

## Pages

| route | file | expects |
|---|---|---|
| `/shockfx` | `pages/overlay.html` + `js/overlay/main.js` | isolated document; camera + MediaPipe `HandLandmarker`; SSE `/events?channels=handfx`; reads `/api/handfx/status`; posts `/ack` with effect/tracking/model/hands/gesture; receives body masks from the body page over its own channel |
| `/shockfx/body` | `pages/body.html` | isolated; MediaPipe pose + selfie segmenter; posts `{source:'body', open:true}` to `/ack` as a heartbeat; sends the mask to the overlay page |

Engine modules (`pages/js/engine/`), importable by page and pane: `tracker.js` (camera, MediaPipe,
synthetic hand), `gestures.js` (pure classifier, motion, gate), `fx.js` (WebGL2 renderer, effect
registry, anchors), `fx-glsl.js` / `fx-glsl2.js` (GLSL ES 3.00, no extensions), `pose.js` (hand
geometry).

### Effect / skin model (23 effects, two skins)

The registry is 23 ids (`modules/handfx/server.js:51-75` `EFFECTS` for the server's copy, the
implementations live in `pages/js/engine/fx.js`): `fireball`, `lightning`, `sparkring`, `embers`,
`smoke`, `aura`, `wires`, `frost`, `portal`, `disco`, `slime`, `inkflow`, `shatter`, `cyber`,
`bloomlife`, `echo`, `bodyonfire`, `bodysmoke`, `frozenbody`, `edit`, `electroshock`, `meteor`,
`shoot`. The server knows ids only, never parameters.

**Skins.** A skin is a visual variant of one effect, not a separate effect: `skins` is an
`effect id → 'projectile' | 'heart'` map (`module.json` `settings.skins`; `SKINS` at
`server.js:78`). Only `shoot` has implementations for both today — an entry for any other id is
harmless but unread by the renderer. Absent means the default projectile orb. Two writers:
the pane's skin switch and `projectile.fire {skin}` (`server.js:274-278`, which validates against
`SKINS` and 400s on anything else rather than coercing).

### Command table (what a deck key posts)

`POST /api/handfx/cmd {cmd, args?}`; `cmd` must be in `CMDS` (`server.js:32-41`) or the answer is
400 `unknown cmd: … (known: …)`. All payloads below are the real ones from `server.js:261-320`.

| cmd | args | who acts | answer |
|---|---|---|---|
| `effect.next` | — | page (owns the cursor) | `{ok, seq}` |
| `effect.prev` | — | page | `{ok, seq}` |
| `effect.set` | `{value: [effectId, …]}` — or legacy `{id: effectId}` | server writes `settings.effects` on `value`, else publishes | `{ok, changed, settings}` with `value`; `{ok, seq}` with `id`; 400 `unknown effect: …` |
| `tracking.toggle` | — | server flips `settings.enabled` | `{ok, changed, enabled, settings}` |
| `mirror.toggle` | — | server flips `settings.mirror` | `{ok, changed, mirror, settings}` |
| `projectile.fire` | `{skin?: 'projectile'\|'heart'}` | server records `settings.skins.shoot` when `skin` is given, then publishes | `{ok, seq}`; 400 `unknown skin: …` |
| `edit.clear` | — | page wipes the operator's drawn canvas | `{ok, seq}` |
| `reload` | — | page reloads | `{ok, seq}` |

Every publish is stamped with `args.at` and `args.id`. Commands that only publish still reach the
page on the `handfx` channel; `next`/`prev`/`reload` are deliberately the page's, because the
cursor the operator sees is the page's own.
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
through `POST /api/handfx/cmd`, `/status` polling. The Tracking card has a `hand source` select
(`auto`|`camera`|`synthetic`, persisted like the underlay switch) and a pill that reads
`/status.effectiveSource` — e.g. `synthetic — auto fallback (…cameraError…)` — so `auto` that fell
back to the rig is visible, not implied.

## Preview isolation (`?preview=1`)

The pane's live preview is the real page (`public/src/preview.js` appends `?preview=1`). A
preview is a viewer, never a source:

- it does not open the camera or the relay, does not connect the command bus, and does not run the
  recovery watchdog (`pages/js/overlay/main.js`);
- it never POSTs `/ack`, so it contributes nothing to `draws`/`lastDrawAt`/`lastAckAt`; the server
  also drops `/ack` bodies carrying `{preview:true}` outright (`server.js` `/ack`), so a preview
  can never inflate the `Math.max` draw counter even if one is posted by hand;
- it draws the synthetic rig locally, so effects are visible, and forces the underlay off in its
  own iframe (never a settings write);
- the pane labels it (`synthetic hands, underlay off in this preview`) rather than pretending the
  preview is the OBS source, and it shows the 9:16 collision fence the particles collide with.

With only a preview open, `/status` reports `draws: 0`, `effectiveSource: "none"`.

## Honest states (page and pane must not fake these)

- camera: `off`, `asking`, `on`, `denied`, `held` (another document owns it), `error` — distinct
  messages, never "tracking" when it is not.
- model: `idle`, `loading`, `ready`, `failed`, `cached` (downloaded from the CDN once).
- no hands is `hands: 0, gesture: 'none'`.
- synthetic replay is labelled as such; `auto` failing over to it is shown as a fallback, not as a
  chosen mode.

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
