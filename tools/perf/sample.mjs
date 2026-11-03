#!/usr/bin/env node
// ShockBox perf sampler: one CSV row every 5 s, rotated daily, pruned after 14 days.
//
// Primary source  : LibreHardwareMonitor web server (http://localhost:8085/data.json).
//                   LHM runs on the Windows host; this WSL trusts `localhost` because
//                   .wslconfig sets networkingMode=mirrored.
// Fallback        : /proc (loadavg, cpu, meminfo, per-pid stat) so a row is still
//                   written, with LHM columns empty, when LHM is down.
//
// Missing sensor => empty field. Never a fake zero.
//
// Usage:
//   node tools/perf/sample.mjs                 one row, then exit
//   node tools/perf/sample.mjs --watch         forever, one row per 5 s
//   node tools/perf/sample.mjs --duration 60   rows for 60 s, then print own CPU cost
//   node tools/perf/sample.mjs --dry-run       print the row, write nothing
//   node tools/perf/sample.mjs --map           print which JSON path fed which column
//   node tools/perf/sample.mjs --prune-only    run retention, then exit

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.SHOCKBOX_PERF_DIR || join(homedir(), ".local/state/shockbox-perf");
const LHM_URL = process.env.SHOCKBOX_LHM_URL || "http://localhost:8085/data.json";
const INTERVAL_MS = 5000;
const RETENTION_DAYS = 14;
const SHOCKBOX_PORT = 8972;
const CLK_TCK = 100; // Linux x86_64 USER_HZ; change if /proc/stat ever disagrees

// The shipping rig runs on the Windows host, so its pids are invisible to WSL /proc.
// Windows side of the runtime dir (Paths.resolve: %LOCALAPPDATA%\ShockBox\runtime).
const WIN_RUNTIME = process.env.SHOCKBOX_WIN_RUNTIME
  || `/mnt/c/Users/${userInfo().username}/AppData/Local/ShockBox/runtime`;
const WIN_STATUS = join(WIN_RUNTIME, "status.json");
const WIN_PROBE = process.env.SHOCKBOX_WIN_PROBE !== "0" && existsSync(WIN_RUNTIME);

const COLUMNS = [
  "ts", "load1", "load5", "cpu_user", "cpu_sys", "cpu_idle",
  "pkg_c", "core_max_c", "core_avg_c", "pkg_w",
  "gpu_c", "gpu_hotspot_c", "gpu_w", "gpu_load", "gpu_clk", "gpu_mem_clk",
  "mem_avail_mb", "cached_mb",
  "sb_node_cpu", "sb_node_rss_mb", "sb_sup_cpu", "sb_sup_rss_mb",
];

// Column -> LHM sensor, looked up by (Type, Text-without-spaces). The tree shape is
// version-specific, so we match on sensor type+name rather than a fixed node path.
const SENSORS = {
  pkg_c: ["Temperature", "CPUPackage"],
  pkg_w: ["Power", "CPUPackage"],
  gpu_c: ["Temperature", "GPUCore"],
  gpu_hotspot_c: ["Temperature", "GPUHotSpot"],
  gpu_w: ["Power", "GPUPackage"],
  gpu_load: ["Load", "GPUCore"],
  gpu_clk: ["Clock", "GPUCore"],
  gpu_mem_clk: ["Clock", "GPUMemory"],
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

// ---------------------------------------------------------------- file plumbing

function dayString(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Delete day files whose name-date is older than RETENTION_DAYS. Pure filename
// arithmetic, so it is testable without waiting two weeks.
function prune({ dryRun = false } = {}) {
  if (!existsSync(STATE_DIR)) return [];
  const today = new Date(dayString() + "T00:00:00");
  const doomed = [];
  for (const name of readdirSync(STATE_DIR)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.csv$/.exec(name);
    if (!m) continue;
    const ageDays = Math.round((today - new Date(m[1] + "T00:00:00")) / 86400000);
    if (ageDays > RETENTION_DAYS) {
      doomed.push({ file: join(STATE_DIR, name), ageDays });
      if (!dryRun) unlinkSync(join(STATE_DIR, name));
    }
  }
  return doomed;
}

function appendRow(row) {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = join(STATE_DIR, `${dayString()}.csv`);
  const head = existsSync(file) && readFileSync(file, "utf8").length > 0
    ? ""
    : COLUMNS.join(",") + "\n";
  appendFileSync(file, head + COLUMNS.map((c) => row[c] ?? "").join(",") + "\n");
  return file;
}

const STATE_FILE = join(STATE_DIR, ".state.json");

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s));
}

// ---------------------------------------------------------------- LHM source

function flatten(node, path, out) {
  const name = String(node.Text ?? "").replace(/ /g, "");
  const here = `${path}/${name}`;
  const kids = node.Children ?? [];
  if (kids.length) {
    for (const k of kids) flatten(k, here, out);
    return out;
  }
  if (node.Type) out.push({ type: node.Type, name, path: here, raw: node.Value });
  return out;
}

function num(raw) {
  if (raw == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(raw));
  return m ? Number(m[0]) : null;
}

async function readLhm() {
  try {
    const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tree = await res.json();
    const leaves = flatten(tree, "", []);
    return { leaves, error: null };
  } catch (err) {
    return { leaves: [], error: err.message };
  }
}

function pick(leaves, type, name) {
  return leaves.find((l) => l.type === type && l.name === name) ?? null;
}

// Per-core temps and clocks are the only plural sensors we need.
function perCore(leaves, type) {
  return leaves.filter((l) => l.type === type && /^(P|E)-Core#\d+$/.test(l.name));
}

function lhmValues(leaves) {
  const v = {};
  for (const [col, [type, name]] of Object.entries(SENSORS)) {
    const s = pick(leaves, type, name);
    v[col] = s ? num(s.raw) : null;
  }
  const cores = perCore(leaves, "Temperature")
    .map((s) => num(s.raw))
    .filter((n) => n != null);
  v.core_max_c = cores.length ? Math.max(...cores) : null;
  v.core_avg_c = cores.length ? Math.round((cores.reduce((a, b) => a + b, 0) / cores.length) * 10) / 10 : null;
  v._core_clocks = perCore(leaves, "Clock").map((s) => ({ path: s.path, mhz: num(s.raw) }));
  return v;
}

// ---------------------------------------------------------------- /proc sources

function readMeminfo() {
  const txt = readFileSync("/proc/meminfo", "utf8");
  const grab = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB`, "m").exec(txt);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  };
  return { mem_avail_mb: grab("MemAvailable"), cached_mb: grab("Cached") };
}

function readCpuTicks() {
  const f = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq] = f;
  return {
    user: user + nice,
    sys: system + irq + softirq,
    idle: idle + iowait,
    total: f.reduce((a, b) => a + b, 0),
  };
}

function cpuPercents(now, prev) {
  if (!prev) return { cpu_user: null, cpu_sys: null, cpu_idle: null };
  const dTotal = now.total - prev.total;
  if (dTotal <= 0) return { cpu_user: null, cpu_sys: null, cpu_idle: null };
  const pct = (key) => Math.round(((now[key] - prev[key]) / dTotal) * 1000) / 10;
  return {
    cpu_user: pct("user"),
    cpu_sys: pct("sys"),
    cpu_idle: pct("idle"),
  };
}

function readLoadavg() {
  const [l1, l5] = readFileSync("/proc/loadavg", "utf8").split(/\s+/);
  return { load1: Number(l1), load5: Number(l5) };
}

// --- process discovery -------------------------------------------------------

function pidOnPort(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let txt;
    try { txt = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of txt.split("\n").slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      const local = p[1].split(":");
      if (local[1] !== hex) continue;
      if (p[3] !== "0A") continue; // LISTEN
      const inode = p[9];
      const pid = pidFromSocket(inode);
      if (pid) return pid;
    }
  }
  return null;
}

function pidFromSocket(inode) {
  let pids;
  try { pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return null; }
  for (const pid of pids) {
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (readFileSync(`/proc/${pid}/fd/${fd}`, "utf8").trim() === `socket:[${inode}]`) return Number(pid);
      } catch { /* fd closed mid-scan */ }
    }
  }
  return null;
}

// The supervisor is the Python `shockbox_tui.supervisor` for THIS rig. Trust only the
// pid file: a cmdline scan also matches supervisors spawned by the pytest suite in
// /tmp/pytest-of-*/..., which would fabricate rows with someone else's RSS.
function supervisorPid() {
  const pidFile = join(homedir(), ".local/state/shockbox/supervisor.pid");
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!pid) return null;
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!cmd.includes("shockbox_tui")) return null; // stale pid reused by another process
    return pid;
  } catch {
    return null;
  }
}

// --- Windows rig (the shipping layout) ---------------------------------------
//
// One long-lived powershell, not one per row: a powershell start costs ~1.6 s of wall
// time, which would make the observer a load source. It re-reads status.json itself, so
// a supervisor restart or a new node pid is picked up without us respawning anything.
// Line format: pid|cpuSeconds|rssBytes|epochMs

const win = { child: null, buf: "", samples: new Map(), prev: new Map() };

function winStatus() {
  if (!WIN_PROBE) return null;
  try {
    const st = JSON.parse(readFileSync(WIN_STATUS, "utf8"));
    const ageS = (Date.now() - Date.parse(st.updated ?? 0)) / 1000;
    if (!(st.pid > 0) || !(ageS < 60)) return null; // gone, or stale heartbeat
    return st;
  } catch {
    return null;
  }
}

function winPath(wslPath) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(wslPath);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : wslPath;
}

function powershellExe() {
  // systemd --user has no /mnt/c in PATH, and interop puts powershell.exe there, not in
  // /usr/bin. Resolve an absolute path or give up (columns stay empty rather than lying).
  const candidates = [
    process.env.SHOCKBOX_POWERSHELL,
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function startWinProbe() {
  if (!WIN_PROBE || win.child) return;
  const exe = powershellExe();
  if (!exe) {
    if (!win.warned) {
      console.error("winprobe: no powershell.exe found - sb_node/sb_sup columns will stay empty");
      win.warned = true;
    }
    return;
  }
  const status = winPath(WIN_STATUS).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$rt='${status}'`,
    "while($true){",
    "  if(Test-Path $rt){",
    "    $s=Get-Content $rt -Raw | ConvertFrom-Json",
    "    foreach($id in @($s.node_pid,$s.supervisor_pid)){",
    "      if($id -gt 0){",
    "        $p=Get-Process -Id $id",
    "        if($p){'{0}|{1}|{2}|{3}' -f $id,[double]$p.TotalProcessorTime.TotalSeconds,[int64]$p.WorkingSet64,[int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}",
    "      }",
    "    }",
    "  }",
    "  Start-Sleep -Milliseconds 2500",
    "}",
  ].join(";");

  try {
    win.child = spawn(exe, ["-NoProfile", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    win.child = null;
    return;
  }
  win.child.on("error", (err) => {
    win.child = null;
    if (!win.warned) {
      console.error(`winprobe: ${err.message}`);
      win.warned = true;
    }
  });
  win.child.on("exit", () => { win.child = null; });
  win.child.stdout.setEncoding("utf8");
  win.child.stdout.on("data", (chunk) => {
    win.buf += chunk;
    let nl;
    while ((nl = win.buf.indexOf("\n")) >= 0) {
      const line = win.buf.slice(0, nl).trim();
      win.buf = win.buf.slice(nl + 1);
      const [pid, cpu, rss, at] = line.split("|");
      if (!pid || cpu === undefined) continue;
      win.samples.set(Number(pid), { cpu: Number(cpu), rss: Number(rss), at: Number(at) });
    }
  });
  process.on("exit", () => { try { win.child?.kill(); } catch { /* already gone */ } });
}

// CPU% is percent of one core, same scale as the /proc columns.
function winCost(pid) {
  const s = pid ? win.samples.get(pid) : null;
  if (!s) return { cpu: null, rss: null };
  const prev = win.prev.get(pid);
  win.prev.set(pid, s);
  const dt = prev ? (s.at - prev.at) / 1000 : 0;
  const cpu = prev && dt > 0 ? Math.round(((s.cpu - prev.cpu) / dt) * 1000) / 10 : null;
  return { cpu, rss: Math.round((s.rss / 1024 / 1024) * 10) / 10 };
}

// --- /proc/<pid>/stat --------------------------------------------------------

let PAGE_SIZE = 4096;
function initPageSize() {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const rssPages = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[21]);
    const kb = /VmRSS:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"));
    if (kb && rssPages > 0) PAGE_SIZE = (Number(kb[1]) * 1024) / rssPages;
  } catch { /* keep the default */ }
}

function readProcStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    return { ticks: Number(f[11]) + Number(f[12]), rss_mb: Math.round((Number(f[21]) * PAGE_SIZE) / 1024 / 1024 * 10) / 10 };
  } catch {
    return null;
  }
}

function procUsage(pid, key, prev, prevTs, nowTs) {
  // CPU% is percent of ONE core, like top.
  if (!pid) return { cpu: null, rss: null };
  const cur = readProcStat(pid);
  if (!cur) return { cpu: null, rss: null };
  const p = prev?.[key];
  const dt = (nowTs - prevTs) / 1000;
  const cpu = p && dt > 0
    ? Math.round(((cur.ticks - p.ticks) / CLK_TCK / dt) * 1000) / 10
    : null;
  return { cpu, rss: cur.rss_mb, tick: cur.ticks };
}

// ---------------------------------------------------------------- one sample

async function sample(prevState) {
  const now = new Date();
  const ts = now.getTime();
  const mem = readMeminfo();
  const cpu = readCpuTicks();
  const prevCpu = prevState.cpu;

  const lhm = await readLhm();
  const lv = lhmValues(lhm.leaves);

  const nodePid = pidOnPort(SHOCKBOX_PORT);
  const supPid = supervisorPid();

  // Prefer the Windows rig: that is where ShockBox actually ships and runs. /proc is the
  // fallback for a dev/TUI run inside WSL.
  const wst = winStatus();
  let node, sup;
  if (wst) {
    node = winCost(wst.node_pid);
    sup = winCost(wst.supervisor_pid);
  } else {
    node = procUsage(nodePid, `pid:${nodePid ?? "none"}`, prevState.procs, prevState.ts ?? ts, ts);
    sup = procUsage(supPid, `pid:${supPid ?? "none"}`, prevState.procs, prevState.ts ?? ts, ts);
  }

  const row = {
    ts: now.toISOString().replace(/\.\d+Z$/, "Z"),
    ...readLoadavg(),
    ...cpuPercents(cpu, prevCpu),
    pkg_c: lv.pkg_c, core_max_c: lv.core_max_c, core_avg_c: lv.core_avg_c, pkg_w: lv.pkg_w,
    gpu_c: lv.gpu_c, gpu_hotspot_c: lv.gpu_hotspot_c, gpu_w: lv.gpu_w,
    gpu_load: lv.gpu_load, gpu_clk: lv.gpu_clk, gpu_mem_clk: lv.gpu_mem_clk,
    mem_avail_mb: mem.mem_avail_mb, cached_mb: mem.cached_mb,
    sb_node_cpu: node.cpu, sb_node_rss_mb: node.rss,
    sb_sup_cpu: sup.cpu, sb_sup_rss_mb: sup.rss,
  };

  const nextState = {
    ts,
    cpu,
    procs: {},
    pids: { node: nodePid, supervisor: supPid },
  };
  if (nodePid && node.tick != null) nextState.procs[`pid:${nodePid}`] = { ticks: node.tick };
  if (supPid && sup.tick != null) nextState.procs[`pid:${supPid}`] = { ticks: sup.tick };

  return { row, nextState, lhmError: lhm.error, lv, leaves: lhm.leaves };
}

// ---------------------------------------------------------------- CLI modes

function printMap(leaves, lv) {
  if (!leaves.length) {
    console.log("LHM unreachable (" + LHM_URL + ") - no sensor map available.");
    return;
  }
  const rows = Object.entries(SENSORS).map(([col, [type, name]]) => {
    const s = pick(leaves, type, name);
    return [col, s ? s.path : "(missing)", s ? s.raw : ""];
  });
  const coreTemp = perCore(leaves, "Temperature");
  const coreClk = perCore(leaves, "Clock");
  rows.push(["core_max_c", coreTemp.length ? coreTemp.map((s) => s.path).join(" ") : "(missing)", ""]);
  rows.push(["core_avg_c", "<<same set, mean>>", ""]);
  rows.push(["pkg_clocks", coreClk.map((s) => s.path).join(" ") || "(missing)", ""]);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [col, path, raw] of rows) console.log(col.padEnd(w) + "  <- " + path + (raw ? `   [${raw}]` : ""));
}

async function main() {
  initPageSize();
  startWinProbe();
  const state = loadState();

  if (flag("--prune-only")) {
    const done = prune({ dryRun: flag("--dry-run") });
    console.log(done.length ? done.map((d) => `pruned ${d.file} (${d.ageDays}d)`).join("\n") : "nothing to prune");
    return 0;
  }

  const first = await sample(state);
  if (flag("--map")) {
    printMap(first.leaves, first.lv);
    return 0;
  }

  if (flag("--dry-run")) {
    const doomed = prune({ dryRun: true });
    console.log("dir   : " + STATE_DIR);
    console.log("file  : " + join(STATE_DIR, `${dayString()}.csv`));
    console.log("prune : " + (doomed.length ? doomed.map((d) => d.file).join(", ") : "none"));
    console.log(COLUMNS.map((c) => first.row[c] ?? "").join(","));
    return 0;
  }

  // First write also applies retention, so a long-lived monitor keeps the dir bounded.
  const pruned = prune();
  if (pruned.length) console.log(`pruned ${pruned.length} file(s) older than ${RETENTION_DAYS}d`);

  const selfStart = readProcStat("self");
  const t0 = Date.now();
  let file = appendRow(first.row);
  let lastErr = first.lhmError;
  if (lastErr) console.error(`lhm: ${lastErr} - temperature columns empty`);
  saveState(first.nextState); // so the next tick computes a 5 s delta, not a 10 s one

  if (!flag("--watch") && !opt("--duration")) {
    console.log(file);
    return 0;
  }

  const durationS = Number(opt("--duration", 0));
  const until = durationS > 0 ? t0 + durationS * 1000 : Infinity;

  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const s = await sample(loadState());
    file = appendRow(s.row);
    if (s.lhmError !== lastErr) {
      console.error(s.lhmError ? `lhm: ${s.lhmError} - temperature columns empty` : "lhm: back");
      lastErr = s.lhmError;
    }
    saveState(s.nextState);
  }

  const selfEnd = readProcStat("self");
  const wall = (Date.now() - t0) / 1000;
  const cpuS = (selfEnd.ticks - selfStart.ticks) / CLK_TCK;
  console.log(`self: ${cpuS.toFixed(3)}s cpu over ${wall.toFixed(1)}s wall = ${((cpuS / wall) * 100).toFixed(3)}% of one core`);
  console.log(file);
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error(err);
  process.exit(1);
});
