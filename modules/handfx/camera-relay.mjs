// ShockFX camera relay — ffmpeg is the page's camera.
//
// Why this exists: on the streaming rig every physical camera is held by WebcamSwitcher, and a
// browser cannot name a virtual device until a permission grant succeeds, so the overlay page can
// never open a camera itself. ffmpeg reads the camera and this relay pushes the JPEG frames to the
// page over one multipart response.
//
// Two capture paths, and the rig decides which one works:
//   pipe   read WebcamSwitcher's own frame pipe (`\\.\pipe\WebcamSwitcher.Frames.v1`, the publisher
//          documented in WebcamSwitcherProtocol.h) and feed its NV12 payloads to ffmpeg's stdin.
//          The app has a client list and no singleton, so this is a legitimate second reader. It
//          is the path that works when the Media Foundation virtual device delivers zero packets.
//   dshow  `ffmpeg -f dshow -i video="WebcamSwitcher Virtual Camera"` (the original path).
// `cameraRelayCapture` picks: `auto` tries pipe first and falls back to dshow only after a pipe
// attempt fails, recording both the mode actually in use and why the pipe was abandoned; `pipe`
// and `dshow` force one. Never a silent switch: /status carries `capture.mode` and
// `capture.fallback`.
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
//   error    ffmpeg opened but produced no frame in 8 s, frames stopped for 2 s with clients
//            attached, or ffmpeg exited. `error` carries its stderr tail.
// A stalled producer keeps its last frame (`/camera/latest.jpg` still answers) and the status marks
// it `stale`; it is never reported `live`.

import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** The multipart boundary both sides write and split on. */
export const BOUNDARY = 'framebound';

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);
const CRLF = Buffer.from('\r\n');
/**
 * ffmpeg's useful half is at the head of stderr: the dshow device open, the input format and the
 * reason the device refused. Its epilogue (`[enc:mjpeg] Could not open encoder before EOF`,
 * `Task finished with error code`) is what the tail holds. Keep the first 2 KB (over the head, so
 * it cannot grow) and the last 400 bytes, with a marker between them when the middle was dropped.
 * Both are fixed-size strings: a chatty ffmpeg cannot grow memory here.
 */
const STDERR_HEAD = 2048;
const STDERR_TAIL = 400;
/** A status error carries head + tail + argv + labels; anything beyond this is a runaway string. */
const MAX_ERROR = STDERR_HEAD + STDERR_TAIL + 512;
/** A stream with an SOI and no EOI must not grow forever. */
const MAX_PENDING = 8 * 1024 * 1024;
const STOP_AFTER_MS = 5000;
/** A producer that opens and then says nothing is broken, not live: 2 s of silence says so. */
const STALL_MS = 2000;
/**
 * The first frame is a device open, not a stall: dshow delivered byte one at 1.97 s on the rig
 * (1280x720 yuyv422), so a 2 s deadline killed healthy opens and every kill left the Media
 * Foundation source wedged. Frames after the first keep the 2 s rule.
 */
const START_GRACE_MS = 8000;
const WATCHDOG_MS = 500;
const MAX_BACKOFF = 10000;
const SIZES = ['640x360', '960x540', '1280x720'];

/**
 * WebcamSwitcher's frame publisher (src/WebcamSwitcher.Shared/WebcamSwitcherProtocol.h, mirrored by
 * publish-pipe.mjs, which writes this same wire format in the other direction). `#pragma pack(1)`,
 * little-endian: a 12-byte header then the payload. No subscribe handshake — connect and the server
 * pushes config, then frames. Frames are never queued for a slow reader; it is dropped instead.
 */
export const DEFAULT_PIPE = '\\\\.\\pipe\\WebcamSwitcher.Frames.v1';
const WS_MAGIC = 0x57564353;
const WS_VERSION = 1;
const WS_TYPE_CONFIG = 1;
const WS_TYPE_FRAME = 2;
const WS_HDR = 12;
const WS_CONFIG = 24;
const WS_INFO = 40;
/** A payload this large is a corrupt length, not a frame: refuse before allocating it. */
const WS_MAX_PAYLOAD = 64 * 1024 * 1024;
/**
 * Config arrives on connect and ffmpeg cannot be spawned without its geometry, so silence here is a
 * broken publisher, not a slow one. 3 s is generous for a named-pipe connect on the same machine.
 */
const PIPE_CONFIG_MS = 3000;

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
    capture: ['auto', 'pipe', 'dshow'].includes(c.capture) ? c.capture : 'auto',
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

/**
 * Pipe mode: the publisher's NV12 payloads are the input, read from stdin. Same downstream scaling
 * and MJPEG settings as the dshow path, so the page cannot tell the two apart.
 */
export function pipeFfmpegArgs(cfg, geom) {
  return [
    '-loglevel', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'nv12',
    // The payload has no padding: stride == width, top-down. If a geometry ever disagrees the relay
    // refuses it rather than letting ffmpeg read a sheared picture.
    '-s', `${geom.width}x${geom.height}`,
    '-framerate', `${geom.fpsNum}/${geom.fpsDen}`,
    '-i', 'pipe:0',
    '-vf', `fps=${cfg.fps}`,
    '-s', cfg.size,
    '-f', 'mjpeg',
    '-q:v', '5',
    '-',
  ];
}

/**
 * Split the publisher's byte stream into messages, across arbitrary chunk boundaries: one read is
 * never assumed to be one message. Returns `{ config, frames }` counts for this chunk. Throws on a
 * header that cannot be the documented protocol, so the relay can say what it saw.
 */
export function createPipeParser({ onConfig, onFrame }) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      let config = 0;
      let frames = 0;
      if (chunk && chunk.length) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      }
      while (pending.length >= WS_HDR) {
        const magic = pending.readUInt32LE(0);
        if (magic !== WS_MAGIC) {
          throw new Error(`unexpected magic 0x${magic.toString(16)} (expected 0x57564353)`);
        }
        const version = pending.readUInt16LE(4);
        if (version !== WS_VERSION) throw new Error(`unsupported protocol version ${version}`);
        const type = pending.readUInt16LE(6);
        const payloadLen = pending.readUInt32LE(8);
        if (payloadLen > WS_MAX_PAYLOAD) throw new Error(`implausible payload length ${payloadLen}`);
        if (pending.length < WS_HDR + payloadLen) break; // the message is not all here yet
        const payload = pending.subarray(WS_HDR, WS_HDR + payloadLen);
        pending = pending.subarray(WS_HDR + payloadLen);
        if (type === WS_TYPE_CONFIG) {
          if (payloadLen !== WS_CONFIG) throw new Error(`config payload ${payloadLen} != ${WS_CONFIG}`);
          config += 1;
          onConfig({
            width: payload.readUInt32LE(0),
            height: payload.readUInt32LE(4),
            stride: payload.readUInt32LE(8),
            format: payload.readUInt32LE(12),
            fpsNum: payload.readUInt32LE(16),
            fpsDen: payload.readUInt32LE(20),
          });
        } else if (type === WS_TYPE_FRAME) {
          if (payloadLen < WS_INFO) throw new Error(`frame payload ${payloadLen} < ${WS_INFO}`);
          const info = {
            sequence: Number(payload.readBigUInt64LE(0)),
            timestampQpc: Number(payload.readBigUInt64LE(8)),
            width: payload.readUInt32LE(16),
            height: payload.readUInt32LE(20),
            stride: payload.readUInt32LE(24),
            format: payload.readUInt32LE(28),
            payloadBytes: payload.readUInt32LE(32),
            flags: payload.readUInt32LE(36),
          };
          frames += 1;
          onFrame(info, payload.subarray(WS_INFO));
        }
        // Any other type is skipped by its own length: a newer publisher may add messages.
      }
      return { config, frames };
    },
    /** Bytes held back waiting for the rest of a message (diagnostics only). */
    get buffered() {
      return pending.length;
    },
  };
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
export function createCameraRelay({ read = () => ({}), spawn = spawnProcess, log = null, pipePath = null } = {}) {
  const pipeName = String(pipePath || DEFAULT_PIPE);
  let cfg = normalizeConfig(read());
  let state = cfg.enabled ? 'idle' : 'off';
  let child = null;
  let parser = null;
  let latest = null;
  let stderrHead = '';
  let stderrTail = '';
  let currentArgv = [];
  let attempt = 0;
  let spawnedAt = 0;
  let restartTimer = null;
  let stopTimer = null;
  let watchdogTimer = null;
  /** Which capture path is running right now, or null when nothing is. */
  let mode = null;
  let pipeSocket = null;
  let pipeConfigTimer = null;
  /** The newest NV12 payload that arrived before ffmpeg existed, so it is not lost. */
  let pipeLatest = null;
  /** One frame's worth of bytes: the most that may sit in ffmpeg's stdin write buffer. */
  let stdinLimit = 0;
  /** Why `auto` stopped using the pipe for this attempt; null when it never fell back. */
  let fallback = null;
  const pipeInput = { frames: 0, dropped: 0, width: 0, height: 0, fpsNum: 0, fpsDen: 0, lastAt: 0 };
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

  /** How long silence may last: the startup grace until this producer delivers its first frame. */
  function stallLimit() {
    return counters.lastFrameAt >= spawnedAt ? STALL_MS : START_GRACE_MS;
  }

  /** Milliseconds since the running producer last produced a frame, or since it spawned. */
  function silenceFor(now = Date.now()) {
    if (!child) return 0;
    return now - Math.max(spawnedAt, counters.lastFrameAt);
  }

  /**
   * The stderr an operator needs, not just the epilogue: the first 2 KB (device open, format) with
   * the last 400 bytes appended after a marker. `head.endsWith(tail)` means the whole output fits
   * in the head; returning it alone avoids printing the overlap twice.
   */
  function stderrWindow() {
    const head = stderrHead.trim();
    const tail = stderrTail.trim();
    if (!head) return tail;
    if (!tail || head.endsWith(tail)) return head;
    return `${head}\n…\n${tail}`;
  }

  /** The exact argv, quoted so a device name with spaces stays one readable token. */
  function argvLine() {
    return currentArgv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  }

  /**
   * ffmpeg is running but has delivered no frame in 2 s. That is a dead camera, not a slow one:
   * report the state with the producer's own words, keep the last frame for /camera/latest.jpg
   * (status marks it `stale`), and restart the producer under the normal backoff.
   */
  function stall() {
    const window = stderrWindow();
    const waited = Math.max(1, Math.round(silenceFor() / 1000));
    const what = counters.lastFrameAt
      ? `no frame for ${waited} s`
      : `ffmpeg opened but produced no frame in ${waited} s`;
    const proc = child;
    child = null; // the exit handler must ignore the process we are about to kill
    parser = null;
    setError(`${what}; argv: ${argvLine()}${window ? `; stderr: ${window}` : ''}`);
    scheduleRestart();
    if (proc) killProcess(proc);
  }

  function checkSilent() {
    if (!child) {
      stopWatchdog();
      return;
    }
    if (silenceFor() > stallLimit()) stall();
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
    counters.error = String(message || 'camera relay failed').slice(0, MAX_ERROR);
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
    teardownPipe();
    setError(message);
    scheduleRestart();
  }

  /**
   * The pipe is unusable for this attempt. Say so with the pipe name and the reason, then either
   * fall back to dshow (`auto`, recorded in `capture.fallback`) or report and retry the pipe under
   * the normal backoff (`pipe`).
   */
  function pipeFailed(reason) {
    const message = `pipe ${pipeName}: ${reason}`;
    const wasAuto = cfg.capture === 'auto';
    teardownPipe();
    const proc = child;
    child = null;
    parser = null;
    spawnedAt = 0;
    counters.lastFrameAt = 0;
    if (proc) killProcess(proc);
    mode = null;
    if (wasAuto && clients.size) {
      fallback = message;
      latest = null;
      setError(`${message}; auto: falling back to dshow "${cfg.source}"`);
      startDshow();
      return;
    }
    fail(message);
  }

  /** Spawn one producer and wire its pipes. `mode` decides whether stdin is fed by the pipe reader. */
  function spawnChild(bin, args) {
    let proc;
    const argv = [bin, ...args];
    currentArgv = argv;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      mode = null;
      fail(`ffmpeg failed to start: "${bin}" (${err.code || err.message})`);
      return;
    }
    child = proc;
    parser = createFrameParser(onFrame);
    stderrHead = '';
    stderrTail = '';
    spawnedAt = Date.now();
    state = 'starting';
    startWatchdog();
    if (mode === 'pipe') {
      // A frame that arrived between the config message and this spawn: send the newest one.
      if (pipeLatest) {
        const first = pipeLatest;
        pipeLatest = null;
        writeInput(first);
      }
    }
    proc.stdout.on('data', (chunk) => {
      if (parser) parser.push(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // Fill the head only until it is full; the ring lives on the first 2 KB, never the whole
      // stream, so ffmpeg cannot grow this process's memory by talking.
      if (stderrHead.length < STDERR_HEAD) stderrHead = (stderrHead + text).slice(0, STDERR_HEAD);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
    });
    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      fail(`ffmpeg failed to start: "${bin}" (${err.code || err.message})`);
    });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      child = null;
      const window = stderrWindow();
      fail(
        `ffmpeg exited (${signal || `code ${code}`}); argv: ${argvLine()}${window ? `; stderr: ${window}` : ''}`,
      );
    });
  }

  function startDshow(bin = resolveBinary(cfg.ffmpegPath)) {
    if (!bin) {
      const where = process.platform === 'win32' ? 'PATH and the usual Windows install folders' : 'PATH';
      fail(`ffmpeg not found: "${cfg.ffmpegPath}" (looked on ${where})`);
      return;
    }
    mode = 'dshow';
    spawnChild(bin, ffmpegArgs(cfg));
  }

  function start() {
    if (child || pipeSocket || !cfg.enabled || clients.size === 0) return;
    clearRestart();
    const bin = resolveBinary(cfg.ffmpegPath);
    if (!bin) {
      // Name what was asked for, so a wrong path is unmistakably a binary problem and never a
      // broken camera: the relay's error is the only thing the operator has to go on.
      const where = process.platform === 'win32' ? 'PATH and the usual Windows install folders' : 'PATH';
      fail(`ffmpeg not found: "${cfg.ffmpegPath}" (looked on ${where})`);
      return;
    }
    if (cfg.capture === 'dshow') {
      startDshow(bin);
      return;
    }
    startPipe(bin);
  }

  /** Connect to the publisher and wait for its config; ffmpeg cannot start without the geometry. */
  function startPipe(bin) {
    mode = 'pipe';
    teardownPipe();
    state = 'starting';
    const sock = net.connect({ path: pipeName });
    pipeSocket = sock;
    const stream = createPipeParser({
      onConfig: (geom) => {
        if (pipeSocket === sock) onPipeConfig(bin, geom);
      },
      onFrame: (info, payload) => {
        if (pipeSocket === sock) onPipeFrame(info, payload);
      },
    });
    sock.on('connect', () => {
      try {
        sock.setNoDelay?.(true);
      } catch {
        /* not a socket option on this platform */
      }
    });
    sock.on('data', (chunk) => {
      if (pipeSocket !== sock) return;
      try {
        stream.push(chunk);
      } catch (err) {
        pipeFailed(`protocol error: ${err.message}`);
      }
    });
    sock.on('error', (err) => {
      if (pipeSocket !== sock) return;
      pipeFailed(`connect failed (${err.code || err.message})`);
    });
    sock.on('close', () => {
      if (pipeSocket !== sock) return;
      pipeFailed('publisher closed the connection');
    });
    pipeConfigTimer = setTimeout(() => {
      pipeConfigTimer = null;
      if (pipeSocket !== sock) return;
      pipeFailed(`connected but no config in ${PIPE_CONFIG_MS / 1000} s`);
    }, PIPE_CONFIG_MS);
    pipeConfigTimer.unref?.();
  }

  /** The publisher's own geometry, checked rather than trusted: NV12 at stride == width only. */
  function onPipeConfig(bin, geom) {
    if (pipeConfigTimer) clearTimeout(pipeConfigTimer);
    pipeConfigTimer = null;
    if (
      !geom.width ||
      !geom.height ||
      geom.format !== 1 ||
      geom.stride !== geom.width ||
      !geom.fpsNum ||
      !geom.fpsDen
    ) {
      pipeFailed(
        `config refused: ${geom.width}x${geom.height} stride ${geom.stride} format ${geom.format} ` +
          `${geom.fpsNum}/${geom.fpsDen} (need NV12, stride == width)`,
      );
      return;
    }
    pipeInput.width = geom.width;
    pipeInput.height = geom.height;
    pipeInput.fpsNum = geom.fpsNum;
    pipeInput.fpsDen = geom.fpsDen;
    stdinLimit = (geom.width * geom.height * 3) / 2;
    fallback = null;
    // A publisher that re-sends config on the same connection must not orphan the previous ffmpeg.
    if (child) {
      const old = child;
      child = null;
      parser = null;
      killProcess(old);
    }
    if (log && typeof log.info === 'function') {
      log.info(
        `handfx camera: pipe ${pipeName} at ${geom.width}x${geom.height}@${geom.fpsNum}/${geom.fpsDen} NV12`,
      );
    }
    spawnChild(bin, pipeFfmpegArgs(cfg, geom));
  }

  /**
   * One NV12 payload from the publisher, written straight to ffmpeg's stdin. Backpressure is a
   * byte budget, not a queue: at most one frame may sit in Node's write buffer, so a stalled ffmpeg
   * makes the relay drop (and count) the newest frame instead of growing memory. The publisher does
   * the same to a slow client, and a late frame is worse than the newest one.
   *
   * `info.flags & 1` is NoSignal: the publisher says "the camera has no signal" and sends a black
   * frame. That is still a frame — the publisher is alive and ffmpeg should encode the black — so it
   * is fed normally; otherwise the stall watchdog would restart a healthy relay on a black camera.
   */
  function onPipeFrame(info, payload) {
    pipeInput.frames += 1;
    pipeInput.lastAt = Date.now();
    writeInput(payload);
  }

  function writeInput(payload) {
    const stdin = child && child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      // No producer yet: keep exactly one frame, newest wins.
      if (pipeLatest) pipeInput.dropped += 1;
      pipeLatest = Buffer.from(payload);
      return;
    }
    if (stdinLimit && stdin.writableLength >= stdinLimit) {
      pipeInput.dropped += 1;
      return;
    }
    try {
      stdin.write(payload);
    } catch {
      pipeInput.dropped += 1;
    }
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
    teardownPipe();
    mode = null;
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

  /** Drop the pipe client and the config deadline. Idempotent: a stop mid-connect must be safe. */
  function teardownPipe() {
    if (pipeConfigTimer) clearTimeout(pipeConfigTimer);
    pipeConfigTimer = null;
    const sock = pipeSocket;
    pipeSocket = null;
    stdinLimit = 0;
    pipeLatest = null;
    if (sock) {
      sock.removeAllListeners();
      sock.on('error', () => {});
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    }
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
    if (child || pipeSocket || !cfg.enabled || clients.size === 0) return;
    clearRestart();
    const bin = resolveBinary(cfg.ffmpegPath);
    if (!bin) {
      // Name what was asked for, so a wrong path is unmistakably a binary problem and never a
      // broken camera: the relay's error is the only thing the operator has to go on.
      const where = process.platform === 'win32' ? 'PATH and the usual Windows install folders' : 'PATH';
      fail(`ffmpeg not found: "${cfg.ffmpegPath}" (looked on ${where})`);
      return;
    }
    if (cfg.capture === 'dshow') {
      startDshow(bin);
      return;
    }
    startPipe(bin);
  }

  function sync() {
    const next = normalizeConfig(read());
    const changed =
      next.source !== cfg.source ||
      next.fps !== cfg.fps ||
      next.size !== cfg.size ||
      next.ffmpegPath !== cfg.ffmpegPath ||
      next.capture !== cfg.capture;
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
      const silent = silenceFor() > stallLimit();
      const reported = silent ? 'error' : state;
      const window = stderrWindow();
      const error =
        silent && !counters.error
          ? `no frame for ${Math.max(1, Math.round(silenceFor() / 1000))} s${mode === 'pipe' ? ` on pipe ${pipeName}` : ''}; argv: ${argvLine()}${window ? `; stderr: ${window}` : ''}`
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
        // Which capture path is actually running, what the publisher negotiated, and how many
        // frames it fed (or lost). `fallback` is the pipe failure `auto` recorded before it chose
        // dshow; it stays set until a later pipe attempt succeeds.
        capture: {
          setting: cfg.capture,
          mode: mode && (child || pipeSocket) ? mode : null,
          pipe: pipeName,
          format: pipeInput.width ? 'nv12' : null,
          width: pipeInput.width || null,
          height: pipeInput.height || null,
          fps: pipeInput.fpsNum ? `${pipeInput.fpsNum}/${pipeInput.fpsDen}` : null,
          inputFrames: pipeInput.frames,
          inputDropped: pipeInput.dropped,
          lastInputAt: pipeInput.lastAt || null,
          fallback,
        },
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
