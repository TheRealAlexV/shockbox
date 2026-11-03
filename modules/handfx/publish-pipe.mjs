// ShockBox serves the WebcamSwitcher frame pipe — the "ShockBox Virtual Camera" slot.
//
// Protocol, from src/WebcamSwitcher.Shared/WebcamSwitcherProtocol.h (the C# mirror is
// WebcamSwitcherProtocol.cs; the reader is src/WebcamSwitcher.Source/PipeFrameClient.cpp):
//
//   pipe     \\.\pipe\WebcamSwitcher.Frames.v1.shockbox   — we listen, the Frame Server connects
//   stream   [WsMsgHeader][payload], both little-endian, header 12 bytes:
//              magic 'WCVS' (0x57564353) | version 1 | type | payloadLen
//   type 1   Config, 24-byte payload: width height stride format fpsNum fpsDen (format 1 = NV12)
//            Must be the first message on every connection or the client hangs up and retries.
//   type 2   Frame, payload = 40-byte WsFrameInfo + pixels:
//              sequence u64 | timestampQpc u64 | width u32 | height u32 | stride u32 |
//              format u32 | payloadBytes u32 | flags u32
//
// The pixels are NV12 (Y plane, then interleaved U/V), stride == width, no padding. The client
// NEVER scales or converts: MediaStream copies min(payload, sampleSize) bytes straight into an
// NV12 sample and fills the rest with black, so a frame of the wrong size shows up as a picture
// in the corner of a black sample. The sample size is fixed by the media type the source
// advertises, which comes from C:\ProgramData\WebcamSwitcher\format.ini — so this file reads that
// same file and refuses frames that do not match it.
//
// Cadence: the client keeps the newest frame and its media stream pulls at its own 30 fps, so a
// late frame is repeated, never queued. There is nothing to pace here: we write what arrives,
// at most one message per client in flight (a newer frame while a write is pending is dropped and
// counted, which is the whole point of a latest-frame pipe).

import fs from 'node:fs';
import net from 'node:net';

export const PIPE_NAME = '\\\\.\\pipe\\WebcamSwitcher.Frames.v1.shockbox';
export const FORMAT_INI = 'C:\\ProgramData\\WebcamSwitcher\\format.ini';

const MAGIC = 0x57564353;
const VERSION = 1;
const TYPE_CONFIG = 1;
const TYPE_FRAME = 2;
const FORMAT_NV12 = 1;
const FLAG_NONE = 0;

const HDR = 12;
const CONFIG = 24;
const INFO = 40;

/** Frames per client that may be in the pipe before an older one is reused. */
const BUFFER_SLOTS = 3;

/** Target geometry + rate, as the virtual-camera source will advertise it. */
export function readGeometry(iniPath = process.env.SHOCKBOX_VPIPE_INI || FORMAT_INI) {
  const fmt = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 };
  let text = '';
  try {
    text = fs.readFileSync(iniPath, 'utf8');
  } catch {
    // No ini: the source falls back to its own defaults (1920x1080@30), so we do the same. The
    // two agree by construction, which is the only thing that matters here.
    return fmt;
  }
  for (const raw of text.split(/\r?\n/)) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    const n = Number(raw.slice(eq + 1).trim());
    if (!Number.isInteger(n) || n <= 0) continue;
    if (key === 'width') fmt.width = n;
    else if (key === 'height') fmt.height = n;
    else if (key === 'fps') fmt.fpsNum = n;
  }
  // NV12 is 4:2:0: both sides must be even or the chroma plane has no meaning.
  fmt.width &= ~1;
  fmt.height &= ~1;
  if (fmt.width < 16 || fmt.height < 16) return { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 };
  return fmt;
}

/**
 * RGBA → NV12 into `out` (which must hold width*height*3/2 bytes at pixel offset 0).
 * BT.601 studio swing (the source advertises MFNominalRange_16_235): Y 16..235, U/V 16..240.
 * Integer only and no clamping: the formulas are bounded by 16..235 / 16..240 for 8-bit input.
 */
export function nv12Into(rgba, width, height, out) {
  const w = width;
  const h = height;
  const ySize = w * h;
  let y = 0;
  let s = 0;
  for (let row = 0; row < h; row++) {
    const rowEnd = s + w * 4;
    while (s < rowEnd) {
      // Y = ((66R + 129G + 25B + 128) >> 8) + 16
      out[y++] = ((66 * rgba[s] + 129 * rgba[s + 1] + 25 * rgba[s + 2] + 128) >> 8) + 16;
      s += 4;
    }
  }
  // One chroma sample per 2x2 block, interleaved U then V.
  let uv = ySize;
  for (let row = 0; row < h; row += 2) {
    const rowA = row * w * 4;
    const rowB = rowA + w * 4;
    for (let col = 0; col < w; col += 2) {
      const a = rowA + col * 4;
      const b = rowB + col * 4;
      const r = rgba[a] + rgba[a + 4] + rgba[b] + rgba[b + 4];
      const g = rgba[a + 1] + rgba[a + 5] + rgba[b + 1] + rgba[b + 5];
      const bl = rgba[a + 2] + rgba[a + 6] + rgba[b + 2] + rgba[b + 6];
      // U = ((-38R - 74G + 112B) >> 8) + 128, V = ((112R - 94G - 18B) >> 8) + 128,
      // on the 4-pixel sum, hence the extra >> 2.
      out[uv++] = ((-38 * r - 74 * g + 112 * bl) >> 10) + 128;
      out[uv++] = ((112 * r - 94 * g - 18 * bl) >> 10) + 128;
    }
  }
}

function configMsg(geom) {
  const buf = Buffer.allocUnsafe(HDR + CONFIG);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt16LE(VERSION, 4);
  buf.writeUInt16LE(TYPE_CONFIG, 6);
  buf.writeUInt32LE(CONFIG, 8);
  buf.writeUInt32LE(geom.width, HDR);
  buf.writeUInt32LE(geom.height, HDR + 4);
  buf.writeUInt32LE(geom.width, HDR + 8); // stride: Y-plane bytes per row
  buf.writeUInt32LE(FORMAT_NV12, HDR + 12);
  buf.writeUInt32LE(geom.fpsNum, HDR + 16);
  buf.writeUInt32LE(geom.fpsDen, HDR + 20);
  return buf;
}

/**
 * The publisher. `off` opens nothing at all; `raw`/`effects` listen on the pipe and turn frames
 * handed in by the page into NV12 messages. A consumer that is absent, connects, or vanishes is
 * normal traffic here, never an error.
 */
export function createPublisher({ log = console, pipeName = process.env.SHOCKBOX_VPIPE || PIPE_NAME, iniPath } = {}) {
  let mode = 'off';
  let server = null;
  let geom = null;
  let pool = [];
  let sequence = 0;
  const clients = new Set();
  const stat = { frames: 0, dropped: 0, lastFrameAt: 0, error: null, opens: 0 };

  function geometry() {
    return { width: geom.width, height: geom.height, stride: geom.width, format: 'nv12', fps: geom.fpsNum / geom.fpsDen };
  }

  /** Silence longer than this, with a consumer attached, is a stalled publisher — not health. */
  const STALL_MS = 2000;

  /** Milliseconds since a frame last reached the pipe, null when none ever did. */
  function frameAge() {
    return stat.lastFrameAt ? Date.now() - stat.lastFrameAt : null;
  }

  function stage() {
    // Three different silences, three different names: nobody asked for frames (`off`), nobody is
    // reading them (`waiting` — the server drops them by design), or somebody is reading a pipe
    // the page stopped feeding (`stalled`).
    if (mode === 'off') return 'off';
    if (!clients.size) return 'waiting';
    // A fresh stage is a claim that frames moved. Nothing here may say `live` while `frames` has
    // sat still for longer than a frame or two: that is exactly a frozen camera behind a live pipe.
    const age = frameAge();
    return age !== null && age < STALL_MS ? 'live' : 'stalled';
  }

  function status() {
    return {
      stage: stage(),
      mode,
      frames: stat.frames,
      dropped: stat.dropped,
      lastFrameAt: stat.lastFrameAt,
      // The evidence behind `stalled`: frames frozen at a number with no age beside them reads as
      // health, which is how a stalled publisher sat at 2402 for six minutes.
      lastFrameAge: frameAge(),
      clients: clients.size,
      geometry: geom ? geometry() : null,
      error: stat.error,
    };
  }

  function drop(client) {
    client.dropped++;
    stat.dropped++;
  }

  function onClient(sock) {
    const client = { sock, busy: false, dropped: 0, frames: 0 };
    clients.add(client);
    stat.opens++;
    // The client requires Config first; it hangs up otherwise and retries with backoff.
    sock.on('error', () => {}); // a vanishing consumer is normal: never let it throw
    sock.on('close', () => clients.delete(client));
    try {
      sock.write(configMsg(geom));
    } catch {
      clients.delete(client);
      return;
    }
    log.info?.(`handfx publish: consumer connected (${clients.size} on the pipe)`);
  }

  function open() {
    if (server) return;
    geom = readGeometry(iniPath);
    const bytes = (geom.width * geom.height * 3) >> 1;
    pool = Array.from({ length: BUFFER_SLOTS }, () => {
      const buf = Buffer.allocUnsafe(HDR + INFO + bytes);
      buf.pending = 0;
      return buf;
    });
    server = net.createServer((sock) => onClient(sock));
    server.on('error', (err) => {
      // EADDRINUSE means something else owns the name (a stale twin), which is worth saying once.
      stat.error = `${err.code || 'error'}: ${err.message}`;
      log.warn?.(`handfx publish: pipe ${pipeName} unavailable — ${stat.error}`);
    });
    server.listen(pipeName, () => {
      stat.error = null;
      log.info?.(`handfx publish: serving ${pipeName} at ${geom.width}x${geom.height}@${geom.fpsNum}/${geom.fpsDen} NV12 (mode ${mode})`);
    });
  }

  function close() {
    for (const c of clients) {
      try {
        c.sock.destroy();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    if (server) {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      server = null;
    }
    pool = [];
    geom = null;
  }

  /**
   * Hand one picture to the pipe. `rgba` is width*height*4 bytes at the geometry the status
   * reports; `kind` must match the mode. Returns what happened, for the route's answer.
   * Nothing is converted while no consumer is connected: an absent camera costs zero CPU.
   */
  function publish(rgba, kind) {
    if (mode === 'off') return { ok: false, reason: 'off' };
    if (kind !== mode) return { ok: false, reason: 'mode', mode };
    if (!geom) return { ok: false, reason: 'not-open' };
    if (!clients.size) return { ok: true, stage: 'waiting', converted: false };
    const want = geom.width * geom.height * 4;
    if (!rgba || rgba.length !== want) return { ok: false, reason: 'size', expected: want, got: rgba ? rgba.length : 0 };

    const slot = pool.find((b) => b.pending === 0);
    if (!slot) {
      // Every slot is still going out: this picture is already stale. Drop it, do not queue.
      stat.dropped++;
      return { ok: true, stage: stage(), converted: false, reason: 'busy' };
    }
    const ySize = geom.width * geom.height;
    nv12Into(rgba, geom.width, geom.height, slot.subarray(HDR + INFO, HDR + INFO + ((ySize * 3) >> 1)));
    // Header + info describe this message; the payload follows at HDR + INFO.
    slot.writeUInt32LE(MAGIC, 0);
    slot.writeUInt16LE(VERSION, 4);
    slot.writeUInt16LE(TYPE_FRAME, 6);
    slot.writeUInt32LE(INFO + ((ySize * 3) >> 1), 8);
    slot.writeBigUInt64LE(BigInt(sequence++), HDR);
    slot.writeBigUInt64LE(process.hrtime.bigint() / 100n, HDR + 8); // 100-ns units, like QPC
    slot.writeUInt32LE(geom.width, HDR + 16);
    slot.writeUInt32LE(geom.height, HDR + 20);
    slot.writeUInt32LE(geom.width, HDR + 24);
    slot.writeUInt32LE(FORMAT_NV12, HDR + 28);
    slot.writeUInt32LE((ySize * 3) >> 1, HDR + 32);
    slot.writeUInt32LE(FLAG_NONE, HDR + 36);

    let wrote = 0;
    for (const c of clients) {
      if (c.busy) {
        drop(c);
        continue;
      }
      c.busy = true;
      c.frames++;
      wrote++;
      slot.pending++;
      try {
        c.sock.write(slot, (err) => {
          c.busy = false;
          slot.pending--;
          if (err) clients.delete(c);
        });
      } catch {
        c.busy = false;
        slot.pending--;
        clients.delete(c);
      }
    }
    if (!wrote) {
      stat.dropped++;
      return { ok: true, stage: stage(), converted: false, reason: 'busy' };
    }
    stat.frames += wrote;
    stat.lastFrameAt = Date.now();
    return { ok: true, stage: stage(), converted: true, sent: wrote };
  }

  function setMode(next) {
    const want = next === 'raw' || next === 'effects' ? next : 'off';
    if (want === mode) return mode;
    mode = want;
    if (mode === 'off') {
      close();
      log.info?.('handfx publish: off — the pipe is closed and nothing is converted');
    } else {
      open();
    }
    return mode;
  }

  function dispose() {
    mode = 'off';
    close();
  }

  return { setMode, publish, status, dispose, get mode() { return mode; } };
}
