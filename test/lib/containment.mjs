// Structural limits for the browser gates: one gate at a time, a hard CPU ceiling on the browser,
// a refusal to start on an already-hot host, and an orphan sweep on the way out.
//
// The wall gates mount /wall/render at 2560×1440 under SwiftShader: roughly one full core per
// browser, and every readPixels copies 14.7 MB. Instructions ("run the wall gates one after
// another") did not hold — a second gate started while the first was still hot and the host went
// into thermal throttling. So the launcher enforces it instead of asking:
//
//   · acquireGateLock()  — one exclusive lock file; a live holder makes the second gate fail fast
//   · assertHostIdle()   — /proc/loadavg 1-min above 0.7 × cpus refuses to start
//   · cpuController()    — systemd-run --user --scope CPUQuota, else cpulimit, else nice 19 + warning
//   · sweepOrphans()     — gui/sweep-orphans.sh, once, on the way out
//
// Node stdlib only. No new dependencies.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root (this file is test/lib/containment.mjs). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A gate is holding the browser; a second one must not start. */
export class GateBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateBusyError';
  }
}

/** The host is already loaded; starting another browser would stack on top of it. */
export class HostBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HostBusyError';
  }
}

function note(line) {
  console.log(`[containment] ${line}`);
}

// --- the single-run lock -----------------------------------------------------------------------
// One gate at a time, enforced by an exclusive lock file. `openSync(..., 'wx')` is the atomic part:
// it fails with EEXIST if anyone else got there first, so there is no check-then-create window.
// The file carries the owner's pid and gate name so the refusal can say who is running and how to
// clear a lock whose owner died.

const LOCK_NAME = 'shockbox-gate.lock';

/** Lock path: /tmp/opencode/… when it exists (the preferred tmpdir on this host), else os.tmpdir(). */
export function gateLockPath() {
  if (process.env.SHOCKBOX_GATE_LOCK) return process.env.SHOCKBOX_GATE_LOCK;
  const preferred = path.join('/tmp/opencode', LOCK_NAME);
  try {
    fs.accessSync(path.dirname(preferred), fs.constants.W_OK);
    return preferred;
  } catch {
    return path.join(os.tmpdir(), LOCK_NAME);
  }
}

/** The gate's name for the lock file: the script name, e.g. `wall-image-browser`. */
export function gateName() {
  const script = process.argv[1] ? path.basename(process.argv[1]).replace(/\.mjs$/, '') : '';
  return script || `pid-${process.pid}`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, just not ours to signal
  }
}

function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8').trim();
  } catch {
    return null; // vanished between openSync and here: treat as free
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed.pid)) return parsed;
  } catch {
    /* fall through to the bare-pid form */
  }
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) ? { pid, gate: 'unknown' } : null;
}

let HELD = null; // { path, pid, name, refs }
let hooksArmed = false;

function armLockHooks() {
  if (hooksArmed) return;
  hooksArmed = true;
  process.on('exit', () => releaseGateLock({ force: true }));
  // A default SIGINT/SIGTERM would not run 'exit' listeners, so each one releases explicitly and
  // then ends the process the way the shell expects. Any other handler in this process still runs
  // from the 'exit' listeners (the browser reaper lives there too).
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => {
      releaseGateLock({ force: true });
      process.exit(code);
    });
  }
}

/**
 * Take the exclusive browser lock, or refuse.
 *
 * Re-entrant within one process (a gate that launches twice is still one gate); a different live
 * pid is a hard failure. A lock whose owner is dead is removed and retaken.
 *
 * @param {object} [opts]
 * @param {string} [opts.name]      gate name recorded in the lock
 * @param {string} [opts.lockPath]  override the lock file (tests)
 * @returns {{path: string, pid: number, name: string, release: () => boolean}}
 */
export function acquireGateLock({ name = gateName(), lockPath = gateLockPath() } = {}) {
  if (HELD) {
    if (HELD.path === lockPath) {
      HELD.refs += 1;
      return { ...HELD, release: () => releaseGateLock() };
    }
    throw new GateBusyError(`this process already holds ${HELD.path}; one lock per gate process`);
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const body = JSON.stringify({ pid: process.pid, gate: name, started: new Date().toISOString() });
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      HELD = { path: lockPath, pid: process.pid, name, refs: 1 };
      armLockHooks();
      note(`lock acquired: ${lockPath} (gate "${name}", pid ${process.pid})`);
      return { ...HELD, release: () => releaseGateLock() };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const holder = readLock(lockPath);
    if (holder && pidAlive(holder.pid) && holder.pid !== process.pid) {
      throw new GateBusyError(
        [
          `another gate is already running: "${holder.gate}" (pid ${holder.pid}, since ${holder.started ?? 'unknown'})`,
          `lock: ${lockPath}`,
          'two wall gates at once is what overheats this host, so this one refuses to start.',
          `wait for pid ${holder.pid} to exit. If it is already gone, clear the stale lock with: rm -f ${lockPath}`,
        ].join('\n  '),
      );
    }
    // Dead owner (or an unreadable lock file): clear it and try the atomic take again.
    try {
      fs.unlinkSync(lockPath);
      note(
        holder
          ? `stale lock removed (owner ${holder.gate} pid ${holder.pid} is gone): ${lockPath}`
          : `unreadable lock removed: ${lockPath}`,
      );
    } catch {
      /* another process cleared it first: the next loop attempt will tell */
    }
  }
  throw new GateBusyError(`could not take ${lockPath} after 3 attempts; check for a racing gate`);
}

/**
 * Release the lock. Idempotent, and only removes a file that still names this process.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]  release even if a launch still holds a reference (exit path)
 */
export function releaseGateLock({ force = false } = {}) {
  if (!HELD) return false;
  if (!force) {
    HELD.refs -= 1;
    if (HELD.refs > 0) return false;
  }
  const { path: lockPath } = HELD;
  HELD = null;
  const holder = readLock(lockPath);
  if (holder && holder.pid !== process.pid) return false; // not ours any more
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** True when this process is holding the browser lock (read-only, for gates that want to assert). */
export function holdingGateLock() {
  return Boolean(HELD);
}

// --- load precondition -------------------------------------------------------------------------
// Starting a wall gate on a host that is already at 0.7 × cpus stacks SwiftShader on top of
// whatever is hot, which is the thermal path we are closing. Refuse, and say why.

/** The 1-minute load average, or null where there is no /proc/loadavg. */
export function hostLoad(loadPath = '/proc/loadavg') {
  try {
    const [one] = fs.readFileSync(loadPath, 'utf8').trim().split(/\s+/);
    const value = Number(one);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Throw HostBusyError when the host is too loaded to start a browser.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]     skip the check (SHOCKBOX_GATE_FORCE=1 also does)
 * @param {number} [opts.cpuCount]   override os.cpus().length
 * @param {string} [opts.loadPath]   override /proc/loadavg (tests)
 * @returns {{load: number|null, cpuCount: number, threshold: number, forced: boolean}}
 */
export function assertHostIdle({ force = process.env.SHOCKBOX_GATE_FORCE === '1', cpuCount = os.cpus().length, loadPath } = {}) {
  const load = hostLoad(loadPath);
  const threshold = 0.7 * cpuCount;
  const info = { load, cpuCount, threshold, forced: Boolean(force) };

  if (load === null) {
    note('no /proc/loadavg on this host: load precondition skipped');
    return info;
  }
  if (force) {
    note(`load precondition overridden (SHOCKBOX_GATE_FORCE=1): load ${load.toFixed(2)}, threshold ${threshold.toFixed(2)}`);
    return info;
  }
  if (load > threshold) {
    const message = [
      `host is busy: 1-minute load ${load.toFixed(2)} > ${threshold.toFixed(2)} (0.7 × ${cpuCount} cpus)`,
      'a wall gate under SwiftShader needs a core of its own; starting now would stack on the hot process.',
      'wait for the load to fall, or re-run with SHOCKBOX_GATE_FORCE=1 to override.',
    ].join('\n  ');
    console.error(`[containment] ${message}`);
    process.exitCode = 1;
    throw new HostBusyError(message);
  }
  note(`load precondition ok: ${load.toFixed(2)} ≤ ${threshold.toFixed(2)} (0.7 × ${cpuCount} cpus)`);
  return info;
}

// --- the CPU ceiling ---------------------------------------------------------------------------
// Chrome under SwiftShader is the thing that overheats the box, so the browser gets a hard CPU
// quota. Best available mechanism, in order: systemd user scope (cgroup, covers every child),
// cpulimit (ptrace-based, single process tree walk), nice 19 (no cap at all — say so loudly).

function which(bin) {
  for (const dir of (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

let systemdProbe = null;

/** One probe per process: does a systemd user scope start here? */
function systemdUserScopeWorks(bin) {
  if (systemdProbe !== null) return systemdProbe;
  try {
    const r = spawnSync(bin, ['--user', '--scope', 'true'], {
      stdio: 'ignore',
      timeout: 10_000,
      env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` },
    });
    systemdProbe = r.status === 0;
  } catch {
    systemdProbe = false;
  }
  return systemdProbe;
}

/**
 * Pick the CPU-cap mechanism and return a wrapper for the Chrome command.
 *
 * @param {object} [opts]
 * @param {number} [opts.capPct]  CPU_CAP_PCT override; default 150 (1.5 cores)
 * @param {number} [opts.memMb]   memory cap for the systemd path; default 4096 (SHOCKBOX_GATE_MEM_MB)
 * @returns {{mechanism: 'systemd-run'|'cpulimit'|'nice', capPct: number, memMb: number,
 *            enforced: boolean, warning: string|null,
 *            command: (exe: string, args: string[]) => {cmd: string, args: string[]},
 *            describe: () => string}}
 */
export function cpuController({ capPct, memMb } = {}) {
  const cap = Number(capPct ?? process.env.CPU_CAP_PCT) || 150;
  const mem = Number(memMb ?? process.env.SHOCKBOX_GATE_MEM_MB) || 4096;
  const systemdRun = which('systemd-run');
  const cpulimit = which('cpulimit');

  let mechanism = 'nice';
  let warning = null;
  if (systemdRun && systemdUserScopeWorks(systemdRun)) {
    mechanism = 'systemd-run';
  } else if (cpulimit) {
    mechanism = 'cpulimit';
  } else {
    warning = `CPU cap NOT enforced: neither a working systemd user scope nor cpulimit was found; falling back to nice -n 19 (cap ${cap}% was requested).`;
  }

  const controller = {
    mechanism,
    capPct: cap,
    memMb: mem,
    enforced: mechanism !== 'nice',
    warning,
    command(exe, args) {
      if (mechanism === 'systemd-run') {
        return {
          cmd: systemdRun,
          args: ['--user', '--scope', `-p`, `CPUQuota=${cap}%`, `-p`, `MemoryMax=${mem}M`, '--', exe, ...args],
        };
      }
      if (mechanism === 'cpulimit') {
        return { cmd: cpulimit, args: ['-l', String(cap), '--', exe, ...args] };
      }
      return { cmd: 'nice', args: ['-n', '19', exe, ...args] };
    },
    describe() {
      if (mechanism === 'systemd-run') return `cpu cap ${cap}% via systemd-run --user --scope (MemoryMax ${mem}M)`;
      if (mechanism === 'cpulimit') return `cpu cap ${cap}% via cpulimit -l ${cap}`;
      return `no cpu cap (nice -n 19 only)`;
    },
  };

  note(controller.describe());
  if (warning) console.error(`[containment] ${warning}`);
  return controller;
}

// --- orphan sweep ------------------------------------------------------------------------------

let swept = null;

/**
 * Run gui/sweep-orphans.sh once per process, with a 60 s timeout, and report its last line.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]       repo root (default: this module's repo)
 * @param {string} [opts.script]     override the sweep script path
 * @param {number} [opts.timeoutMs]  default 60 s
 * @returns {{status: number|null, last: string|null, error?: string}|null} null when the script is absent
 */
export function sweepOrphans({ root = REPO_ROOT, script = path.join(root, 'gui', 'sweep-orphans.sh'), timeoutMs = 60_000 } = {}) {
  if (swept) return swept;
  if (!fs.existsSync(script)) return null;
  try {
    const r = spawnSync('bash', [script], { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = String(r.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    swept = { status: r.status, last: lines.length ? lines[lines.length - 1] : null };
    if (r.error) swept.error = r.error.message;
  } catch (err) {
    swept = { status: null, last: null, error: err.message };
  }
  return swept;
}
