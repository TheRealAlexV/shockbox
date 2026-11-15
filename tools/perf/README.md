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

`sb_node_*` is whatever process owns TCP port 8972; `sb_sup_*` is the `shockbox_tui` supervisor.
Both are empty when ShockBox is not running. Process CPU% is percent of **one** core, like `top`.

### Which side the rig runs on (and the two runtime dirs)

The shipping rig runs on the **Windows host** (`C:\OBS\ShockBox`), so its pids do not exist in
WSL `/proc`. The sampler therefore resolves them from the Windows runtime dir first:

```
%PROGRAMDATA%\ShockBox\runtime\status.json   -> node_pid, supervisor_pid, updated, adopted
C:\ProgramData\ShockBox\runtime\supervisor.pid
```

`status.json` is re-read every row (so a supervisor restart or a new node pid is picked up with
no hardcoded number), and a single long-lived `powershell.exe` reports each pid's
`TotalProcessorTime` and `WorkingSet64` every 2.5 s. One powershell per row would cost ~1.6 s of
wall time each, which is why it is one process and not a spawn per sample. CPU% is a delta
between reports, so the first row after a restart has RSS but no CPU%.

If Windows is not reachable, the sampler falls back to WSL `/proc`: the pid listening on 8972 and
the pid in `~/.local/state/shockbox/supervisor.pid` (verified against its cmdline).

**Known wart, worth a follow-up:** there are two runtime dirs, and only the Windows one is live.

| path | contents now | writer |
|---|---|---|
| `%PROGRAMDATA%\ShockBox\runtime\` | the one machine-wide dir: `supervisor.pid`, `status.json`, heartbeat | the Windows supervisor |
| `~/.local/state/shockbox/` (WSL) | `supervisor.pid` = **168254**, dead since 2026-10-30 | an old WSL run; nothing reaps it |

`%LOCALAPPDATA%\ShockBox\runtime` was a second Windows dir, retired to `runtime.orphan-20261106`
on 2026-11-06: its frozen `status.json` read `stopped` while the supervisor ran, and a sampler
that preferred it reported a live supervisor as dead.

A detector that trusts the WSL pid file without checking the process would report a supervisor
that does not exist. This sampler checks, so it reports empty rather than a stale number - but
the stale file itself is a trap for the next tool, and `paths.py` documents only the
OS-appropriate dir with no cleanup of the other.

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

Baseline `2026-11-03T08:10:27Z`, 5-minute window, **60/60 rows**, rig up (Windows node 33684 on
8972 + supervisor 33276, `adopted: true`), `ADV-DT01`, kernel
`6.6.114.1-microsoft-standard-WSL2`, `nproc=12`, LHM `0.9.6.0`:

| metric | mean | min | max | p95 | n |
|---|---|---|---|---|---|
| pkg_c (°C) | 66.33 | 55 | 78 | 72 | 60 |
| core_avg_c (°C) | 60.53 | 52.7 | 69 | 65.8 | 60 |
| core_max_c (°C) | 67.73 | 58 | 84 | 76 | 60 |
| gpu_c (°C) | 30.68 | 30 | 49 | 31 | 60 |
| gpu_load (%) | 25.8 | 0 | 95 | 43 | 60 |
| load1 | 0.58 | 0.23 | 0.92 | 0.85 | 60 |
| sb_node_cpu (% of 1 core) | 0.64 | 0 | 1.8 | 1.5 | 33 |
| sb_node_rss_mb | 46.29 | 46.2 | 46.8 | 46.8 | 34 |
| sb_sup_cpu (% of 1 core) | 2.09 | 1.2 | 3.1 | 3.1 | 33 |
| sb_sup_rss_mb | 32 | 32 | 32 | 32 | 34 |

**Does ShockBox cost anything while idle?** Node: **0.64 % of one core, 46.3 MB**. Supervisor:
**2.09 % of one core, 32.0 MB**. Together ~2.7 % of one core, ~78 MB, i.e. ~0.23 % of the
12-thread box. Since-start averages agree (node 26.4 s CPU over ~66 min on Windows = 0.67 %;
supervisor 29.9 s over ~36 min = 1.38 %).

`n=33/34` for the process columns is honest: the Windows probe went live at 08:07:43, 27 rows
into that window, so the first rows have no process data. Every row after that does. An earlier
baseline taken with the rig **down** is kept under `previous` in `baseline.json` - do not mistake
its empty process columns for zeros.

**Noise floor** (second 2-minute window, 23 rows, taken immediately after the baseline):

| metric | 5-min mean | 2-min mean | delta | 5-min p95 | 2-min p95 |
|---|---|---|---|---|---|
| pkg_c | 66.33 | 64.83 | **-1.50 °C** | 72 | 71 |
| core_avg_c | 60.53 | 58.72 | **-1.81 °C** | 65.8 | 67.5 |
| core_max_c | 67.73 | 67.39 | **-0.34 °C** | 76 | 78 |
| gpu_c | 30.68 | 30.35 | **-0.33 °C** | 31 | 31 |
| gpu_load | 25.8 | 15.83 | **-9.97 %** | 43 | 28 |
| load1 | 0.58 | 0.75 | **+0.17** | 0.85 | 0.91 |
| sb_node_cpu | 0.64 | 0.67 | **+0.03 %** | 1.5 | 1.5 |
| sb_node_rss_mb | 46.29 | 46.43 | **+0.14 MB** | 46.8 | 46.8 |
| sb_sup_cpu | 2.09 | 1.97 | **-0.12 %** | 3.1 | 2.8 |
| sb_sup_rss_mb | 32 | 32 | **0** | 32 | 32 |

Resolution to quote: **±2 °C pkg / ±2 °C core avg / ±0.5 °C core max / ±0.5 °C GPU /
±10 % GPU load / ±0.2 load1 / ±0.2 % process CPU / ±0.2 MB RSS**. Anything inside that is noise,
not a regression.

Both windows contained the same background load: the user's browser (25 Brave processes), a
pytest suite from a parallel session (5-6 processes), and the agent stack (`bun` ~30 % and
`opencode` ~20 % of one core in WSL). That is this machine's real steady state, so the two
windows are **trusted as a like-for-like comparison** - that is what makes the floor valid. The
absolute temperatures are **not** a quiet-box figure: on an idle machine the same rig sits
lower. GPU load swings ±10 points on browser activity alone.

Anything inside the noise floor is **not** a regression. Compare like with like: this box runs
OBS, Stream Deck and other Windows software, so a baseline taken while OBS is streaming is a
different baseline from one taken idle.

## Cost of the observer

Measured on this host: `node tools/perf/sample.mjs --duration 60` used **0.140 s of CPU over
60.2 s wall = 0.233 % of one core** (0.02 % of the 12-thread box). With the Windows probe
running, the installed `shockbox-perf-monitor.service` cgroup (node **and** its powershell
child) used **1.04 s of CPU over 551 s = 0.19 % of one core**. Cadence over 393 rows: median
gap **5 s**, min 2 s, max 6 s, **zero** gaps over 10 s.

In price terms: one sample costs about one 97 KB JSON fetch, a few `/proc` reads every 5
seconds, and a 2.5 s powershell poll of two Windows processes. It is not a load source.

A browser under SwiftShader costs roughly **one core** on its own - that is orders of magnitude
more than this sampler, so look there first when a ShockBox run is hot. The sampler is
deliberately the only always-on load this tooling adds; anything else that runs continuously has
to justify itself against these numbers.
