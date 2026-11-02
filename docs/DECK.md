# DECK — the Stream Deck keys that drive ShockBox

The XL deck on ADV-DT01 has a handful of keys wired to ShockBox. This page says exactly what each
key is, what body it posts, and how to change, prove or undo the wiring.

Most of the moving parts live **next to** this repo, in `/home/alex/OBS/`:

| part | path |
|---|---|
| profile patcher (writes the keys into the `.sdProfile`) | `~/OBS/tools/sd-soundctl/patch-shockbox-keys.py` |
| icon generator | `~/OBS/tools/sd-soundctl/gen-handfx-icons.py` |
| read-only visual audit of the deck window | `~/OBS/tools/sd-soundctl/audit-visual.py` |
| hotkey → HTTP bindings (HKCU) | `~/OBS/deploy/streamdeck-bindings/bind-handfx-keys.ps1` (+ its `README.md`) |
| the HTTP endpoints those keys call | **this repo**: `modules/handfx/server.js`, `modules/wall/server.js` |

Nothing under `deploy/` in *this* repo contains `streamdeck-bindings/`; it is in the parent `~/OBS/deploy/`.

## 1. Why a hotkey and not a plugin action

A Stream Deck plugin cannot POST by itself: `com.alex.obsbg` owns the wall and handfx routes but
has no action that forwards an arbitrary command, so every ShockBox key is a plain Stream Deck
**Hotkey** action and the fire path lives in the OS
(`~/OBS/deploy/streamdeck-bindings/README.md:11-14`, same reason in
`~/OBS/tools/sd-soundctl/patch-shockbox-keys.py:1-35`).

The chain on a key press:

```
Stream Deck Hotkey action (F13…F20, F24)
  └─ Explorer: HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\AppKey\<vk>\ShellExecute
       └─ cmd.exe /c start "" /b curl.exe -s -m 3 -X POST -H "Content-Type: application/json"
            -d "{...}" http://127.0.0.1:8972/api/{handfx,wall}/cmd
```

`ShellExecute` is a documented-but-unstandardised hook: if a Windows update stops honouring it the
keys go silent, while the profile stays intact
(`~/OBS/deploy/streamdeck-bindings/README.md:83-85`). VK numbers are F13=`0x7C`=124 …
F20=`0x83`=131, F24=`0x87`=135
(`~/OBS/deploy/streamdeck-bindings/bind-handfx-keys.ps1:43-51`).

## 2. Live bindings and the exact HTTP bodies

Source of truth for the command lines: the `$Bindings` table in
`~/OBS/deploy/streamdeck-bindings/bind-handfx-keys.ps1:59-77`, assembled by the `Post()`
helper (`:54-57`). Source of truth for what the server does with each body: this repo.

| key | page · cell | hotkey | AppKey | request |
|---|---|---|---|---|
| RATIO `16:9 / 9:16` | LED Wall · `8,1` | F24 | 135 | `POST /api/wall/cmd` body `{"cmd":"ratio.toggle"}` |
| FX NEXT | Hand FX · `1,0` | F13 | 124 | `POST /api/handfx/cmd` body `{"cmd":"effect.next"}` |
| FX PREV | Hand FX · `2,0` | F14 | 125 | `… {"cmd":"effect.prev"}` |
| FIRE | Hand FX · `3,0` | F15 | 126 | `… {"cmd":"projectile.fire","args":{"skin":"projectile"}}` |
| SKIN | Hand FX · `4,0` | F16 | 127 | runs `%LOCALAPPDATA%\ShockBox\handfx-skin-toggle.ps1` (reads status, then fires) |
| TRACK | Hand FX · `5,0` | F17 | 128 | `… {"cmd":"tracking.toggle"}` |
| MIRROR | Hand FX · `1,1` | F18 | 129 | `… {"cmd":"mirror.toggle"}` |
| EDIT CLEAR | Hand FX · `2,1` | F19 | 130 | `… {"cmd":"edit.clear"}` |
| RELOAD | Hand FX · `3,1` | F20 | 131 | `… {"cmd":"reload"}` |
| *(back)* | Hand FX · `0,0` | — | — | Stream Deck `backtoparent` action, no HTTP |

The binder's `$Bindings` named entries (`bind-handfx-keys.ps1:60-77`), in its order: `wall-ratio`
(`0x87`), `handfx-next` (`0x7C`), `handfx-prev` (`0x7D`), `handfx-fire` (`0x7E`), `handfx-tracking`
(`0x80`), `handfx-mirror` (`0x81`), `handfx-clear` (`0x82`), `handfx-reload` (`0x83`); `handfx-skin`
is appended to the check list with the literal name `127` (`:115`).

Profile layout: the RATIO key sits on the **LED Wall** page at `8,1`
(`patch-shockbox-keys.py:206-215`); the **Scenes 1** page gets a folder at `7,4` that opens the
new **Hand FX** child page (`:217-226`); the child page is a 6×2 keypad with `0,0` = back
(`:245-257`, `313`). The child page is reached only through the folder key — the patcher never
lists it in the profile's page order, so it lives as a folder child.

**Profile UUID.** The Hand FX page's directory name is a UUID the patcher generates itself with
`uuid.uuid4()` the first time it creates the page (`patch-shockbox-keys.py:201-204`, `245-248`,
`305-311`), so it is **not committed anywhere** and differs per install. The UUID on the rig as of
2026-10-31 is `823f02fd-a5fd-4b6b-b25d-4afcc851b0fb` — read it back from the installed profile at
`C:\Users\Alex\AppData\Roaming\Elgato\StreamDeck\ProfilesV3\` (the page folder inside the profile;
the profile folder prefix is `patch-shockbox-keys.py:41-47`) rather than trusting this page after
a re-install.

### 2.1 `POST /api/wall/cmd` — `{"cmd":"ratio.toggle"}`

- Route: `modules/wall/server.js:372-391` (dispatch at `:380`). The handler spreads the dispatcher's
  own answer and forces `ok` unless it is explicitly `false` (`:381-388`), so a refused toggle's
  `ok:false` and a successful one's `ratio` both ride back.
- Validation: `ratio.toggle` is a bare command, no args (`modules/wall/commands.mjs:14-30`, `60`).
- Behaviour: the **server** answers it and does not forward it to the page (`modules/wall/server.js:21`,
  `286-293`). Inside a forcing scene the toggle to portrait is refused with `ok:false,
  note:'refused: scene forces 16:9', ratio:<current>` (`:312-318`); otherwise it flips the `ratio`
  setting and answers `{ok:true, note:'ratio', ratio:<new>}` (`:319-320`). The forcing scene list is
  core's `forceScenes` (`server.mjs:131-137`; read by the wall at
  `modules/wall/server.js:89-94`).

### 2.2 `POST /api/handfx/cmd` — general contract

Route: `modules/handfx/server.js:261-321`. The body is `{cmd, args?}`; `cmd` must be in `CMDS`
(`:32-41`) or the answer is 400 `unknown cmd: …` (`:267-269`). `args` must be an object, else `{}`
(`:270`).

| body | server behaviour | line |
|---|---|---|
| `{"cmd":"effect.next"}`, `{"cmd":"effect.prev"}` | published on the `handfx` channel; **the page** owns the cursor and acts on it | `:315-319`, page side `modules/handfx/pages/js/overlay/main.js:161-162` |
| `{"cmd":"reload"}` | published; the page reloads its filter | `:315-319` |
| `{"cmd":"edit.clear"}` | published; the page wipes the hand-drawn canvas (server relays only) | `:279-283`, `:318` |
| `{"cmd":"tracking.toggle"}` | flips `enabled`, publishes, answers `{ok, changed, enabled, settings}` | `:284-288` |
| `{"cmd":"mirror.toggle"}` | flips `mirror`, publishes, answers `{ok, changed, mirror, settings}` | `:289-293` |
| `{"cmd":"projectile.fire"}` | published as-is | `:318-319` |
| `{"cmd":"projectile.fire","args":{"skin":"projectile"}}` | **also writes** `settings.skins.shoot = "projectile"`, then publishes | `:274-278` |
| `{"cmd":"projectile.fire","args":{"skin":"<other>"}}` | 400 `unknown skin: …` — only `projectile` and `heart` exist | `:77-78`, `:275` |
| `{"cmd":"effect.set","args":{"value":[ids…]}}` | validates every id, writes the `effects` list, publishes | `:294-309` |
| `{"cmd":"effect.set","args":{"id":<id>}}` | legacy shape: validates, then falls through to publish only | `:310-318` |

Every successful publish answers `{ok:true, seq}` (`:318-319`). The status document adds
`at` and `id` to the published args (`:197-201`).

### 2.3 Why FIRE is pinned to `skin: projectile`

`projectile.fire` **writes** `skins.shoot` on every skin-qualified call (`modules/handfx/server.js:274-278`).
If the FIRE key carried a skin too, each press would overwrite the setting and the SKIN key's
choice would keep getting clobbered. So FIRE is the fixed `projectile` fire and SKIN owns the
toggle (`~/OBS/deploy/streamdeck-bindings/README.md:37-39`).

### 2.4 SKIN — the one key that branches

A hotkey callback is a single fixed command line, so F16 (AppKey 127) runs a per-user PowerShell
script instead of `curl` (`bind-handfx-keys.ps1:79-98`). On `-Apply` the binding script writes
`%LOCALAPPDATA%\ShockBox\handfx-skin-toggle.ps1` with this body (`:83`, `87-98`, `118-120`):

```powershell
$st  = Invoke-RestMethod -Uri 'http://127.0.0.1:8972/api/handfx/status'
$cur = $st.settings.skins.value.shoot
if ($cur -eq 'heart') { $next = 'projectile' } else { $next = 'heart' }
$body = @{ cmd = 'projectile.fire'; args = @{ skin = $next } } | ConvertTo-Json -Compress
Invoke-WebRequest -Method Post -ContentType 'application/json' -Uri 'http://127.0.0.1:8972/api/handfx/cmd' -Body $body
```

It reads the current skin from `/status`, where the setting lives nested as
`settings.skins.value.shoot` — the shape `/status` publishes is `settings: settings.describe()`
(`modules/handfx/server.js:203-227`, `skins` declared in `modules/handfx/module.json:13-19`), and
`describe()` wraps each value in `{…, value}`. Both the overlay pane's skin switch and
`projectile.fire {skin}` write that same field, so the key and the pane cannot disagree.

## 3. Changing the wiring

### 3.1 The profile (keys, layout, icons)

```bash
win "taskkill /IM StreamDeck.exe /F"      # the app holds profiles in memory and rewrites on exit
cd /home/alex/OBS/tools/sd-soundctl
python3 patch-shockbox-keys.py            # PLAN ONLY: prints every cell it would touch
python3 patch-shockbox-keys.py --apply    # backup, write, render icons, read back
win "schtasks /run /tn StreamDeck-Launch" # or: schtasks /run /tn SDStart
```

(Procedure from `~/OBS/deploy/streamdeck-bindings/README.md:41-57`.)

Guarantees in the patcher:

- **Dry run by default.** Only `--apply` writes; without it the tool prints the plan
  (`patch-shockbox-keys.py:288-290`).
- **Refuses an occupied cell.** A cell holding someone else's action is reported and nothing is
  written (`:196-243`, returns 1).
- **Refuses to run while Stream Deck is running.** The probe is `winps` counting `StreamDeck`
  processes; an unknown answer counts as running; `--force` skips the probe
  (`:292-297`, `260-267`).
- **Backup first.** `<profile>.bak-shockboxkeys-<stamp>` is copied next to the profile before
  anything is written (`:299-301`).
- **Read-back.** Every written cell is re-read from disk and compared; an unresolved `Image`
  reference is reported as `IMAGE MISSING`. The run exits **3** when the write landed but the
  proof failed (`:334-352`, exit at `:355`).

Icons are rendered by `gen-handfx-icons.py`: 72×72 SVG in
`/home/alex/OBS/plugins/com.alex.obsbg.sdPlugin/icons/<slug>.svg`, rasterised to 144×144 PNG into
each page's `Images/` (`gen-handfx-icons.py:1-21`, `148-156`). CLI: `--check` (exit 1 on a missing
file) or `--write <pageDir> [...]` (`:12-13`, `126-132`, `157-163`).

### 3.2 The bindings (hotkey → HTTP)

```bash
# C:\OBS is not mounted in WSL, so ship the script across first
cp -r /home/alex/OBS/deploy/streamdeck-bindings /mnt/c/temp/sdbind
winps '& "C:\temp\sdbind\bind-handfx-keys.ps1"'          # default mode is -Check
winps '& "C:\temp\sdbind\bind-handfx-keys.ps1" -Apply'   # HKCU per-user, no admin
```

- **`-Check` is the default mode.** There is no default switch: `if (-not $Apply) { $Check = $true }`
  (`bind-handfx-keys.ps1:35`), so a bare invocation only reads; `-Apply` is the write path.
- The mapping table is `:60-77` (F13…F20 at `:43-50`, **F24→`0x87` = 135** at `:51`, with a named
  `0x7F`=127 for the SKIN script at `:115`). (An earlier brief said "F24 = 24"; AppKey subkey names
  are **virtual-key codes**, so F24 is 135.)
- `-Apply` writes the `ShellExecute` value **and an empty `Association` value** under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\AppKey\<vk>`, because Explorer requires
  the value to exist (`:122-129`).
- Check mode also probes ShockBox and warns when nothing answers on 8972 (`:103-108`), then prints
  `SET`/`MISSING` per key and, when not applying, the stored command line (`:132-143`).
- `winps` takes the script **positionally**; `& "path" -Switch` is the working form
  (`bind-handfx-keys.ps1:9-16`, `README.md:59-60`).
- The script never starts or stops ShockBox; the keys do nothing until the server is up
  (`bind-handfx-keys.ps1:26-28`, `103-108`).

### 3.3 Reading the profile and auditing what is on the deck

Read-only tools in `/home/alex/OBS/tools/sd-soundctl/`:

- `inspect-profile.py` — a profile **reader**: it loads a `.sdProfile` and prints its pages, the
  action at each cell and any unresolved `Image` references. Use it to answer "what is on key
  `3,0` of the Hand FX page" without opening the app.
- `audit-visual.py` — reads a screenshot of the Stream Deck window (taken by `cap.ps1`) and
  measures per-cell ink/plate, flagging cells whose icon is missing or invisible
  (`audit-visual.py:1-14`, `84-142`). It resolves cell roles from its own `ROUTES` table
  (`:18-19`), matches them against a manifest under its hard-coded `PROFILE_ROOT` (`:16`, `92-93`),
  and takes the screenshot path positionally plus an optional `--json` (`:12`, `84-88`).
- `gen-handfx-icons.py --check` — proves the icon *files* exist without touching the deck.

> **`sd_audit` does not exist.** An earlier brief referred to `sd_audit.py grid|check`; there is no
> such file in `/home/alex/OBS/tools/sd-soundctl/`. The real tools are the three above. Always
> audit a write against the profile read back by `patch-shockbox-keys.py` (exit 3 on a failed
> proof) and, visually, `audit-visual.py`.

### 3.4 Proving a key without pressing it

Run a throwaway listener on `127.0.0.1:8972` from WSL, then execute the registry value itself
(`cmd /c <ShellExecute>`) — what Explorer does on the key press — and compare what the listener
saw (`~/OBS/deploy/streamdeck-bindings/README.md:62-73`). The recorded proof (2026-10-30)
covers F13, F15, F16 and F24 with the bodies in §2. Remember §3 of `docs/WIRING.md`: a WSL listener
on 8972 occupies the port for Windows too, so the real server must be down while you test.

## 4. Undo

- **Profile:** restore `<profile>.bak-shockboxkeys-<stamp>` over the profile directory with Stream
  Deck stopped (`README.md:75-77`).
- **Bindings:** delete the `ShellExecute` value (or the whole subkey) under
  `HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\AppKey\124` … `\135`
  (`README.md:78-79`).
- **SKIN script:** delete `%LOCALAPPDATA%\ShockBox\handfx-skin-toggle.ps1` (`:83`, `:142`).

## 5. Watch-outs

- A Hotkey action has no state to paint: TRACK, MIRROR and RATIO toggle the *server's* state, and
  the deck shows nothing about it (`README.md:87-89`).
- The first press after a cold boot can be ~1 s late (PowerShell/cmd warm-up on F16)
  (`README.md:86`).
- The RATIO key is a no-op inside a forcing scene by design (`modules/wall/server.js:315-318`) and
  the response says so — a dead-looking key there is correct behaviour, not a broken binding.
