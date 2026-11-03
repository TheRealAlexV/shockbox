# ShockBox perf: thermal + resource sampling

Standing rule: **while developing or launching any part of ShockBox, CPU/GPU temperature and
resource use are monitored, with a baseline to compare against.** This directory is the tooling
for that rule, so nobody has to remember it.

## What is measured

One CSV row every 5 s:

| group | columns | source |
|---|---|---|
| load / cpu | `load1`, `load5`, `cpu_user`, `cpu_sys`, `cpu_idle` | `/proc/loadavg`, `/proc/stat` deltas |
| CPU thermal | `pkg_c`, `core_max_c`, `core_avg_c`, `pkg_w` | LibreHardwareMonitor over HTTP |
| GPU | `gpu_c`, `gpu_hotspot_c`, `gpu_w`, `gpu_load`, `gpu_clk`, `gpu_mem_clk` | LibreHardwareMonitor |
| WSL memory | `mem_avail_mb`, `cached_mb` | `/proc/meminfo` |
| ShockBox cost | `sb_node_cpu`, `sb_node_rss_mb`, `sb_sup_cpu`, `sb_sup_rss_mb` | `/proc/<pid>/stat` deltas |

`sb_node_*` is whatever process owns TCP port 8972; `sb_sup_*` is the `shockbox_tui` supervisor
(pid from `~/.local/state/shockbox/supervisor.pid`, else a cmdline scan). Both are empty when
ShockBox is not running. Process CPU% is percent of **one** core, like `top`.

Temperatures come from LibreHardwareMonitor's web server (`http://localhost:8085/data.json`) on
the Windows host; WSL reaches it as `localhost` because `.wslconfig` sets
`networkingMode=mirrored`. If LHM is down the columns are **empty, never zero** - an empty cell
means "unmeasured", and `bracket.mjs` treats a run with no temperatures as failed, not as passing.

Start LHM if `curl -s localhost:8085/data.json` is empty:

```
schtasks.exe /run /tn LibreHardwareMonitor     # runs elevated, at-logon task, already installed
```

### Exact sensor paths (LHM 0.9.6, i7-13700K + RTX 4080, host `ADV-DT01`)

The JSON tree is version- and machine-specific, so the sampler matches on **sensor type + name**
instead of a fixed path, and `node tools/perf/sample.mjs --map` prints what resolved:

```
pkg_c         <- /Sensor/ADV-DT01/13thGenIntelCorei7-13700K/Temperatures/CPUPackage
pkg_w         <- /Sensor/ADV-DT01/13thGenIntelCorei7-13700K/Powers/CPUPackage
core_max_c    <- max over /Sensor/ADV-DT01/13thGenIntelCorei7-13700K/Temperatures/{P,E}-Core#N
core_avg_c    <- mean over the same 16 sensors
pkg_clocks    <- /Sensor/ADV-DT01/13thGenIntelCorei7-13700K/Clocks/{P,E}-Core#N
gpu_c         <- /Sensor/ADV-DT01/NVIDIAGeForceRTX4080/Temperatures/GPUCore
gpu_hotspot_c <- /Sensor/ADV-DT01/NVIDIAGeForceRTX4080/Temperatures/GPUHotSpot
gpu_w         <- /Sensor/ADV-DT01/NVIDIAGeForceRTX4080/Powers/GPUPackage
gpu_load      <- /Sensor/ADV-DT01/NVIDIAGeForceRTX4080/Load/GPUCore
gpu_clk       <- /Sensor/ADV-DT01/NVIDIAGeForceRTX4080/Clocks/GPUCore
gpu_mem_clk   <- /Sensor/ADV-DT01/NVIDIAGeForceRTX4080/Clocks/GPUMemory
```

LHM's own `CPUPackage` (temperature) and `CPUPackage` (power) share a name, and `GPUCore` exists
as a temperature, a clock and a load - that is why the lookup is keyed on type **and** name.

## Where the data lives

`~/.local/state/shockbox-perf/` (override with `SHOCKBOX_PERF_DIR`):

- `YYYY-MM-DD.csv` - one file per day, rotated by date, files older than **14 days** pruned on
  every sampler start (`sample.mjs --prune-only --dry-run` shows what would go)
- `.state.json` - last `/proc` counters, so CPU% is a delta even across process restarts
- `marks/<label>.json` - bracket start marks

The CSVs are not committed; only `baseline.json` is.

## Two commands around any ShockBox test or deploy

```
node tools/perf/bracket.mjs deploy-x          # or: npm run perf:bracket -- deploy-x
#   ... do the thing ...
node tools/perf/bracket.mjs deploy-x end      # prints interval + delta vs baseline, guards temps
```

`end` prints mean/max package temp, max GPU temp, peak load, ShockBox CPU/RSS, and the delta
against `baseline.json`. It exits **1** if package temp exceeded **95 °C** or GPU exceeded
**85 °C** (a run that overheats is a failed run), and **2** if the interval has no temperature
data at all, so a dead LHM cannot look like a pass.

Daily driver commands:

```
node tools/perf/sample.mjs --dry-run          # one row to stdout, writes nothing
node tools/perf/sample.mjs --map              # which LHM path feeds which column
node tools/perf/baseline.mjs                  # re-take the 5-minute baseline (perf:base)
node tools/perf/baseline.mjs --minutes 2 --compare   # noise-floor delta vs baseline.json
```

## The always-on logger

`shockbox-perf-monitor.service` (systemd **user** unit, copy lives in this directory):

```
cp tools/perf/shockbox-perf-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now shockbox-perf-monitor.service
systemctl --user status shockbox-perf-monitor.service
journalctl --user -u shockbox-perf-monitor.service -n 20
```

`Restart=always`, so it survives a crash; `Nice=19`, `CPUWeight=10`, `IOSchedulingClass=idle`
and `MemoryMax=128M` keep it invisible. It is deliberately the only always-on load this tooling
adds besides LHM itself: a ShockBox test must see the rig, not the observer. Type is `simple`
rather than `oneshot` because systemd refuses `Restart=always` on `Type=oneshot`.

## Thresholds

| sensor | limit | action |
|---|---|---|
| CPU package temp | 95 °C | bracket exits 1, run failed |
| GPU temp | 85 °C | bracket exits 1, run failed |
| no temperature data | - | bracket exits 2, run unverified |

## Baseline and noise floor

`node tools/perf/baseline.mjs` reads the **last 5 minutes of rows the monitor already wrote** -
it adds no load of its own. The result is `baseline.json` here: counts, mean/min/max/p95 for
package temp, core avg/max, GPU temp, GPU load, load1 and the ShockBox node/supervisor CPU and
RSS, plus host, kernel, `nproc` and the LHM version so a later run can be told apart.

Baseline `2026-11-03T08:01:33Z`, 5-minute window, 59/60 rows, `ADV-DT01`,
kernel `6.6.114.1-microsoft-standard-WSL2`, `nproc=12`, LHM `0.9.6.0`:

| metric | mean | min | max | p95 |
|---|---|---|---|---|
| pkg_c (°C) | 70.17 | 64 | 85 | 79 |
| core_avg_c (°C) | 64.55 | 59.1 | 72.1 | 71.8 |
| core_max_c (°C) | 71.61 | 64 | 82 | 78 |
| gpu_c (°C) | 29.83 | 29 | 43 | 32 |
| gpu_load (%) | 28.95 | 10 | 94 | 54 |
| load1 | 0.82 | 0.41 | 1.6 | 1.35 |
| sb_node_cpu / rss | empty (n=0) | - | - | - |
| sb_sup_cpu / rss | empty (n=0) | - | - | - |

The ShockBox columns are **empty, not zero**: ShockBox was not running during the baseline
(nothing listening on 8972, `~/.local/state/shockbox/supervisor.pid` stale from 2026-10-30).
Re-run `perf:base` with the rig actually running to get a process baseline.

**Noise floor** (second 2-minute window, 24 rows, taken immediately after the baseline):

| metric | 5-min mean | 2-min mean | delta | 5-min p95 | 2-min p95 |
|---|---|---|---|---|---|
| pkg_c | 70.17 | 67.21 | **-2.96 °C** | 79 | 73 |
| core_avg_c | 64.55 | 60.33 | **-4.22 °C** | 71.8 | 64.6 |
| core_max_c | 71.61 | 69.54 | **-2.07 °C** | 78 | 77 |
| gpu_c | 29.83 | 30.08 | **+0.25 °C** | 32 | 31 |
| gpu_load | 28.95 | 17.33 | **-11.62 %** | 54 | 40 |
| load1 | 0.82 | 0.24 | **-0.58** | 1.35 | 0.49 |

So on this box, two back-to-back quiet-ish windows differ by up to ~3 °C on package temp,
~4 °C on core average, and ~12 percentage points of GPU load. Treat anything inside
**±4 °C CPU / ±1 °C GPU / ±0.6 load1 / ±12 % GPU load** as noise, not as a regression.

That interval is wide because a pytest run from a parallel session (2-6 `pytest` processes) was
active during both windows; it was recorded, not excluded, so the number is honest but
pessimistic. A baseline taken with the box quiet and the rig idle will be tighter - take it
again rather than trusting this one forever.

Anything inside the noise floor is **not** a regression. Compare like with like: this box runs
OBS, Stream Deck and other Windows software, so a baseline taken while OBS is streaming is a
different baseline from one taken idle.

## Cost of the observer

Measured on this host: `node tools/perf/sample.mjs --duration 60` used **0.140 s of CPU over
60.2 s wall = 0.233 % of one core** (0.02 % of the 12-thread box). The installed
`shockbox-perf-monitor.service` showed **0.92 s CPU over ~9 minutes of running** (~0.17 % of one
core), consistent with the foreground measurement. Cadence over 245 rows: median gap **5 s**,
min 3 s, max 6 s, **zero** gaps over 10 s.

In price terms: one sample costs about one 97 KB JSON fetch plus a few `/proc` reads every
5 seconds. It is not a load source.

A browser under SwiftShader costs roughly **one core** on its own - that is orders of magnitude
more than this sampler, so look there first when a ShockBox run is hot. The sampler is
deliberately the only always-on load this tooling adds; anything else that runs continuously has
to justify itself against these numbers.
