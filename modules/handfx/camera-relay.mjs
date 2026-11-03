// Hand FX camera relay — ffmpeg is the page's camera.
//
// Why this exists: on the streaming rig every physical camera is held by WebcamSwitcher, and a
// browser cannot name a virtual device until a permission grant succeeds, so the overlay page can
// never open a camera itself. `ffmpeg -f dshow -i video="WebcamSwitcher Virtual Camera"` does work
// alongside the app (verified), so the server reads that device and relays the JPEG frames to the
// page over one multipart response.
//
// The contract with the page is bytes, not an API: `--framebound` parts carrying `image/jpeg`,
// newest frame only. ffmpeg writes MJPEG to stdout; this file re-frames that byte stream by SOI/EOI
// marker, keeps the newest frame, and drops (and counts) frames a client has not consumed yet —
// there is no queue, because a late frame is always worse than the newest one.
//
// One process, ever. It starts on the first stream client and stops five seconds after the last one
// leaves; `cameraRelay: off` never spawns. A crash is retried with backoff (1s, 2s, 4s … capped at
// 10s) and the operator sees why as ffmpeg's own stderr tail on /status.
//
// `status().state` is the whole vocabulary, and each value says what it means:
//   off      the config says `cameraRelay: off`; nothing will ever spawn
//   idle     enabled, but no page is reading — there is nothing for the relay to do
//   starting ffmpeg is running and no complete frame has arrived yet
//   live     a complete frame arrived within the last 2 s
//   error    ffmpeg opened but produced no frame in 2 s, frames stopped for 2 s with clients
//            attached, or ffmpeg exited. `error` carries its stderr tail.
// A stalled producer keeps its last frame (`/camera/latest.jpg` still answers) and the status marks
// it `stale`; it is never reported `live`.

import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The multipart boundary both sides write and split on. */
export const BOUNDARY = 'framebound';

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);
const CRLF = Buffer.from('\r\n');
const STDERR_TAIL = 400;
/** A stream with an SOI and no EOI must not grow forever. */
const MAX_PENDING = 8 * 1024 * 1024;
const STOP_AFTER_MS = 5000;
/** A producer that opens and then says nothing is broken, not live: 2 s of silence says so. */
const STALL_MS = 2000;
const WATCHDOG_MS = 500;
const MAX_BACKOFF = 10000;
const SIZES = ['640x360', '960x540', '1280x720'];

/** Coerce whatever the settings layer reports into the shape this file runs on. */
export function normalizeConfig(raw) {
  const c = raw || {};
  const fps = Math.round(Number(c.fps));
  return {
    enabled: c.enabled !== false,
    // The exact DirectShow friendly name: dshow rejects the short form with "Could not find
    // video device", so the fallback must be the same string the setting ships.
    source: String(c.source || 'WebcamSwitcher Virtual Camera (Windows Virtual Camera)'),
    fps: Number.isFinite(fps) ? Math.min(60, Math.max(1, fps)) : 30,
    size: SIZES.includes(c.size) ? c.size : '960x540',
    ffmpegPath: String(c.ffmpegPath || 'ffmpeg'),
  };
}

/** The exact argv, in the order ffmpeg needs it: input before output, output options before `-`. */
export function ffmpegArgs(cfg) {
  return [
    '-loglevel', 'error',
    '-f', 'dshow',
    '-i', `video=${cfg.source}`,
    '-vf', `fps=${cfg.fps}`,
    '-s', cfg.size,
    '-f', 'mjpeg',
    '-q:v', '5',
    '-',
  ];
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The binary to spawn, or null. A bare name is looked up on PATH (with PATHEXT on Windows) so a
 * missing ffmpeg is a reported error and never an unhandled ENOENT throw.
 */
export function resolveBinary(name, env = process.env, platform = process.platform) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  const exts =
    platform === 'win32'
      ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : [''];
  const candidates = [wanted];
  for (const ext of exts) {
    if (!wanted.toLowerCase().endsWith(ext.toLowerCase())) candidates.push(wanted + ext);
  }
  if (wanted.includes('/') || wanted.includes('\\')) {
    for (const candidate of candidates) if (fileExists(candidate)) return candidate;
    return null;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (fileExists(full)) return full;
    }
  }
  // An installer does not always touch PATH (WinGet links, scoop shims, a hand unpack into
  // C:\ffmpeg). A fresh install must not need a hand-edited setting just to find the binary, so
  // the usual homes are tried before this reports nothing.
  if (platform === 'win32') {
    const homes = [
      env.ProgramFiles && path.join(env.ProgramFiles, 'ffmpeg', 'bin'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin',
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims'),
    ].filter(Boolean);
    for (const dir of homes) {
      for (const candidate of candidates) {
        const full = path.join(dir, candidate);
        if (fileExists(full)) return full;
      }
    }
  }
  return null;
}

/**
 * Split an MJPEG byte stream into JPEG frames by SOI (FFD8FF) … EOI (FFD9).
 * Returns counted frames; `onFrame` receives one exact `Buffer` per JPEG, in stream order.
 */
export function createFrameParser(onFrame) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      if (!chunk || !chunk.length) return 0;
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      let frames = 0;
      for (;;) {
        const soi = pending.indexOf(SOI);
        if (soi < 0) {
          // Keep only the two bytes that could be the start of a marker split across chunks.
          if (pending.length > 2) pending = pending.subarray(pending.length - 2);
          break;
        }
        const eoi = pending.indexOf(EOI, soi + SOI.length);
        if (eoi < 0) {
          if (soi > 0) pending = pending.subarray(soi);
          if (pending.length > MAX_PENDING) pending = Buffer.alloc(0);
          break;
        }
        const frame = Buffer.from(pending.subarray(soi, eoi + EOI.length));
        pending = pending.subarray(eoi + EOI.length);
        frames += 1;
        onFrame(frame);
      }
      return frames;
    },
    /** Bytes currently held back waiting for an EOI (diagnostics only). */
    get buffered() {
      return pending.length;
    },
  };
}

/** One multipart part, byte for byte. */
export function framePart(frame) {
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
    frame,
    CRLF,
  ]);
}

/**
 * The relay. `read()` returns the live settings; `spawn` is the seam a test uses for a fake
 * producer (it defaults to node's child_process.spawn and is never needed in production).
 */
export function createCameraRelay({ read = () => ({}), spawn = spawnProcess, log = null } = {}) {
  let cfg = normalizeConfig(read());
  let state = cfg.enabled ? 'idle' : 'off';
  let child = null;
  let parser = null;
  let latest = null;
  let stderrTail = '';
  let attempt = 0;
  let spawnedAt = 0;
  let restartTimer = null;
  let stopTimer = null;
  let watchdogTimer = null;
  const clients = new Set();
  const counters = { frames: 0, dropped: 0, lastFrameAt: 0, error: null };

  const clearRestart = () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  };
  const clearStop = () => {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
  };

  /** ffmpeg owns the device until it says otherwise: ask politely, then force it. */
  function killProcess(proc) {
    try {
      proc.stdin.write('q');
      proc.stdin.end();
    } catch {
      /* stdin already closed */
    }
    const kill = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 1500);
    kill.unref?.();
    proc.once('close', () => clearTimeout(kill));
  }

  /** Milliseconds since the running producer last produced a frame, or since it spawned. */
  function silenceFor(now = Date.now()) {
    if (!child) return 0;
    return now - Math.max(spawnedAt, counters.lastFrameAt);
  }

  /**
   * ffmpeg is running but has delivered no frame in 2 s. That is a dead camera, not a slow one:
   * report the state with the producer's own words, keep the last frame for /camera/latest.jpg
   * (status marks it `stale`), and restart the producer under the normal backoff.
   */
  function stall() {
    const tail = stderrTail.trim();
    const waited = Math.max(1, Math.round(silenceFor() / 1000));
    const what = counters.lastFrameAt
      ? `no frame for ${waited} s`
      : `ffmpeg opened but produced no frame in ${waited} s`;
    const proc = child;
    child = null; // the exit handler must ignore the process we are about to kill
    parser = null;
    setError(`${what}${tail ? `: ${tail}` : ''}`);
    scheduleRestart();
    if (proc) killProcess(proc);
  }

  function checkSilent() {
    if (!child) {
      stopWatchdog();
      return;
    }
    if (silenceFor() > STALL_MS) stall();
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(checkSilent, WATCHDOG_MS);
    watchdogTimer.unref?.();
  }

  function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function setError(message) {
    counters.error = String(message || 'camera relay failed').slice(0, STDERR_TAIL + 120);
    state = 'error';
    if (log && typeof log.warn === 'function') log.warn(`handfx camera: ${counters.error}`);
  }

  function scheduleRestart() {
    if (restartTimer || !cfg.enabled || clients.size === 0) return;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF);
    attempt += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delay);
    restartTimer.unref?.();
  }

  function fail(message) {
    latest = null;
    parser = null;
    setError(message);
    scheduleRestart();
  }

  function pump(client) {
    if (client.busy || !client.pending) return;
    if (client.res.writableEnded || client.res.destroyed) {
      removeClient(client);
      return;
    }
    const frame = client.pending;
    client.pending = null;
    client.busy = true;
    try {
      if (client.res.write(framePart(frame))) {
        client.busy = false;
        if (client.pending) pump(client);
      } else {
        client.res.once('drain', () => {
          client.busy = false;
          pump(client);
        });
      }
    } catch {
      removeClient(client);
    }
  }

  function removeClient(client) {
    if (!clients.delete(client)) return;
    if (!clients.size) scheduleStop();
  }

  function scheduleStop() {
    clearStop();
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (!clients.size) stopChild();
    }, STOP_AFTER_MS);
    stopTimer.unref?.();
  }

  function endClients() {
    for (const client of [...clients]) {
      clients.delete(client);
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
  }

  function stopChild() {
    clearRestart();
    stopWatchdog();
    const proc = child;
    child = null;
    parser = null;
    latest = null;
    spawnedAt = 0;
    counters.lastFrameAt = 0;
    attempt = 0;
    // `idle` is enabled-but-nobody-reading; `off` is the config forbidding the relay entirely.
    state = cfg.enabled ? 'idle' : 'off';
    if (!proc) return;
    killProcess(proc);
  }

  function onFrame(frame) {
    latest = frame;
    counters.frames += 1;
    counters.lastFrameAt = Date.now();
    if (state !== 'live') {
      state = 'live';
      counters.error = null;
      attempt = 0;
    }
    for (const client of clients) {
      // A producer that outruns a consumer loses the older frame; that is the drop counter.
      if (client.pending) counters.dropped += 1;
      client.pending = frame;
      pump(client);
    }
  }

  function start() {
    if (child || !cfg.enabled || clients.size === 0) return;
    clearRestart();
    const bin = resolveBinary(cfg.ffmpegPath);
    if (!bin) {
      // Name what was asked for, so a wrong path is unmistakably a binary problem and never a
      // broken camera: the relay's error is the only thing the operator has to go on.
      const where = process.platform === 'win32' ? 'PATH and the usual Windows install folders' : 'PATH';
      fail(`ffmpeg not found: "${cfg.ffmpegPath}" (looked on ${where})`);
      return;
    }
    let proc;
    try {
      proc = spawn(bin, ffmpegArgs(cfg), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      fail(`ffmpeg failed to start: "${bin}" (${err.code || err.message})`);
      return;
    }
    child = proc;
    parser = createFrameParser(onFrame);
    stderrTail = '';
    spawnedAt = Date.now();
    state = 'starting';
    startWatchdog();
    proc.stdout.on('data', (chunk) => {
      if (parser) parser.push(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
    });
    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      fail(`ffmpeg failed to start: "${bin}" (${err.code || err.message})`);
    });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      const tail = stderrTail.trim();
      fail(`ffmpeg exited (${signal || `code ${code}`})${tail ? `: ${tail}` : ''}`);
    });
  }

  function sync() {
    const next = normalizeConfig(read());
    const changed =
      next.source !== cfg.source ||
      next.fps !== cfg.fps ||
      next.size !== cfg.size ||
      next.ffmpegPath !== cfg.ffmpegPath;
    cfg = next;
    if (!cfg.enabled) {
      if (state !== 'off' || child || restartTimer || stopTimer || clients.size) {
        clearStop();
        stopChild();
        endClients();
      }
      counters.error = null;
      state = 'off';
      return;
    }
    if (state === 'off') state = 'idle';
    if (changed && (child || restartTimer)) {
      clearRestart();
      stopChild();
      if (clients.size) start();
    }
  }

  return {
    sync,

    /** The newest frame as bytes, or null when none ever arrived. A stalled feed keeps its last one. */
    latest() {
      return latest;
    },

    enabled() {
      return cfg.enabled;
    },

    /**
     * Take over `res` and stream parts to it until it closes. The caller has already written the
     * 200/multipart headers; returns the client record for tests.
     */
    addClient(res) {
      const client = { res, busy: false, pending: null };
      const drop = () => removeClient(client);
      res.on('close', drop);
      res.on('error', drop);
      clients.add(client);
      clearStop();
      if (cfg.enabled) {
        start();
        // The newest frame is sent immediately: a client that just connected should not wait a
        // whole frame interval for its first boundary.
        if (latest) client.pending = latest;
        pump(client);
      }
      return client;
    },

    /**
     * The relay's own truth, read by /api/handfx/status. `state` is `off` (disabled by config),
     * `idle` (enabled, no reader), `starting`, `live`, or `error`. `live` is never reported for a
     * frame older than 2 s; `stale` marks a kept frame that is being served by /camera/latest.jpg
     * past its freshness, and `error` carries ffmpeg's stderr tail when there is one.
     */
    status() {
      const silent = silenceFor() > STALL_MS;
      const reported = silent ? 'error' : state;
      const error =
        silent && !counters.error
          ? `no frame for ${Math.max(1, Math.round(silenceFor() / 1000))} s${stderrTail.trim() ? `: ${stderrTail.trim()}` : ''}`
          : counters.error;
      return {
        state: reported,
        source: cfg.source,
        fps: cfg.fps,
        size: cfg.size,
        frames: counters.frames,
        dropped: counters.dropped,
        clients: clients.size,
        lastFrameAt: counters.lastFrameAt || null,
        stale: reported === 'error' && Boolean(latest),
        error,
      };
    },

    dispose() {
      clearRestart();
      clearStop();
      stopWatchdog();
      endClients();
      stopChild();
    },
  };
}
