// One headless-Chrome launcher for every gate that talks CDP.
//
// The gates each used to spawn Chrome with `stdio: 'ignore'` and poll a DevTools endpoint; when
// Chrome died at launch (no sandbox, no /dev/shm, a missing profile path, a muzzled crashpad
// handler) the test waited out its retry loop and threw a generic "did not expose…" — hiding the
// one line Chrome had already printed saying why. This module keeps Chrome's stderr in a ring
// buffer and spends it: a launch failure, an early exit, or a readiness timeout all throw with the
// exit code/signal and the tail of what Chrome said.
//
//   const { devtools, stop } = await launchChrome({ size: [1440, 900] });
//
// The same reaper covers the second way a headless browser burns a core forever: `spawn`ning one
// outside this module. Every stray Chrome on this box is killed by `isUnmanagedHeadless()`, at
// launch time and from the exit/signal handlers, because a gate that leaks one costs a full core
// of SwiftShader until somebody notices the fans.
//
// What it guarantees:
//   · binary from CHROME, then CHROME_PATH, then the /usr/bin names every gate already probed
//   · --no-sandbox only when CI is set (a runner user cannot use the setuid sandbox); never locally
//   · --disable-dev-shm-usage (Docker's /dev/shm is 64 MB and Chrome's renderer dies on it)
//   · a fresh profile per launch under os.tmpdir()
//   · readiness = /json/version answers AND a page target exists in /json/list — if no page target
//     registered, one is opened with PUT /json/new?about:blank rather than assuming the first tab
//     shows up in time
//   · timeout 30 s when CI is set, 15 s otherwise
//   · the whole browser dies with the gate: Chrome runs in its own process group and `stop()` —
//     also armed on process exit, SIGINT, SIGTERM and SIGHUP — kills that GROUP, not just the
//     top-level child. Killing only the child leaves chrome, zygote and gpu-process reparented to
//     PID 1, and on a page with WebGL the gpu-process burns 300–520 % CPU in SwiftShader forever.
//     A gate that hangs, throws or is Ctrl-C'd used to leave one of those per run; 43 of them
//     took the host's CPU to 100 °C and throttling.
//
// NO GATE SPAWNS A BROWSER OR A SERVER ITSELF. Every one goes through `launchChrome` and
// `startServer` here. A file that calls `spawn` on chrome/chromium, or that writes its own
// `freePort()` / `child.kill('SIGKILL')` / finally-timeout launcher, is the bug this module
// exists to remove: it puts a browser outside the reaper, which is exactly how the leak came back
// last time. If a gate needs a flag, a size or a timeout, pass `extraArgs`, `size` or `timeoutMs`.
//
// COST: a wall/render page under SwiftShader costs roughly ONE FULL CORE per browser for as long as
// it is open — the LED shader runs on the CPU, and a gpu-process at 300–520 % is a single WebGL
// page, not a busy machine. So:
//   · never run two wall-page gates at the same time (wall-browser, wall-image-browser,
//     merged-preview all mount /wall/render; run them one after another — that is why
//     `test:wall-image` and `test:preview` are separate npm scripts and are NOT in `npm test`,
//     which is a serial && chain only because each step waits for the previous to exit)
//   · every launch here must be followed by `stop()` in a `finally` — the reaper only saves you
//     from a gate that throws, not from one that opens a second page "just to check something"
//   · a gate that hangs still burns that core until something reaps it; a generous waitFor is
//     cheaper than a retry loop that leaves the page open
//   · if you suspect a gate was killed before its `finally`: `bash gui/sweep-orphans.sh` lists
//     (and, without --dry-run, reaps) every headless Chrome and stray test server on the box.
//     `npm test` runs it as `pretest`; `npm run sweep` runs it by hand.
//
// CONTAINMENT (enforced here, not asked for in a doc): `launchChrome` takes an exclusive lock file
// (one gate at a time), refuses to start when the host is already above 0.7 × cpus of 1-minute load,
// spawns Chrome inside a hard CPU quota (systemd-run user scope, else cpulimit, else nice 19 with a
// warning), and releases the lock plus runs `gui/sweep-orphans.sh` from `stop()`. Overrides:
// SHOCKBOX_GATE_FORCE=1 (load), CPU_CAP_PCT (default 150), SHOCKBOX_GATE_MEM_MB (default 4096).
//
// Anything a caller needs that this does not pass goes in `extraArgs`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Structural limits for the browser itself: one gate at a time, a hard CPU quota, a refusal to
// start on a hot host, and an orphan sweep on the way out. See test/lib/containment.mjs.
import {
  acquireGateLock,
  assertHostIdle,
  cpuController,
  gateName,
  releaseGateLock,
  sweepOrphans,
} from './containment.mjs';

export const IN_CI = Boolean(process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0');

// --- the test server ---------------------------------------------------------------------------
// The other half of the same leak. Every gate started `server.mjs` with a plain spawn and stopped
// it with `child.kill('SIGTERM')`; when the gate threw or hung, the stop never ran and the server
// kept its port, its state dir and its log file open until the host was rebooted. Same fix as the
// browser: its own process group, and a reaper that kills the group.

const SERVERS = new Set();
let serverReaperArmed = false;

/** Stop a gate's `server.mjs`. Idempotent, and safe to call from an exit handler. */
export function reapServer(entry) {
  if (!entry || entry.stopped) return;
  entry.stopped = true;
  SERVERS.delete(entry);
  try {
    process.kill(-entry.pid, 'SIGKILL');
  } catch {
    /* no group (already gone, or spawn failed) — the direct kill below still runs */
  }
  try {
    if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function reapAllServers() {
  for (const entry of [...SERVERS]) reapServer(entry);
}

// A server.mjs left by a dead gate is cheap next to a browser, but it holds a port and a state
// dir; it costs one /proc pass to leave nothing at all behind.
function reapStrayServers() {
  for (const pid of procDirEntries()) {
    if (Number(pid) === process.pid) continue;
    const cmd = readProc(pid, 'cmdline');
    if (!cmd) continue;
    const argv = cmd.split('\0').filter(Boolean);
    if (!argv.some((a) => a.endsWith('server.mjs'))) continue;
    if (!argv.includes('--state')) continue; // a real dev server takes no --state
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function armServerReaper() {
  if (serverReaperArmed) return;
  serverReaperArmed = true;
  process.on('exit', () => {
    reapAllServers();
    reapStrayServers();
  });
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => {
      reapAllServers();
      reapStrayServers();
      process.exit(code);
    });
  }
}

/**
 * Start `server.mjs` on a free port with a throwaway state dir and wait for /health.
 *
 * @param {object} opts
 * @param {string} opts.root                 the repo root (where server.mjs lives)
 * @param {string} [opts.statePrefix]        temp state dir prefix, e.g. 'sb-drag-'
 * @param {string[]} [opts.args]             extra argv after --port/--state
 * @param {Function} [opts.spawn]            the spawn to use (defaults to node:child_process)
 * @param {Function} [opts.mkdtemp]          the temp-dir maker (defaults to fs.mkdtempSync)
 * @returns {Promise<{url: string, stateDir: string, child: object, stop: () => void}>}
 */
export async function startServer({ root, statePrefix = 'sb-srv-', args: extra = [], spawn: spawnFn, mkdtemp } = {}) {
  const { spawn: spawnDefault } = await import('node:child_process');
  const spawnChild = spawnFn || spawnDefault;
  const mkdtempSync = mkdtemp || fs.mkdtempSync;
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), statePrefix));
  const child = spawnChild(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--state', stateDir, ...extra], {
    cwd: root,
    // stderr is kept (a ring of the last lines) and stdout dropped: a boot failure has to name its
    // reason in the throw, which is what every gate's hand-rolled log buffer existed for.
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  const entry = { child, pid: child.pid, stopped: false, log: [] };
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line) entry.log.push(`${line}\n`);
      if (entry.log.length > 60) entry.log.splice(0, entry.log.length - 60);
    });
  }
  if (child.pid) {
    SERVERS.add(entry);
    armServerReaper();
  }
  const stop = () => reapServer(entry);
  child.on('exit', () => SERVERS.delete(entry));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stateDir, child, stop, log: entry.log };
    } catch {
      /* starting */
    }
  }
  stop();
  throw new Error(`server did not start:\n${entry.log.join('')}`);
}

const PROBED = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

/** The Chrome binary every gate uses. `null` when none is installed. */
export function findChrome() {
  const given = process.env.CHROME || process.env.CHROME_PATH;
  if (given) return given;
  return PROBED.find((p) => fs.existsSync(p)) || null;
}

export const CHROME = findChrome();

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STDERR_LINES = 60;

// --- unmanaged browsers -----------------------------------------------------------------------
// A Chrome started by hand (a gate that rolled its own spawn, a probe script, a crashed run) does
// not belong to any LIVE entry, so nothing above ever reaps it. Its command line is what identifies
// it: a headless Chrome carrying --remote-debugging-port was started to be driven by a script, and
// once its driver is gone it is dead weight burning a full core on a WebGL page.
const MANAGED = new Set(); // every pid this module has ever launched
const KILLED = new Set(); // ...and their groups, so nothing is reported twice

function procDirEntries() {
  try {
    return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return []; // not Linux: this pass is a no-op rather than a throw
  }
}

function readProc(pid, name) {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
  } catch {
    return null;
  }
}

/** The argv of every live headless Chrome nobody in this process launched. */
export function unmanagedHeadlessChromes() {
  const out = [];
  const self = process.pid;
  for (const pid of procDirEntries()) {
    if (Number(pid) === self || MANAGED.has(Number(pid))) continue;
    const cmd = readProc(pid, 'cmdline');
    if (!cmd) continue;
    const argv = cmd.split('\0').filter(Boolean);
    if (!argv.length) continue;
    const exe = path.basename(argv[0]);
    if (!/^(google-chrome|chromium|chrome|headless_shell)(-stable)?$/.test(exe)) continue;
    if (!argv.some((a) => a === '--headless' || a.startsWith('--headless='))) continue;
    const dbg = argv.find((a) => a.startsWith('--remote-debugging-port'));
    if (!dbg) continue; // a visible browser is the user's; a headless one with no port is not a test
    const stat = readProc(pid, 'stat');
    // pid (comm) state ppid pgrp ...
    const fields = stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ') : [];
    const pgrp = fields.length > 2 ? Number(fields[2]) : Number(pid);
    const ppid = fields.length > 1 ? Number(fields[1]) : 0;
    out.push({ pid: Number(pid), pgrp, ppid, exe, dbg });
  }
  return out;
}

/** True when `pid` looks like an unmanaged headless Chrome. */
export function isUnmanagedHeadless(pid) {
  if (!pid || MANAGED.has(Number(pid))) return false;
  return unmanagedHeadlessChromes().some((c) => c.pid === Number(pid));
}

/**
 * Kill every unmanaged headless Chrome on the box (process group first, so gpu-process and
 * zygote go with it). Returns the pids it took down. Cheap: ~400 /proc reads, no spawn.
 */
export function reapUnmanagedHeadlessChromes() {
  const killed = [];
  for (const c of unmanagedHeadlessChromes()) {
    let gone = false;
    if (c.pgrp && c.pgrp !== Number(c.pid) && KILLED.has(c.pgrp)) gone = true;
    if (!gone) {
      try {
        process.kill(-c.pgrp, 'SIGKILL');
        gone = true;
      } catch {
        /* its own group is already empty; the direct kill below decides */
      }
      try {
        process.kill(c.pid, 'SIGKILL');
        gone = true;
      } catch {
        /* already gone */
      }
    }
    KILLED.add(c.pgrp || c.pid);
    MANAGED.add(c.pid);
    if (gone) killed.push(c.pid);
  }
  return killed;
}

/**
 * Guard a pid that came out of a gate's logs (`log: [server 12345: ...]`). When it is an unmanaged
 * headless Chrome - the pid a leaked browser printed at boot - it is killed and `true` returned.
 */
export function reapIfBrowser(pid) {
  if (!pid || MANAGED.has(Number(pid))) return false;
  const cmd = readProc(Number(pid), 'cmdline');
  if (!cmd) return false;
  const argv = cmd.split('\0').filter(Boolean);
  const exe = argv.length ? path.basename(argv[0]) : '';
  if (!/^(google-chrome|chromium|chrome|headless_shell)(-stable)?$/.test(exe)) return false;
  if (!argv.some((a) => a === '--headless' || a.startsWith('--headless='))) return false;
  let gone = false;
  try {
    process.kill(-Number(pid), 'SIGKILL');
    gone = true;
  } catch {
    /* not a group leader */
  }
  try {
    process.kill(Number(pid), 'SIGKILL');
    gone = true;
  } catch {
    /* already gone */
  }
  MANAGED.add(Number(pid));
  return gone;
}

// --- the browser reaper ------------------------------------------------------------------------
// Every launch registers its process group here and unregisters when it has been killed. The
// exit/signal handlers are installed once, on the first launch, so a gate that forgets its
// `finally` still leaves nothing behind. `kill(-pgid)` is the only call that reaches the zygote
// and gpu-process children, which are never in our process tree for long enough to wait on.
const LIVE = new Set();
let reaperArmed = false;

/** Kill a browser and its whole process group. Idempotent. */
export function reap(entry) {
  if (!entry || entry.reaped) return;
  entry.reaped = true;
  LIVE.delete(entry);
  try {
    // The launched Chrome is the group leader (spawn → detached), so -pid is every child it made:
    // zoom, zygote, gpu-process, renderer, utility.
    if (entry.pid) process.kill(-entry.pid, 'SIGKILL');
  } catch {
    /* already gone: ESRCH means the group is clean */
  }
  // Belt and braces for a child that somehow left the group (or was launched on a platform
  // without process groups): the direct kill is what the old code did.
  try {
    if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function reapAll() {
  for (const entry of [...LIVE]) reap(entry);
}

// --- orphan sweep ------------------------------------------------------------------------------
// One last pass on the way out: if a browser escaped its group, or an earlier run left one behind,
// gui/sweep-orphans.sh reaps it. At most once per process; `sweepOrphans` caches the result, so the
// stop() call and the exit hook share one run.
let sweepArmed = false;

function sweepOrphansOnce() {
  const swept = sweepOrphans();
  if (!swept) return;
  if (swept.last) console.log(`[containment] orphan sweep: ${swept.last}`);
  else if (swept.error) console.error(`[containment] orphan sweep failed: ${swept.error}`);
}

function armSweep() {
  if (sweepArmed) return;
  sweepArmed = true;
  process.on('exit', () => sweepOrphansOnce()); // registered after the browser reaper, so it runs last
}

function armReaper() {
  if (reaperArmed) return;
  reaperArmed = true;
  process.on('exit', () => {
    reapAll();
    reapUnmanagedHeadlessChromes(); // a gate that spawned its own browser leaves it to us
  });
  // A signal handler suppresses the default action, so each of these ends the process itself:
  // exit code 130/143/129, which is what a shell reports for an interrupted gate anyway.
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(sig, () => {
      reapAll();
      reapUnmanagedHeadlessChromes();
      process.exit(code);
    });
  }
}

/**
 * Start headless Chrome with the remote debugging endpoint up and one page target ready.
 *
 * @param {object} [opts]
 * @param {[number, number]} [opts.size]            [width, height] for --window-size
 * @param {string[]} [opts.extraArgs]               appended after the shared flags
 * @param {string} [opts.profilePrefix]             prefix for the temp profile dir
 * @param {number} [opts.timeoutMs]                 override the 30 s (CI) / 15 s readiness timeout
 * @returns {Promise<{devtools: string, wsUrl: string, port: number, profile: string, child: import('node:child_process').ChildProcess, stderr: () => string, stop: () => void}>}
 */
export async function launchChrome({ size = [1280, 720], extraArgs = [], profilePrefix = 'sb-chrome-', timeoutMs } = {}) {
  if (!CHROME) {
    throw new Error(`no chrome/chromium found (set CHROME= or CHROME_PATH=); probed ${PROBED.join(', ')}`);
  }
  // Fail before anything is allocated: a hot host, or a gate that is already running, means no
  // browser at all. Both throw with the reason; the gate exits non-zero.
  assertHostIdle();
  acquireGateLock({ name: gateName() });
  const cpuCap = cpuController();

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    `--window-size=${size[0]},${size[1]}`,
    ...(IN_CI ? ['--no-sandbox'] : []),
    ...extraArgs,
    'about:blank',
  ];

  // detached puts Chrome in a new process group led by itself, which is what makes `kill(-pid)`
  // reach the children it spawns. Nothing here waits on the browser, so it never needs the
  // terminal to stay in the loop; the gate's own output is unaffected.
  //
  // The command is the CPU-cap wrapper, not the binary: systemd-run's scope becomes the group
  // leader and Chrome (with its zygote/gpu-process) lives inside it, so `kill(-pid)` still reaches
  // every child while the cgroup quota covers the whole tree.
  const wrapped = cpuCap.command(CHROME, args);
  const child = spawn(wrapped.cmd, wrapped.args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const entry = { child, pid: child.pid, reaped: false };
  if (child.pid) {
    LIVE.add(entry);
    MANAGED.add(child.pid);
    armReaper();
    armSweep();
  }

  // Ring buffer of Chrome's own words. stdout is read and dropped so a full pipe can never block
  // Chrome; stderr is what diagnostics come from.
  const lines = [];
  const keep = (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > STDERR_LINES * 4) lines.splice(0, lines.length - STDERR_LINES * 4);
    }
  };
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', keep);

  let exit = null; // { code, signal } once the process is gone
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
    child.on('error', (err) => {
      exit = { code: null, signal: `spawn error: ${err.message}` };
      keep(`launch failed: ${err.message}`);
      resolve();
    });
  });

  const t0 = Date.now();
  const stderrTail = (n = 40) => lines.slice(-n).join('\n') || '(chrome printed nothing)';
  const describe = () => {
    const how = exit ? `exited (code ${exit.code}, signal ${exit.signal})` : 'still running';
    const bits = [
      `chrome ${how} after ${Date.now() - t0} ms`,
      `binary: ${CHROME}`,
      `args: ${args.join(' ')}`,
      `stderr (last ${Math.min(lines.length, 40)} of ${lines.length} lines):`,
      stderrTail()
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    ];
    if (!exit && IN_CI) bits.push('CI run: --no-sandbox was passed; if Chrome is still alive, the DevTools endpoint may be bound elsewhere.');
    return bits.join('\n  ');
  };

  // Teardown for every exit path: the browser's whole process group, the gate lock, then the orphan
  // sweep. `reap` is idempotent; the other two are guarded here so a gate calling stop() twice and
  // the 'exit' handler after it do not release somebody else's lock or sweep twice.
  let tornDown = false;
  const stop = () => {
    if (tornDown) return;
    tornDown = true;
    reap(entry); // kill(-pid): the wrapper and every chrome child in its group
    releaseGateLock();
    sweepOrphansOnce();
  };

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (timeoutMs ?? (IN_CI ? 30_000 : 15_000));
  let version = null;

  while (Date.now() < deadline) {
    if (exit) {
      stop(); // a browser that never came up still owns the group slot and the lock
      throw new Error(`chrome did not start:\n  ${describe()}`);
    }
    if (!version) {
      try {
        const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) version = await r.json();
      } catch {
        /* endpoint not up yet */
      }
    }
    if (version) {
      // A page target is what the gates attach to. Chrome 156's headless shell can come up before
      // its first tab is listed, so open one explicitly instead of waiting on the default tab.
      let wsUrl = null;
      try {
        const list = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
        else {
          const made = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
          if (made && made.webSocketDebuggerUrl) wsUrl = made.webSocketDebuggerUrl;
        }
      } catch {
        /* list raced the browser; retry on the next tick */
      }
      if (wsUrl) {
        // A browser that dies on its own must stop being a reaper target.
        child.on('exit', () => LIVE.delete(entry));
        return { devtools: base, wsUrl, port, profile, child, stderr: stderrTail, stop };
      }
    }
    await sleep(150);
  }

  // Timed out: give an exited process a moment to report, then say everything we know.
  await Promise.race([exited, sleep(500)]);
  stop(); // the group goes with it, not just the child this handle names
  fs.rmSync(profile, { recursive: true, force: true });
  throw new Error(`chrome did not expose a page target within ${Math.round((Date.now() - t0) / 1000)} s:\n  ${describe()}`);
}
