#!/usr/bin/env node
// Baseline + noise floor. Reads the rows the always-on monitor already wrote, so it
// adds no load of its own.
//
//   node tools/perf/baseline.mjs                    5-minute baseline -> tools/perf/baseline.json
//   node tools/perf/baseline.mjs --minutes 2 --compare
//                                                   2-minute baseline, delta vs baseline.json,
//                                                   delta recorded there as the noise floor
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname, cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { METRICS, metricStats, rowsBetween, readAllRows, fmt } from "./stats.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const outfile = opt("--out", fileURLToPath(new URL("./baseline.json", import.meta.url)));
const minutes = Number(opt("--minutes", "5"));
const compare = args.includes("--compare");

function lhmVersion() {
  if (process.env.SHOCKBOX_LHM_VERSION) return process.env.SHOCKBOX_LHM_VERSION;
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-Command",
      "(Get-Item 'C:\\Apps and Programs\\Utility\\LibreHardwareMonitor\\LibreHardwareMonitor.exe').VersionInfo.FileVersion",
    ], { encoding: "utf8", timeout: 15000 }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const now = Date.now();
const rows = rowsBetween(readAllRows(), now - minutes * 60000, now);
const metrics = metricStats(rows);

if (compare) {
  const base = JSON.parse(readFileSync(outfile, "utf8"));
  console.log(`noise floor: ${minutes} min window (${rows.length} rows) vs baseline ${base.captured_at}`);
  console.log("metric          base_mean  this_mean   delta   base_p95  this_p95");
  const deltas = {};
  for (const m of METRICS) {
    const a = base.metrics[m], b = metrics[m];
    if (!a || !b || a.n === 0 || b.n === 0) {
      console.log(`${m.padEnd(15)} ${fmt(a?.mean).padStart(9)} ${fmt(b?.mean).padStart(10)}   (no data)`);
      continue;
    }
    const d = Math.round((b.mean - a.mean) * 100) / 100;
    deltas[m] = { mean_delta: d, p95_delta: Math.round((b.p95 - a.p95) * 100) / 100 };
    console.log(
      `${m.padEnd(15)} ${fmt(a.mean).padStart(9)} ${fmt(b.mean).padStart(10)} ${(d > 0 ? "+" : "") + d}`.padEnd(48) +
      `${fmt(a.p95).padStart(9)} ${fmt(b.p95).padStart(9)}`,
    );
  }
  base.noise = { window_minutes: minutes, rows: rows.length, measured_at: new Date(now).toISOString(), deltas };
  writeFileSync(outfile, JSON.stringify(base, null, 2) + "\n");
  console.log(`\nrecorded as noise in ${outfile}`);
  process.exit(0);
}

const doc = {
  captured_at: new Date(now).toISOString(),
  window_minutes: minutes,
  rows: rows.length,
  expected_rows: Math.round((minutes * 60) / 5),
  host: hostname(),
  kernel: process.env.SHOCKBOX_KERNEL || readKernel(),
  nproc: cpus().length,
  lhm_version: lhmVersion(),
  lhm_url: process.env.SHOCKBOX_LHM_URL || "http://localhost:8085/data.json",
  source: "tools/perf/baseline.mjs (reads ~/.local/state/shockbox-perf/*.csv)",
  metrics,
  noise: null,
};
writeFileSync(outfile, JSON.stringify(doc, null, 2) + "\n");

console.log(`baseline ${doc.window_minutes} min, ${doc.rows}/${doc.expected_rows} rows, ${doc.host} ${doc.kernel} nproc=${doc.nproc} lhm=${doc.lhm_version}`);
console.log("metric              mean      min      max      p95     n");
for (const m of METRICS) {
  const s = metrics[m];
  console.log(`${m.padEnd(16)} ${fmt(s.mean).padStart(8)} ${fmt(s.min).padStart(8)} ${fmt(s.max).padStart(8)} ${fmt(s.p95).padStart(8)} ${String(s.n).padStart(4)}`);
}
console.log(`\nwrote ${outfile}`);

function readKernel() {
  try {
    return execFileSync("uname", ["-r"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
