// DirectShow camera inventory: what ffmpeg can open on this machine.
//
// SIDE EFFECT, and the reason this file is shaped the way it is: enumerating DirectShow launches the
// virtual-camera client DLLs (WebcamSwitcher, OBS, …) so they register their device. That is real
// work in other people's processes, so enumeration NEVER runs on a timer and NEVER runs from a
// status poll. It happens only when an explicit call asks for it, and the answer is then cached for
// 30 s so a UI that re-renders does not re-trigger it. `list()` is the only entry point that can
// switch the cameras on; nothing in this module does it on its own.
//
// The listing is ffmpeg stderr prose, not structured output (the `[in#0 @ ...]` tag is this build's;
// older builds print `[dshow @ ...]`, so the parser accepts any bracketed tag):
//   [in#0 @ 000001...] "WebcamSwitcher Virtual Camera (Windows Virtual Camera)" (video)
//   [in#0 @ 000001...]   Alternative name "@device_sw_vid_..."
//   [in#0 @ 000001...] "Streamfog VirtualCam" (none)
// Only `(video)` entries can be opened by `-f dshow -i video="…"`; every other marked entry is
// reported separately as `nonVideo`. `Alternative name` lines are GUID aliases for the line above,
// never devices of their own.
//
// ffmpeg resolution is the relay's (`resolveBinary`), so a missing binary is an error string here
// and not an ENOENT throw.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from './camera-relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TTL_MS = 30_000;
const ENUM_TIMEOUT_MS = 8_000;
const MAX_OUTPUT = 64 * 1024;
const MAX_NAME = 200;

const ARGS = ['-hide_banner', '-loglevel', 'info', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];

/** Substrings that mark a friendly name as a virtual camera, matched case-insensitively. */
const VIRTUAL_MARKERS = [
  'Windows Virtual Camera',
  'OBS Virtual Camera',
  'Virtual Camera',
  'VirtualCam',
  'VirtualCamera',
  'OBS-Camera',
];

// The bracket tag in front of each line is the *input stream*'s log context, and its name depends on
// the ffmpeg build, not on the device: 4.x/5.x print `[dshow @ 000002...]`, 6.x+ print
// `[in#0 @ 000001...]`. So take any bracketed tag and let the quoted name plus the `(video|none|audio)`
// suffix do the recognising — those are what actually mean "this is a device", and `Alternative name`
// lines have no suffix at all.

/** `[<any @ addr>] "Friendly name" (video|none|audio)`, anchored so `Alternative name` is skipped. */
const DEVICE_LINE = /^\s*\[[^\]]+\]\s+"([^"]{1,200})"\s+\((video|none|audio)\)\s*$/;

/** Proves stderr came from a device listing, without naming the demuxer or a build. */
const LISTING_MARKER =
  /^\s*\[[^\]]+\]\s+"[^"]+"\s+\((?:video|none|audio)\)\s*$|\bAlternative name\b|DirectShow (?:video|audio) devices/m;

let cache = null; // { at: epoch ms, value: result }

function readSettings() {
  const stateDir = process.env.SHOCKBOX_STATE || path.join(HERE, '..', '..', 'state');
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'handfx', 'settings.json'), 'utf8');
    const doc = JSON.parse(raw);
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

/** The configured `cameraRelaySource`, or null when nothing usable is stored. */
export function configuredSource() {
  const value = readSettings().cameraRelaySource;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** True for a friendly name that looks like a virtual camera. */
function isVirtual(name) {
  const lower = name.toLowerCase();
  return VIRTUAL_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Turn ffmpeg's stderr into `{ devices, nonVideo }`. `devices` is virtual-first, then physical;
 * first occurrence of an exact friendly name wins so `X (WebcamSwitcher)` and a raw `X` both
 * survive as distinct entries.
 */
export function parseListing(text) {
  const seen = new Set();
  const video = [];
  const nonVideo = [];

  for (const line of text.split(/\r?\n/)) {
    const match = DEVICE_LINE.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (!name || name.length > MAX_NAME) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = { name, virtual: isVirtual(name) };
    if (match[2] === 'video') video.push(entry);
    else nonVideo.push({ name, kind: match[2] });
  }

  const devices = [...video.filter((d) => d.virtual), ...video.filter((d) => !d.virtual)];
  return { devices, nonVideo };
}

/**
 * Run the lister once. Resolves, never rejects: every exit path below goes through `finish`, and
 * the 8 s timer is the only thing that can fire without the child having closed.
 */
function enumerate(ffmpegPath, platform = process.platform) {
  return new Promise((resolve) => {
    const bin = resolveBinary(ffmpegPath, process.env, platform);
    if (!bin) {
      resolve({ ok: false, error: `ffmpeg not found: ${ffmpegPath || 'ffmpeg'}` });
      return;
    }

    let stderr = '';
    let settled = false;
    let timer = null;
    let child = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(value);
    };

    try {
      child = spawn(bin, ARGS, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, error: `spawn failed: ${err.message}` });
      return;
    }

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.slice(0, MAX_OUTPUT - stderr.length);
    });
    child.stdout.resume();

    child.once('error', (err) => finish({ ok: false, error: `ffmpeg failed: ${err.message}` }));

    child.once('close', (code) => {
      const parsed = parseListing(stderr);
      const recognised = LISTING_MARKER.test(stderr);
      if (!recognised && parsed.devices.length === 0 && parsed.nonVideo.length === 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ');
        finish({ ok: false, error: `unrecognized ffmpeg output${tail ? `: ${tail}` : ''}`, code });
        return;
      }
      finish({ ok: true, ...parsed });
    });

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // The child is dead but its pipes could still hold the loop open if it wedged in the kernel;
      // detach them and unref the handle so a hung ffmpeg cannot keep this process alive.
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: 'enumerate timeout' });
    }, ENUM_TIMEOUT_MS);
  });
}

/**
 * Cached inventory. `cached: true` with `ageMs` inside the 30 s window; a cache miss or `force`
 * enumerates. A failed enumeration is never cached, so a retry is always a fresh attempt.
 */
export async function list({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) {
    return { ...cache.value, cached: true, ageMs: now - cache.at };
  }

  let result;
  try {
    const settings = readSettings();
    const ffmpegPath = String(settings.ffmpegPath || 'ffmpeg');
    result = await enumerate(ffmpegPath);
  } catch (err) {
    result = { ok: false, error: err && err.message ? err.message : String(err) };
  }

  if (result.ok) cache = { at: Date.now(), value: result };
  return { ...result, cached: false, ageMs: 0 };
}

/** Force a fresh enumeration, bypassing the TTL cache. */
export async function rescan() {
  return list({ force: true });
}
