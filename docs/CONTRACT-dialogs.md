# CONTRACT-dialogs — alerts

Purpose: fake desktop dialogs (Win95, Win11, macOS) that pop up on the stream with buttons, a
cursor and storm mode, spawned from the shared message pool.

Source: `modules/dialogs/routes.js`, `state.mjs`, `module.json`, `ui/`, `overlay/`.

## module.json claims

```json
{
  "id": "dialogs", "title": "Alerts", "version": "1.0.0", "order": 30,
  "mount": "routes.js", "channels": ["dialogs"],
  "pages": [{ "route": "/dialogs", "file": "overlay/index.html", "title": "Alert overlay" }]
}
```

Same pool as notifications, different renderer: a message's `kind` (`dialog` vs `notification`)
decides which module may spawn it. Nothing is stored per message here. No `legacyRoutes()`.

## HTTP routes (all under `/api/dialogs`)

| method | path | params | reply |
|---|---|---|---|
| GET | `/live` | — | `{ok, rev, live[], count, capacity, origin, settings}` |
| POST | `/live` | `{spec?, any?, poolId?, origin?}` | `{ok, entity}`; 404 unknown `poolId`, 400 when the message is a notification, 409 when nothing is eligible |
| POST | `/live/measure` | `{id, w, h}` | `{ok, entity}` — the overlay reports the measured dialog box; 400 without `id`, 404 unknown dialog |
| POST | `/live/storm` | `{count?: 1..24 = 6, any?: true}` | `{ok, spawned}` — spawns up to `count` distinct eligible dialogs |
| DELETE | `/live` | `?id=` optional | `{ok, closed:n}` — closes one (`id`) or all |
| PATCH | `/settings` | any subset of the settings keys (`tone` validated against the sound directory) | `{ok, changed[], settings}` |
| GET | `/audio/list` | — | `{ok, available, dir, files[], error, defaults[], key:'tone'}`; `available:false` + `error` when the directory cannot be read (still 200) |

## Bus

Channel `dialogs`.

| frame | shape | when |
|---|---|---|
| cmd `snapshot` | `publish('dialogs','snapshot', {rev, live[], count, capacity, origin})` | spawn, close, measure, comment, settings change |
| event `relayout` | `emit('dialogs','relayout', snapshot)` | any `PATCH /settings` that changed something |
| event `sound` | `emit('dialogs','sound', {sound:'dialog', volume})` | a spawn, when `sound` is on — informational: the overlay plays from its own settings |

No inbound bus commands; the overlay drives the server over HTTP. `snapshot` is replayable, the
other two are not. The `rev` in a snapshot lets the overlay skip a stale frame.

## Settings (document `state/dialogs/settings.json`)

| key | type | default | effect |
|---|---|---|---|
| `theme` | enum `win95`\|`win11`\|`macos` | `win11` | window skin (`documentElement.className = skin-<theme>`) |
| `scale` | number 0.5–1.2 | 0.7 | dialog scale (`--scale` CSS variable) |
| `sound` | boolean | true | play a tone per newly shown alert; off drops the page's `<audio>` |
| `volume` | number 0–1 | 0.6 | gain applied at play time |
| `tone` | string | `error_CDOxCYm.mp3` | clip name the page preloads; `PATCH` refuses a name not on disk |

The tone is a `GET /api/dialogs/audio/list` entry (same shape as the notifications route), and the
pane renders it as a picker over that list, falling back to a text box when the directory is
unavailable. Clips are served by the origin-level `/audio/<name>` that the notifications module
owns; dialogs mounts the list route only.

## Pages and panes

| surface | file | expects |
|---|---|---|
| `/dialogs` | `overlay/index.html` + `overlay/app.js` | transparent overlay, one SSE subscription to `/events?channels=dialogs`; re-reads `/live` once per frame and on `reset`; posts its box size to `/live/measure` and its button answers with `DELETE /live?id=` |
| pane | `ui/pane.js` in the admin shell | live list, Spawn / Storm / Clear (`POST /live`, `POST /live/storm`, `DELETE /live`), settings form, `sound` event as information only |

## State files (`state/dialogs/`)

- `settings.json` only. Live dialogs are memory-only.

## Test gate

`test/api-smoke.mjs` (routes: spawn, wrong-kind rejection, `/live/measure`, `/live` read),
`test/panes-notify-dialogs.mjs` (the pane in headless Chrome) and `test/sound.mjs` (the tone
picker's list route, one play per new alert, none on load or on a `measure` re-send).
