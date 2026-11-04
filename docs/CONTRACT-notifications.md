# CONTRACT-notifications — toasts

Purpose: small toast notifications in four OS looks, spawned from the shared message pool, queued,
auto-closing, with a storm mode for testing.

Source: `modules/notifications/routes.js`, `state.mjs`, `constants.mjs`, `module.json`, `ui/`,
`overlay/`.

## module.json claims

```json
{
  "id": "notifications", "title": "Notifications", "version": "1.0.0", "order": 20,
  "mount": "routes.js", "channels": ["notifications"],
  "pages": [{ "route": "/notify", "file": "overlay/index.html", "title": "Notification overlay" }]
}
```

The module reads the core pool (`ctx.pool`) for its messages: ids, text, buttons and eligibility
are core's; nothing is stored here. It exports no `legacyRoutes()`.

## HTTP routes (all under `/api/notifications`)

| method | path | params | reply |
|---|---|---|---|
| GET | `/live` | — | `{ok, rev, live[], stack{x,gap,height,used,capacity}, lastSpawnAt, origin, settings}` |
| POST | `/live` | `{spec?, any?, poolId?, origin?}` | `{ok, entity}`; 404 unknown `poolId`, 400 when the message is an alert, 409 when nothing is eligible for random |
| DELETE | `/live` | — | `{ok, closed:n}` — closes every live toast |
| POST | `/live/storm` | `{mode?: 'fill'\|'random', count?: 1..12 = 6, interval?: 20..10000 = 320}` | `{ok, mode, total}` — **currently broken**, see below |
| PATCH | `/settings` | any subset of the settings keys (`tone` validated against the sound directory) | `{ok, changed[], settings}` |
| GET | `/audio/list` | — | `{ok, available, dir, files[], error, defaults[], key:'tone'}`; `available:false` + `error` when the directory cannot be read (still 200) |

`POST /live` resolution order: an explicit `spec`; else `any:true` takes the first pool message;
else `poolId` must name a message whose `kind` is `notification`; else a random eligible message.

`POST /live/storm` spawns from the pool's `storm`-eligible notifications: `fill` shows one of
each (capped at 12), `random` shows `count`. A once-per-`interval` timer drives it; `handle` is
declared before the first synchronous `tick()` so there is no TDZ read. 409 when no message is
marked `storm`. Verified against a `storm:true` pool message (`{ok:true, mode:'fill', total:1}`).

## Bus

Channel `notifications`.

| frame | shape | when |
|---|---|---|
| cmd `snapshot` | `publish('notifications','snapshot', {rev, live[], stack, lastSpawnAt, origin})` | every spawn, close and auto-close sweep |
| event `relayout` | `emit('notifications','relayout', snapshot)` | `PATCH /settings` changing `height` or `style` |
| event `sound` | `emit('notifications','sound', {sound:'notify', volume})` | a spawn, when `sound` is on — informational: the overlay plays from its own settings |

There are no inbound bus commands: the server acts only on HTTP. `snapshot` is a published frame
(replayable); `relayout` and `sound` are events (not replayable).

**Gotcha — query strings are ignored, not rejected.** The registry matches routes on `url.pathname`
only (`core/registry.mjs:157` for string routes, `:169` for pages), so `?mode=obs` on an overlay
URL is silently unread: `/notify?mode=obs` and `/notify` are the same page, and nothing in this
module ever looks at a query string. A wrong-looking overlay is not a bad parameter — the parameter
does not exist. The same is true of the other overlay pages (`/dialogs`, `/wall/render`,
`/shockfx`). Path-only matching is also why each page's `static` sibling directory resolves without
per-file routes.

`state.mjs` auto-close is a 400 ms `setInterval` sweep in `init()` (`routes.js:26`), cleared in
`dispose()`.

## Settings (document `state/notifications/settings.json`)

| key | type | default | effect |
|---|---|---|---|
| `style` | enum `ios`\|`android`\|`win11`\|`macos` | `ios` | toast look; a change reflows the stack |
| `height` | integer 48–160 | 76 | toast height in px; drives stack spacing; a change reflows |
| `autoCloseMs` | integer 0–120000 | 12000 | auto-close delay, 0 = never (swept every 400 ms, never persisted) |
| `sound` | boolean | true | play a tone per newly shown notification; off drops the page's `<audio>` |
| `volume` | number 0–1 | 0.6 | gain applied at play time |
| `tone` | string | `iphone_16_messege_tone.mp3` | clip name the page preloads; `PATCH` refuses a name not on disk |

The tone is a `GET /api/notifications/audio/list` entry; the pane renders the field as a picker
over that list, or a plain text box when the directory is unavailable. `/audio/<name>` (the clip
itself) is origin-level, not under `/api`: `modules/notifications/audio.mjs` serves it from
`--sounds <dir>` (env `SHOCKBOX_SOUNDS`, config `soundsDir`, default
`C:\OBS\Sounds\SoundBoard`), with an extension allow-list and a traversal guard.

The overlay reads `style`, `sound`, `volume` and `tone` from the snapshot, positions itself from
server coordinates, and plays one clip per newly seen record (`modules/notifications/sound.mjs`,
shared with dialogs). The first payload seeds the page, so a load over existing banners is silent;
a blocked autoplay is retried once on the next pointer/key gesture.

## Pages and panes

| surface | file | expects |
|---|---|---|
| `/notify` | `overlay/index.html` + `overlay/app.js` | a 405-px-wide transparent overlay; one SSE subscription to `/events?channels=notifications`; re-reads `/live` on each frame and on `reset`; reads `{live, stack, settings}` |
| pane | `ui/pane.js` in the admin shell | the live list, Clear and Storm buttons (`POST`/`DELETE /live`, `POST /live/storm`), the settings form (`PATCH /settings`) including the tone picker from `/audio/list`, the `sound` event as information only (`streamOut.dataset.sound`) |

## State files (`state/notifications/`)

- `settings.json` only. Live toasts are memory-only: they are never persisted, so a restart starts
  with an empty screen.

## Test gate

`test/api-smoke.mjs` covers the routes over HTTP (spawn, poolId validation, wrong-kind rejection,
settings). `test/panes-notify-dialogs.mjs` mounts the pane in headless Chrome. Neither exercises
`/live/storm`, which is why the broken route above passes the gate.
