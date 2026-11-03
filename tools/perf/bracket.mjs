#!/usr/bin/env node
// Bracket a ShockBox test/deploy and judge it against the baseline.
//
//   node tools/perf/bracket.mjs deploy-a            mark start
//   ... run the thing ...
//   node tools/perf/bracket.mjs deploy-a end        compare interval, guard thresholds
//
// Exit codes: 0 pass, 1 threshold exceeded, 2 no temperature data (unverifiable).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, METRICS, metricStats, num, rowsBetween, readAllRows, stats, fmt } from "./stats.mjs";

const MAX_PKG_C = 95;
const MAX_GPU_C = 85;
const MARKS = join(STATE_DIR, "marks");
const BASELINE = new URL("./baseline.json", import.meta.url);

const [label, phase] = process.argv.slice(2);
if (!label) {
  console.error("usage: bracket.mjs <label> [end]");
  process.exit(64);
}
const markFile = join(MARKS, `${label.replace(/[^\w.-]/g, "_")}.json`);

if (phase !== "end") {
  mkdirSync(MARKS, { recursive: true });
  writeFileSync(markFile, JSON.stringify({ label, start: new Date().toISOString() }, null, 2) + "\n");
  console.log(`bracket ${label}: start ${new Date().toISOString()}`);
  console.log(`run the work now, then: node tools/perf/bracket.mjs ${label} end`);
  process.exit(0);
}

if (!existsSync(markFile)) {
  console.error(`bracket ${label}: no start mark at ${markFile} - run "bracket.mjs ${label}" first`);
  process.exit(64);
}

const mark = JSON.parse(readFileSync(markFile, "utf8"));
const fromMs = Date.parse(mark.start);
const toMs = Date.now();
const rows = rowsBetween(readAllRows(), fromMs, toMs);
const metrics = metricStats(rows);
const minutes = ((toMs - fromMs) / 60000).toFixed(1);

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
const bmean = (m) => baseline?.metrics?.[m]?.mean ?? null;

const delta = (m) => {
  const b = bmean(m), v = metrics[m]?.mean;
  if (b == null || v == null) return "-";
  const d = Math.round((v - b) * 100) / 100;
  return (d > 0 ? "+" : "") + d;
};

const pkgPeak = num(rows.reduce((best, r) => {
  const v = num(r.pkg_c);
  return v != null && (best == null || v > num(best.pkg_c)) ? r : best;
}, null)?.pkg_c);
const gpuPeak = stats(rows.map((r) => num(r.gpu_c))).max;

console.log(`bracket ${label}: ${mark.start} -> ${new Date(toMs).toISOString()} (${minutes} min, ${rows.length} rows)`);
console.log("                     this:mean    max   |  base:mean   delta");
const line = (name, m, maxKey = "max") =>
  console.log(`${name.padEnd(20)} ${fmt(metrics[m].mean).padStart(9)} ${fmt(metrics[m][maxKey]).padStart(7)}   | ${fmt(bmean(m)).padStart(9)} ${delta(m).padStart(8)}`);
line("pkg temp (C)", "pkg_c");
line("core avg (C)", "core_avg_c");
line("core max (C)", "core_max_c");
line("GPU temp (C)", "gpu_c");
line("GPU load (%)", "gpu_load");
line("load1", "load1");
line("node cpu (%1core)", "sb_node_cpu");
line("node rss (MB)", "sb_node_rss_mb");
line("sup cpu (%1core)", "sb_sup_cpu");
line("sup rss (MB)", "sb_sup_rss_mb");

const thermal = rows.some((r) => num(r.pkg_c) != null || num(r.gpu_c) != null);
if (!thermal) {
  console.error(`\nFAILED RUN: no temperature data in this interval - LHM was down, thresholds unverifiable.`);
  console.error(`start it with: schtasks.exe /run /tn LibreHardwareMonitor`);
  process.exit(2);
}
const pkgOver = pkgPeak != null && pkgPeak > MAX_PKG_C;
const gpuOver = gpuPeak != null && gpuPeak > MAX_GPU_C;
if (pkgOver || gpuOver) {
  console.error(`\n*** THRESHOLD EXCEEDED ***`);
  if (pkgOver) console.error(`  CPU package peaked at ${pkgPeak} C (limit ${MAX_PKG_C} C)`);
  if (gpuOver) console.error(`  GPU peaked at ${gpuPeak} C (limit ${MAX_GPU_C} C)`);
  console.error(`  this run is a FAILED run, not a footnote`);
  process.exit(1);
}
console.log(`\nOK: pkg peak ${fmt(pkgPeak, " C")}, GPU peak ${fmt(gpuPeak, " C")} (limits ${MAX_PKG_C} / ${MAX_GPU_C} C)`);
