# ShockBox architecture

ShockBox is one Node process that serves an admin shell, module pages, a JSON API and one SSE
bus. Every stream feature (LED wall, notifications, alerts, hand FX) is a folder under `modules/`.
There is no build step and no dependency: the server imports only Node built-ins.

```
server.mjs ──► core/  registry · store · settings · events · obs · server-http · pool · compat-port
                  │
                  └──► modules/<id>/   module.json + server.js (or routes.js) + ui/ + pages/
```

## 1. The process

`server.mjs` reads `config.json` and CLI flags, builds the core objects, loads the registry, then
listens.

- **Config** (`server.mjs`): `--port`, `--host`, `--state`, `--no-compat`, `--sounds`; env
  `SHOCKBOX_PORT`, `PORT`, `SHOCKBOX_HOST`, `SHOCKBOX_STATE`, `SHOCKBOX_SOUNDS`, `EP_COMPAT=1`
  (+`EP_COMPAT_PORT`); `config.json` keys `port`, `host`, `stateDir`, `soundsDir`, `compatPort`.
  Default port 8972, host `127.0.0.1`, state `./state`.
- **Core settings** (`core/settings.mjs`, document `state/core/settings.json`): `forceScenes`,
  `obsEnabled`, `obsUrl`, `compatPort`, `publicUrl`. These are core's; no module owns them.
- **Pool** (`core/pool.mjs`, document `state/pool.json`) is loaded before the registry so a
  module's `init` can read it. It publishes on the `pool` channel.
- **OBS client** (`core/obs.mjs`) is created with `obsUrl` and connected only when `obsEnabled`.
- **Registry** (`core/registry.mjs`) scans `modules/*/module.json` and boots each module.
- **HTTP server** (`core/server-http.mjs`) owns `/health`, `/api/modules*`, `/api/log`,
  `/api/core/*`, `/events`, then `core.extraRoutes` (pool), then the mount-prefix hook, then module
  routes, then module pages and their siblings, then `public/`, then `/mod/<id>/<path>`.
  `GET /health` (`core/server-http.mjs:207-222`) reports `modules` as a **flat `id → status` map**
  (`{"wall":"up"}`), not the object form — that richer shape (`{id, status, error, pages, routes,
  …}`) is only on `GET /api/modules` (`core/server-http.mjs:223-225`, the registry's `describe()`).
  It always answers `ok: true` as long as the process is serving, so **a green `/health` does not
  mean OBS is live**: with OBS closed the OBS client sits at `obs: {state:"connecting", scene:null}`
  (`core/obs.mjs:21` the state machine's `connecting`, `server-http.mjs:219`) and keeps retrying
  with growing backoff forever — it never gives up and never reports a failure. Check
  `obs.state === "ready"` (and for the wall, `GET /api/wall/render`'s `online`) before trusting
  scene-dependent behaviour.
- **Legacy port** (`core/compat-port.mjs`): when `compatPort` is non-zero, a second listener on
  that port serves only the exact routes `notifications.module.api.legacyRoutes()` returns,
  for deck actions during cutover. Currently that module exports no `legacyRoutes()`, so a
  configured compat port logs "no module provides legacy routes — skipped" and never listens.

### What core may and may not know

Core names no module. It never imports anything from `modules/`, and a module never imports another
module. A module receives its context (`ctx`) from the registry: `events`, `obs`, `log`, the core
`settings`, `pool`, `fs`, `paths`, `core` (version/urls), and its own `settings` built from its
manifest. All module data lives under `state/<id>/`, created by the registry before `init`.

Core has exactly two generic hooks for things only a module knows:

1. **Per-page response headers.** A `module.json` page may carry
   `"headers": {"cross-origin-opener-policy": "same-origin", …}`. `cleanHeaders` validates the
   shape and strips anything core sets itself; `serveFile(..., {headers})` applies them to the page
   file and to the page's static siblings. `GET /api/modules/<id>/routes` echoes them. Core never
   names COOP or COEP.
2. **Module asset mount.** A module may expose `mountPrefix` (e.g. `/vendor/`) and
   `mountFile(req, res, url, filePath)` on its API. Any GET/HEAD under `/api/<id>/<prefix>/…` is
   handed to that handler with the remainder of the path; core does not know what the files are.
   HandFX serves its ~20 MB MediaPipe runtime this way.

There is no other core knowledge of a module: no route greps, no per-module conditions.

### Who owns the process

`server.mjs` is not started by hand on the rig. The owner is the **TUI supervisor**
(`tools/tui/`, Python): the desktop shortcut runs `deploy\ShockBox-TUI.cmd`, which opens the TUI;
the TUI starts `node server.mjs` detached, holds the port, restarts node with 2/4/8/16/30/60 s
backoff, and keeps running after its window closes. A run that stays up `HEALTHY_S` (300 s) resets
the sequence (`tools/tui/shockbox_tui/supervisor.py:62-65`). There is no autostart at logon — the
old `ShockBox-Server` scheduled task was retired (`deploy/install.ps1:285-304`). Supervisor
internals, settings and controls: [`docs/TUI.md`](TUI.md); install/start/stop: `deploy/README.md`.

## 2. The registry contract

Discovery: directories under `modules/`, sorted by name; a directory without `module.json` is
ignored. The manifest fields:

| field | meaning |
|---|---|
| `id` | `/^[a-z][a-z0-9-]{1,23}$/`, defaults to the folder name. Reserved (rejected): `core`, `api`, `events`, `health`, `control`, `public`, `mod`, `static` |
| `title` | display name, defaults to `id` |
| `version` | logged at boot |
| `order` | number, default 100; entries are sorted by `order`, then `id`. This is the resolution order |
| `mount` | the entry file, default `server.js`; must default-export an API object |
| `pages` | page route claims (see below) |
| `settings` | this module's settings schema, built by the registry before `init` |

The API object (default export) may provide `init(ctx)`, `routes(ctx)`, `dispose()`, `channels`
(SSE channel names it publishes on), `state()`, `mountPrefix`, `mountFile`.

**Claims.**

- Routes: `routes(ctx)` returns `[{method, path, handler}]`. `path` is a string (exact) or a
  RegExp; a path not starting with `/api` is prefixed `/api/<id>`. `method` is `GET`/`POST`/… or
  omitted for any method; `HEAD` is accepted where `GET` is. First match in entry order wins.
  Duplicate route paths are **not** rejected — nothing compares two modules' full paths, so the
  earlier entry (`order`, then `id`) silently shadows the later one. Keep module routes namespaced,
  which the automatic `/api/<id>` prefix does for you.
- Pages: `pages[].route` is served verbatim and must not match `/`, `/control(/)`, `/health`,
  `/events`, `/api(…)` or `/mod/…`; such a manifest fails the module at load and the reason is
  logged. `file` is the page file; `static` names the sibling directory (default: the page's
  directory); `headers` are response headers; `cache` defaults to `no-store`.
- Settings: a module owns the key group declared in its own `module.json`. Settings are one
  document per module (`state/<id>/settings.json`), validated against that schema, patched only
  through `settings.patch()`. Core's own keys (`forceScenes`, `obsEnabled`, `obsUrl`,
  `compatPort`, `publicUrl`) live in `state/core/settings.json` and a module may only read them
  (`ctx.settings.get('forceScenes')`). No module may declare a setting another module owns;
  `forceScenes` is core's, not the wall's.

**Precedence.** Core routes answer first, then `core.extraRoutes` (the pool, so no module can
shadow `/api/pools`), then the mount-prefix hook, then module routes, then module pages.
A module that throws during import or `init` is marked `failed`, the error is logged, and every
other module stays up.

## 3. The event bus

One SSE hub (`core/events.mjs`) serves every channel at `GET /events`.

- **Clients.** `GET /events` with no query gets every channel of every up module;
  `?channels=wall,notifications` narrows it; `?view=landscape` delivers only frames for that view
  or frames with no view; `?client=name` is a label in the log.
- **Frames.** `publish(channel, cmd, args, view)` numbers the frame and appends it to the
  channel's ring; each frame is sent twice, as `event: message` (legacy `onmessage`) and as
  `event: <channel>`, with data `{seq, channel, cmd, args, view}`.
- **seq.** Counters are per channel and restart at 1 on every process start. `hello` carries
  `{client, channels, view, boot, seqs}`; `boot` identifies the process.
- **Replay.** `?since=N` replays the ring entries with `seq > N`. No `since` reports the newest
  400 entries (`RING_MAX`) per channel. On `reset`, a page reconnects and re-reads its state (the
  wall drops its cursor to -1 and reopens).
- **reset.** A `since` *greater* than the channel's newest seq is a cursor from an earlier process
  (seq restarts at 1): the hub sends `event: reset` with `{reset: true, reason: 'stale-since',
  seq: 0}` and no replay, so the page re-reads its state over HTTP.
- **Non-replayable frames.** `emit(channel, event, data)` sends without touching the ring — used
  for `state.snapshot`, `sound`, `relayout`, `page`. A client that misses one re-reads over HTTP.
- **Backpressure.** A client whose socket buffer passes 4 MB is dropped; a heartbeat ping runs on a
  timer and drops clients it cannot write; frames are best-effort.
- **Coalescing lives in the pages, not the hub.** The wall render page posts its state to
  `POST /api/wall/state` at most once per 1.5 s (`beat()` refuses a second post inside that
  window, called from the frame loop and from a 2 s timer). That is ≤10 Hz of state deltas and
  typically ~0.7 Hz. The page's 60 fps canvas never goes near the bus: a rendered frame cannot be
  replayed, ordered or re-read, it would fill a 400-entry ring in seven seconds, and six OBS CEF
  connections per host is the limit the single channel exists to respect. Commands and settings
  snapshots (a few per operator action) are what actually traverse the bus.

## 4. The store

`core/store.mjs` (`JsonStore`) is the only writer of JSON documents. One `Settings` instance per
module wraps one store at `state/<id>/settings.json`; a module with its own document (the wall's
`state/<id>/state.json`) uses `ctx.fs` and `ctx.paths`.

- **Write path.** `settings.patch()` / `set()` / `assign()` validate against the schema, write the
  whole document, and only then notify subscribers and the core `onChange`.
- **Atomicity.** Every save writes `<file>.tmp` and `renameSync`s it over the target, so a reader
  sees the old document or the new one, never a partial file. Saves can be debounced
  (`debounceMs`) and flushed on change and on shutdown.
- **Corruption.** An unreadable document is never deleted: it is renamed
  `<file>.unreadable-<stamp>`, the module starts from defaults, and the event is logged. `.tmp`
  leftovers are cleaned up.
- **Backups.** `backups` (default 3) keeps at most one copy per hour under
  `state/<id>/.backups/<file>-YYYYMMDD-HHMMSS.json`; settings stores debounce writes by 120 ms.

`state/` is outside the code tree and never committed.

## 5. The OBS client

`core/obs.mjs`, obs-websocket 5.x over Node's built-in `WebSocket` (no dependency).

- **Connection.** `connect()` opens the socket; `Hello` → `Identify` with the SHA-256 challenge
  and `eventSubscriptions: 0x7ff` (all non-high-volume events). `Identified` sets state `ready`.
- **Reconnect.** On close, every pending request rejects, subscribers get no synthetic event, and
  the client reconnects on its own with backoff 500 ms → ×2 → cap 10 s. On re-`Identified` it
  calls every subscriber with `{type: 'ready'}` and resets the backoff.
- **Current scene.** `CurrentProgramSceneChanged` and `SceneChanged` update `obs.scene`;
  `currentScene()` performs `GetCurrentProgramScene` (used as the level check after `ready`).
  `scenes()`, `sceneItemOf`, `setInputSettings`, `getInputSettings`, `setSourceUrl` and
  `screenshot` are the rest of the surface; each request has a 4 s timeout (8 s for screenshots).
- **Scene-forced ratio** (`modules/wall/ratio.mjs`). The wall subscribes; on `ready` it reads the
  current scene and calls `sync(scene, {reconnect: true})`, then every scene change calls
  `sync(scene)`.
  - It is **edge-triggered on the previous scene**: a reconnect that re-reports the same scene is
    not an entry, so it does not overwrite the remembered "before" ratio; a change between two
    forcing scenes keeps the original memory.
  - Entering a forcing scene (core `forceScenes`, default Desktop, Theater, PHub, OnlyFans,
    CominOut) remembers the operator's ratio and sets `ratio = 16:9`. Leaving restores the
    remembered ratio exactly once.
  - The memory `{lastScene, before, forcing, restore}` is persisted in
    `state/wall/state.json`, so a restart inside a forcing scene restores correctly on exit.
    `ratio.toggle` is refused while a scene is forcing.

## 6. Adding a module

1. `modules/<id>/module.json`
   ```json
   {
     "id": "hello",
     "title": "Hello",
     "version": "1.0.0",
     "order": 50,
     "mount": "server.js",
     "channels": ["hello"],
     "pages": [{ "route": "/hello", "file": "page.html", "title": "Hello" }],
     "settings": {
       "greeting": { "type": "string", "default": "hi", "label": "Greeting" }
     }
   }
   ```
   A module with no settings, no pages and no bus can be just `id`, `title` and `mount`.
2. `modules/<id>/server.js` — `export default { init(ctx) {…}, routes(ctx) { return [{method, path, handler}] }, dispose() {…} }`.
   Put long-lived state on `this` or a closure; `ctx.settings` is the module's document,
   `ctx.events` the bus, `ctx.obs` the OBS client, `ctx.pool` the message pool.
3. Routes: return **relative** paths (`'/status'`) and let the registry prefix `/api/<id>`.
   A `RegExp` path yields its capture groups as the fifth argument (`params`). Return an object
   to send it as JSON; throw `HttpError(status, msg)` for a controlled failure. A POST body is
   already parsed and passed as the fourth argument — do not read the socket.
4. Pages: add `pages[]` entries; put sibling scripts under the page's directory (or `static`).
   Declare `headers` only if the page needs cross-origin isolation.
5. Settings: declare every key in `module.json` with `type`/`default` (plus `min`/`max`/`values`).
   Change them only through the module's `PATCH` route calling `ctx.settings.patch()`.
6. Publish bus frames with `ctx.events.publish(channel, cmd, args, view)`; list every channel in
   `channels` so `GET /events` subscribes new clients to it.
7. Add a pane (`ui/pane.js`, registered by the shell) and a gate under `test/`, then wire the gate
   into `npm test` in `package.json`.
8. Restart the server. Check `GET /health` (`modules.<id> === "up"` — a flat `id → status` map;
   the object form with `.status` and `.error` is on `GET /api/modules`) and
   `GET /api/modules/<id>/routes`.
