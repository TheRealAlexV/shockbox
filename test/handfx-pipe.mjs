// The relay's pipe capture path, without the camera and without a browser.
//
// A fake WebcamSwitcher publisher writes the documented wire format (WebcamSwitcherProtocol.h) to a
// local socket/pipe and the real relay reads it, so this proves the whole path end to end with real
// ffmpeg:
//   · config then N NV12 frames → capture.mode is `pipe`, the negotiated geometry is reported and
//     the page receives real MJPEG parts
//   · a config message and a frame split across chunk boundaries still parse
//   · a missing pipe is reported honestly (name + reason) and reconnects once the publisher appears
//   · a stalled ffmpeg stdin drops frames and keeps at most one frame buffered
//   · `auto` falls back to dshow only after a pipe attempt fails, and says so
//
//   node test/handfx-pipe.mjs
// Exits non-zero on the first failed group of checks.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import {
  createCameraRelay,
  createPipeParser,
  normalizeConfig,
} from '../modules/handfx/camera-relay.mjs';

const WIN = process.platform === 'win32';
const FRAME_W = 64;
const FRAME_H = 48;
const FRAME_BYTES = (FRAME_W * FRAME_H * 3) / 2;
const MAGIC = 0x57564353;
const TEMP_DIR = WIN ? null : process.env.SHOCKBOX_PIPE_DIR || '/tmp/opencode';
const stamp = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pipeName(tag) {
  const name = `shockbox-pipe-${stamp}-${tag}`;
  if (WIN) return `\\\\.\\pipe\\${name}`;
  return path.join(TEMP_DIR, `${name}.sock`);
}

/** The publisher's messages, byte for byte: 12-byte header, little-endian, packed. */
function configMsg({ width, height, fpsNum = 30, fpsDen = 1 }) {
  const buf = Buffer.alloc(12 + 24);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt16LE(1, 4);
  buf.writeUInt16LE(1, 6);
  buf.writeUInt32LE(24, 8);
  buf.writeUInt32LE(width, 12);
  buf.writeUInt32LE(height, 16);
  buf.writeUInt32LE(width, 20); // stride == width
  buf.writeUInt32LE(1, 24); // NV12
  buf.writeUInt32LE(fpsNum, 28);
  buf.writeUInt32LE(fpsDen, 32);
  return buf;
}

function frameMsg(sequence, { flags = 0 } = {}) {
  const info = Buffer.alloc(12 + 40);
  info.writeUInt32LE(MAGIC, 0);
  info.writeUInt16LE(1, 4);
  info.writeUInt16LE(2, 6);
  info.writeUInt32LE(40 + FRAME_BYTES, 8);
  info.writeBigUInt64LE(BigInt(sequence), 12);
  info.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 20);
  info.writeUInt32LE(FRAME_W, 28);
  info.writeUInt32LE(FRAME_H, 32);
  info.writeUInt32LE(FRAME_W, 36);
  info.writeUInt32LE(1, 40);
  info.writeUInt32LE(FRAME_BYTES, 44);
  info.writeUInt32LE(flags, 48);
  // A picture with movement, so the encoder emits a different JPEG each time.
  const px = Buffer.alloc(FRAME_BYTES);
  px.fill((sequence * 7) & 0xff, 0, FRAME_W * FRAME_H);
  px.fill((sequence * 3) & 0xff, FRAME_W * FRAME_H);
  return Buffer.concat([info, px]);
}

/**
 * A publisher that emits config + `count` frames on every connection, optionally splitting the
 * first config and first frame across writes. Frames are paced at 30 fps like the real publisher
 * (a synchronous burst would be dropped by the relay's one-frame backpressure budget, which is the
 * behaviour section 5 tests on purpose).
 */
function publisher(name, { count = 30, split = false, flags = 0, intervalMs = 33 } = {}) {
  const conns = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => conns.delete(sock));
    const cfg = configMsg({ width: FRAME_W, height: FRAME_H });
    if (split) {
      sock.write(cfg.subarray(0, 5));
      sock.write(cfg.subarray(5));
    } else {
      sock.write(cfg);
    }
    let i = 0;
    const tick = () => {
      if (!conns.has(sock) || i >= count) return;
      const msg = frameMsg(i, { flags });
      if (split && i === 0) {
        const cut = 12 + 40 + Math.floor(FRAME_BYTES / 2);
        sock.write(msg.subarray(0, cut));
        sock.write(msg.subarray(cut));
      } else {
        sock.write(msg);
      }
      i += 1;
      setTimeout(tick, intervalMs).unref?.();
    };
    tick();
  });
  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(name, () => resolve());
      }),
    stop: () => {
      for (const s of conns) {
        try {
          s.destroy();
        } catch {
          /* gone */
        }
      }
      conns.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** What /camera/stream would be: a writable that keeps the multipart bytes. */
function sink() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.collected = () => Buffer.concat(chunks);
  return res;
}

function jpegParts(bytes) {
  let count = 0;
  let at = bytes.indexOf('Content-Type: image/jpeg');
  while (at >= 0) {
    count += 1;
    at = bytes.indexOf('Content-Type: image/jpeg', at + 1);
  }
  return count;
}

async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
}

function relayFor(name, extra = {}) {
  const relay = createCameraRelay({
    read: () => ({ enabled: true, size: '320x180', fps: 30, capture: 'pipe', ...extra.read }),
    pipePath: name,
    ...extra,
  });
  return relay;
}

async function main() {
  console.log('handfx pipe capture');

  // ── 1. parser: arbitrary chunk boundaries ────────────────────────────────────────────────────
  {
    const seen = { configs: 0, frames: 0, geom: null };
    const parser = createPipeParser({
      onConfig: (g) => {
        seen.configs += 1;
        seen.geom = g;
      },
      onFrame: () => {
        seen.frames += 1;
      },
    });
    const cfg = configMsg({ width: 64, height: 48 });
    const frame = frameMsg(7);
    // One byte at a time for the config, then the frame split mid-header and mid-payload.
    for (const byte of cfg) parser.push(Buffer.from([byte]));
    parser.push(frame.subarray(0, 9));
    parser.push(frame.subarray(9, 12 + 20));
    parser.push(frame.subarray(12 + 20, 12 + 40 + 100));
    parser.push(frame.subarray(12 + 40 + 100));
    check('parser: byte-split config yields exactly one config', seen.configs === 1, `got ${seen.configs}`);
    check(
      'parser: byte-split config geometry',
      seen.geom && seen.geom.width === 64 && seen.geom.height === 48 && seen.geom.stride === 64,
      JSON.stringify(seen.geom),
    );
    check('parser: frame split at three points still yields one frame', seen.frames === 1, `got ${seen.frames}`);
    check(`parser: nothing buffered after complete messages (${parser.buffered} B)`, parser.buffered === 0);
  }

  // ── 2. end to end: pipe → ffmpeg → MJPEG parts ───────────────────────────────────────────────
  {
    const name = pipeName('live');
    const pub = publisher(name, { count: 30 });
    await pub.listen();
    const relay = relayFor(name);
    const res = sink();
    relay.addClient(res);
    await waitFor(() => relay.status().frames >= 5, 20000, 'five JPEG frames');
    await waitFor(() => relay.status().capture.inputFrames >= 30, 10000, 'thirty publisher frames');
    const st = relay.status();
    check(`e2e: capture.mode is pipe (${st.capture.mode})`, st.capture.mode === 'pipe', st.error || '');
    check(
      `e2e: negotiated geometry ${st.capture.width}x${st.capture.height}@${st.capture.fps}`,
      st.capture.width === 64 && st.capture.height === 48 && st.capture.fps === '30/1',
      JSON.stringify(st.capture),
    );
    check(`e2e: capture.setting reports the forced path (${st.capture.setting})`, st.capture.setting === 'pipe');
    check(`e2e: publisher frames counted (${st.capture.inputFrames} in)`, st.capture.inputFrames >= 30);
    const parts = res.collected();
    const counted = jpegParts(parts);
    const first = parts.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const eoi = parts.indexOf(Buffer.from([0xff, 0xd9]), first);
    check(`e2e: ${counted} multipart JPEG parts, ${parts.length} bytes`, counted >= 5 && parts.length > 2000);
    check('e2e: a part is a real JPEG (SOI … EOI)', first >= 0 && eoi > first);
    relay.dispose();
    await pub.stop();
    check('e2e: cleanup leaves no socket', WIN || !fs.existsSync(name));
  }

  // ── 3. split messages end to end ─────────────────────────────────────────────────────────────
  {
    const name = pipeName('split');
    const pub = publisher(name, { count: 20, split: true });
    await pub.listen();
    const relay = relayFor(name);
    const res = sink();
    relay.addClient(res);
    await waitFor(() => relay.status().frames >= 3, 20000, 'split-message frames');
    await waitFor(() => relay.status().capture.inputFrames >= 20, 10000, 'twenty split frames');
    const st = relay.status();
    check(
      `split: config split across reads still parsed (${st.capture.width}x${st.capture.height}, ${st.capture.inputFrames} frames)`,
      st.capture.mode === 'pipe' && st.capture.width === 64 && st.capture.inputFrames >= 20,
      st.error || '',
    );
    check(`split: ${jpegParts(res.collected())} JPEG parts`, jpegParts(res.collected()) >= 3);
    relay.dispose();
    await pub.stop();
  }

  // ── 4. missing pipe: honest error, then reconnect ────────────────────────────────────────────
  {
    const name = pipeName('missing');
    const relay = relayFor(name);
    const res = sink();
    relay.addClient(res);
    const errored = await waitFor(
      () => {
        const st = relay.status();
        // A forced pipe never exhausts to 'failed' (that is the `auto` budget): the failure shows
        // as the first stall and then the armed restart.
        return st.state === 'stalled' || st.state === 'restarting' ? st : null;
      },
      5000,
      'honest pipe error',
    ).catch(() => null);
    check(
      'missing: error names the pipe and the reason',
      Boolean(errored) && errored.error.includes(name) && /connect failed/.test(errored.error),
      errored ? errored.error : 'no error reported',
    );
    check('missing: mode is null while the pipe is unreachable', !relay.status().capture.mode);
    const pub = publisher(name, { count: 30 });
    await pub.listen();
    const recovered = await waitFor(
      () => {
        const st = relay.status();
        return st.capture.mode === 'pipe' && st.frames > 0 ? st : null;
      },
      20000,
      'reconnect after the publisher appears',
    ).catch(() => null);
    check(
      'missing: reconnects with backoff once the publisher exists',
      Boolean(recovered) && recovered.capture.width === 64,
      recovered ? '' : relay.status().error || 'no frame',
    );
    relay.dispose();
    await pub.stop();
  }

  // ── 5. stalled stdin: drop, do not buffer ────────────────────────────────────────────────────
  {
    const name = pipeName('stall');
    const pub = publisher(name, { count: 30 });
    await pub.listen();
    const spawned = [];
    // A producer that never drains: the first write fills highWaterMark, every later frame must be
    // dropped rather than queued.
    const fakeSpawn = () => {
      const proc = new EventEmitter();
      proc.stdin = new Writable({
        highWaterMark: 1,
        write() {
          /* never calls back: ffmpeg is stuck */
        },
      });
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {};
      spawned.push(proc);
      return proc;
    };
    const relay = relayFor(name, { spawn: fakeSpawn });
    relay.addClient(sink());
    const st = await waitFor(
      () => {
        const s = relay.status();
        return s.capture.inputFrames >= 30 ? s : null;
      },
      10000,
      'thirty publisher frames',
    ).catch(() => null);
    const proc = spawned[0];
    const buffered = proc ? proc.stdin.writableLength : -1;
    check(
      `stall: ${st ? st.capture.inputDropped : 0} frames dropped instead of buffered`,
      Boolean(st) && st.capture.inputDropped >= 25,
      st ? JSON.stringify(st.capture) : 'no frames',
    );
    check(
      `stall: stdin holds at most one frame (${buffered} B ≤ ${FRAME_BYTES} B)`,
      buffered >= 0 && buffered <= FRAME_BYTES,
      `buffered ${buffered}`,
    );
    relay.dispose();
    await pub.stop();
  }

  // ── 6. auto: fall back to dshow only after the pipe attempt fails, and say so ───────────────
  {
    const name = pipeName('auto');
    const calls = [];
    const fakeSpawn = (bin, args) => {
      calls.push(args);
      const proc = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {};
      return proc;
    };
    const relay = createCameraRelay({
      read: () => ({ enabled: true, size: '320x180', fps: 30, capture: 'auto' }),
      pipePath: name,
      spawn: fakeSpawn,
    });
    relay.addClient(sink());
    const st = await waitFor(
      () => {
        const s = relay.status();
        return s.capture.mode === 'dshow' ? s : null;
      },
      5000,
      'auto fallback',
    ).catch(() => null);
    check(`auto: mode is dshow after the pipe failed (${st ? st.capture.mode : 'none'})`, Boolean(st));
    check(
      `auto: fallback records the pipe and the reason`,
      Boolean(st) && st.capture.fallback && st.capture.fallback.includes(name) && /connect failed/.test(st.capture.fallback),
      st ? String(st.capture.fallback) : '',
    );
    check(
      `auto: the dshow argv is the old path (${calls.length} spawn)`,
      calls.length === 1 && calls[0].includes('dshow'),
    );
    check('auto: default capture setting is auto', normalizeConfig({}).capture === 'auto');
    relay.dispose();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

try {
  await main();
} finally {
  if (!WIN) {
    for (const f of fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR) : []) {
      if (f.startsWith(`shockbox-pipe-${stamp}`)) {
        try {
          fs.unlinkSync(path.join(TEMP_DIR, f));
        } catch {
          /* gone */
        }
      }
    }
  }
}
