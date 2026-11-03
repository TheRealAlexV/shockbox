// Shared CSV reading + statistics for the perf tools. No deps, no opinions.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.SHOCKBOX_PERF_DIR || join(homedir(), ".local/state/shockbox-perf");

export function readAllRows(dir = STATE_DIR) {
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(n)).sort()) {
    const lines = readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean);
    if (!lines.length) continue;
    const head = lines.shift().split(",");
    for (const line of lines) {
      const cells = line.split(",");
      const row = {};
      head.forEach((k, i) => { row[k] = cells[i] ?? ""; });
      rows.push(row);
    }
  }
  return rows;
}

export function rowsBetween(rows, fromMs, toMs) {
  return rows.filter((r) => {
    const t = Date.parse(r.ts);
    return t >= fromMs && t <= toMs;
  });
}

export function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function stats(values) {
  const v = values.filter((n) => n != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0, mean: null, min: null, max: null, p95: null };
  const sum = v.reduce((a, b) => a + b, 0);
  const round = (x) => Math.round(x * 100) / 100;
  return {
    n: v.length,
    mean: round(sum / v.length),
    min: v[0],
    max: v[v.length - 1],
    p95: v[Math.max(0, Math.ceil(0.95 * v.length) - 1)],
  };
}

export const METRICS = [
  "pkg_c", "core_avg_c", "core_max_c", "gpu_c", "gpu_load", "load1",
  "sb_node_cpu", "sb_node_rss_mb", "sb_sup_cpu", "sb_sup_rss_mb",
];

export function metricStats(rows) {
  const out = {};
  for (const m of METRICS) out[m] = stats(rows.map((r) => num(r[m])));
  return out;
}

export const fmt = (v, unit = "") => (v == null ? "-" : `${v}${unit}`);
