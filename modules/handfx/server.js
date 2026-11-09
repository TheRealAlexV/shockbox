// ShockFX module (id `handfx`) — the server half.
//
// What the server owns (and what it deliberately does not):
//
//   owns      the operator's settings (enable, effect order, per-effect intensity, sensitivity,
//             mirror, camera device, resolution, debug overlay), the command bus, and the
//             runtime-asset routes the page loads MediaPipe from.
//   does not  track, render, or learn any live parameter. There is no frame, no landmark and no
//             "current hand" anywhere in this file. The page holds the camera and the tracker;
//             the server cannot see either.
//
// Why the bus exists at all: the Stream Deck drives `effect.next` / `effect.prev` / `effect.set` /
// `tracking.toggle` / `mirror.toggle` / `reload`, and a deck key is a http POST. Commands are
// published on the `handfx` channel with a ring, so a page that reconnects replays what it missed
// (the page ignores commands older than its own mount time for one-shot actions).
//
// Runtime assets: MediaPipe Tasks Vision is vendored under `vendor/` (see vendor/README) and
// served from the module, not a CDN, because the page is cross-origin isolated (COOP/COEP) and a
// third-party script would need CORP to load at all. The model is fetched once and kept in Cache
// Storage by the page (`handfx:models-v1`).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublisher } from './publish-pipe.mjs';
import { BOUNDARY, createCameraRelay } from './camera-relay.mjs';
// The document identity a request declares (`?role=`) or inherits (its `Referer` path), shared with
// the SSE hub so both long-lived responses are superseded by the same rule.
import { roleOf, refPath, validRole, clientIdOf } from '../../core/events.mjs';
// Enumeration launches the virtual-camera client DLLs, so it is only ever reached from the two
// explicit /cameras routes — never from `status()`, which the pane polls at 1 Hz.
import { list as listCameras, rescan as rescanCameras, configuredSource } from './camera-list.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The build this server serves, and the one the page reports back on /ack.
 *
 * Derived, never hand-maintained: a hash over every file under `pages/` (the overlay, the body
 * page, their engine and styles). It is a content identity, so it changes exactly when the bundle
 * the browser runs changes, and it survives the Windows deploy, which excludes `.git` (a sha read
 * at runtime would fall back to a constant there and never catch a stale bundle). The page is
 * loaded with `?v=<BUILD>`, so a document left running from yesterday keeps yesterday's value and
 * `/status.buildMatches` goes false.
 *
 * The identity is the *content*, so everything fed into the hash must be platform-free: the name
 * goes in as a POSIX path (a Windows `path.relative` returns `pages\js\...`, which used to make
 * the rig's install hash differently from a checkout of the same commit) and the sort is by code
 * unit, not `localeCompare` (which reads the process locale). Only `pages/` — the bundle the
 * browser runs — is hashed; `vendor/`, `models/` and anything else outside it is not source.
 */
function bundleBuild() {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else h.update(path.relative(HERE, file).split(/[\\/]/).join('/')).update('\0').update(fs.readFileSync(file));
    }
  };
  try {
    walk(path.join(HERE, 'pages'));
    // The module's own server source is part of what the rig runs, so it is part of the identity.
    // Hashing only `pages/` let a `server.js` or `camera-relay.mjs` deploy leave BUILD untouched,
    // and a hash that quietly covers half the tree is the same trap as no witness at all.
    for (const name of fs.readdirSync(HERE).sort()) {
      if (!/\.m?js$/.test(name)) continue;
      h.update(name).update('\0').update(fs.readFileSync(path.join(HERE, name)));
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

export const BUILD = bundleBuild();

/** A page that has not acked for this long is not reporting what it is doing: its source is `stale`. */
const PAGE_STALE_MS = 5000;
/**
 * A render loop silent for this long is not ticking. The loop runs at display rate (60+/s); 2 s is
 * over a hundred missed frames, well past a GC pause, and short enough that an operator sees it
 * before the show does. Its beat is independent of `PAGE_STALE_MS`: the page can be alive and
 * reporting while Chrome gives its document no frames to draw.
 */
const LOOP_STALE_MS = 2000;

/**
 * A page ack older than this is not the page's current answer for the feed truth table
 * (`pageTruth`). Ten seconds is roughly ten heartbeat periods: long enough that a GC pause or a
 * single dropped request is not a fault, short enough that a dead document is caught while the
 * operator is still looking at the wrong picture.
 */
const PAGE_FRESH_MS = 10_000;
/**
 * A beat older than this is not from a live page. The beat is an `<img>` GET on a 1 s timer — no
 * fetch, no body, no socket held — so five missed beats is a page that is gone, not a slow one.
 * This is what makes `pageTruth` able to say *mute* (beats fresh, acks stale) rather than guessing
 * between "busy" and "dead".
 */
const PAGE_BEAT_STALE_MS = 5000;
/**
 * A camera reader is *consuming* when the relay handed it a frame this recently. The relay's
 * `sent` counter only advances when the previous frame's bytes left Node's queue (a `write()` that
 * returned true, or a `drain` that arrived after one that returned false). A page that stopped
 * reading cannot satisfy this: its kernel send buffer fills within a frame or two, `write()` starts
 * returning false, no `drain` ever comes, and the counter freezes while the camera keeps producing.
 * Its own TCP window is the clock — nothing the page can fake from JS.
 */
const STREAM_LIVE_MS = 2500;
/**
 * How long a reader may sit in backpressure before it is not consuming. One frame at the relay's
 * configured rate is tens of milliseconds; a second and a half is ~45 missed frames, far past any
 * GC pause, and short enough that a frozen page is caught while the operator is still watching.
 */
const STREAM_BLOCKED_MAX_MS = 1500;
/** A reader whose unflushed queue is this deep is not draining it, whatever its counters say. */
const STREAM_BUFFER_MAX = 1024 * 1024;
/**
 * The document that decides the headline verdict. The OBS browser source is served at `/shockfx`,
 * and a page's role is its `location.pathname`, so this is the page the operator watches. Other
 * roles are reported beside it and can never answer in its place.
 */
const HEADLINE_ROLE = '/shockfx';
/**
 * A client that has neither acked nor beaten for this long is not a candidate for its role's
 * verdict, however recent a single ack looked. The page acks every 500 ms (`ACK_MS` in
 * pages/js/overlay/main.js) and beats every 1000 ms (`BEAT_MS`), so this is twenty missed acks and
 * ten missed beats — the same line `PAGE_FRESH_MS` already draws for "is this page current". The
 * entry stays in `clientList` until `CLIENTS_TTL_MS`; it just stops answering for its role.
 */
const CLIENT_CANDIDATE_MS = PAGE_FRESH_MS;
/** A per-client ack entry is forgotten after this much silence: a closed tab is not a client. */
const CLIENTS_TTL_MS = 10 * 60 * 1000;
/**
 * A client silent this long is reaped: its long-lived responses are ended and its row dropped.
 * Chosen as the 120 s camera cap plus one 25 s build-poll cycle plus margin. A live document
 * cannot be silent that long; a frozen one will never be heard from again, and it cannot free the
 * socket it still holds (its build poll runs inside the render loop it lost). Reaping on silence,
 * not on the page's cooperation, is what makes the six-per-origin budget self-healing.
 */
const CLIENT_REAP_MS = 180_000;
/**
 * A registered client whose `lastAckAt` has not moved for this long is a document that no longer
 * exists: at the page's 500 ms cadence this is 120 missed acks, six times `PAGE_FRESH_MS` and a
 * third of `CLIENT_REAP_MS`. Long enough that a throttled timer or a GC pause cannot trip it;
 * short enough that a duplicate removed from OBS hours ago stops being counted as a client and
 * stops holding a reader slot. The census flags `ack-stale` from this line only when the beat is
 * stale too (see `violationsNow`), and it is the only
 * line the registry prunes on: hidden is not a prune reason (a non-composited source still acks)
 * and neither is a beat, so `page-mute` stays diagnosable for this window and then goes.
 */
const CLIENT_ACK_GONE_MS = 60_000;
/**
 * The long-lived responses one document may declare: its one bus response (`/events`) and at most
 * one camera stream (`main.js` opens the stream only when the camera is wanted). More than this
 * under one `clientId` is a leaked predecessor, and the census names it.
 */
const LONG_LIVED_PER_CLIENT = 2;
/**
 * CEF's per-origin socket cap: six. At six, a page has no slot left for its ack POST or its beat
 * `<img>`, so the census names that state instead of letting it read as a starved page.
 */
const SOCKET_BUDGET = 6;
/**
 * The worker's own clock. `workerTicks` counts ticks posted from the page's ack worker, a thread
 * the render loop cannot occupy; `workerTickAt` is when the last one landed. Kept as a counter
 * rather than a log line so a freeze can be bracketed by two independent timelines without adding
 * two lines a second to the log.
 */
let workerTicks = 0;
let workerTickAt = 0;
/** The worker's own view of its clock: inter-tick gap, and ticks since its last successful POST. */
let workerTickGapMs = 0;
let workerTickSinceOk = 0;
/** Which thread last acked, and when: page main thread or ack worker. */
let ackVia = null;
let ackViaAt = 0;
/**
 * Both sides of the ack, counted where they happen. `ackRequests` is incremented before any
 * handler logic so it counts arrivals, not successes; `touchClientCalls` counts what the handler
 * actually ran; `ackNewClient` counts acks whose clientId had no row yet, which is the identity
 * mismatch that would answer "2xx returned, lastAckAt frozen".
 */
let ackRequests = 0;
let touchClientCalls = 0;
let ackNewClient = 0;
/** The worker's own report of its ack attempts, carried on the tick it posts every 500 ms. */
let workerAckStats = null;
/** One log line when an established client goes quiet for this long — never one per poll. */
const CLIENT_SILENT_MS = 30_000;
// No server-held connection may outlive CAMERA_MAX_MS, so a document that vanished without closing
// anything loses its pool slot on a timer rather than never. CEF holds the old socket ESTABLISHED
// and keeps accepting frames, so no inactivity timeout can tell it from a live viewer. 2 min is
// ~3600 frames at 30 fps: the page already reconnects for its own reasons (pagehide, a 3 s stall),
// so one extra clean close every two minutes is not new behaviour, and a leaked slot is returned to
// the 6-connection pool while the operator still cares. SHOCKBOX_STREAM_MAX_MS is the test hook,
// shared with the SSE cap in core/events.mjs.
const CAMERA_MAX_MS = Number(process.env.SHOCKBOX_STREAM_MAX_MS) || 120_000;

/**
 * Every command the bus accepts. `reload` and the effect cursor are handled by the page;
 * `projectile.fire` and `edit.clear` are one-shots the page acts on. Nothing here is tracked.
 */
export const CMDS = [
  'effect.next',
  'effect.prev',
  'effect.set',
  'tracking.toggle',
  // The admin pane's three controls: `{mode: 'camera' | 'synthetic' | 'off'}`. Same publish-only
  // path as `tracking.toggle`; the page owns what it does with it.
  'tracking.set',
  'mirror.toggle',
  'projectile.fire',
  'edit.clear',
  'reload',
];

/**
 * The effect registry as the server knows it: ids only, never parameters, in the renderer's own
 * order (`pages/js/engine/fx.js` → `EFFECTS`). The page has the implementations; the pane shows
 * this list so the operator can order the module's effect list without opening the page.
 * `gesture` is documentation for the pane, not a contract — the page maps the classifier's own
 * gesture names onto these ids. `handdebug` is not an effect: the camera/landmark picture is the
 * `debugOverlay` setting. `edit` is the operator's hand-drawn canvas, `shoot` the projectile skin.
 */
export const EFFECTS = [
  { id: 'fireball', title: 'Fireball', gesture: 'open palm up', from: 'fireball-controller/main.py' },
  { id: 'lightning', title: 'Lightning fingers', gesture: 'both hands, fingertips arched together', from: 'handfx_filter (ShockFX)' },
  { id: 'sparkring', title: 'Spark ring', gesture: 'open palm towards the camera', from: 'handfx_filter (ShockFX)' },
  { id: 'embers', title: 'Ember rise', gesture: 'any hand', from: 'handfx_filter (ShockFX)' },
  { id: 'smoke', title: 'Smoke veil', gesture: 'sideways hand / swipe', from: 'handfx_filter (ShockFX)' },
  { id: 'aura', title: 'Aura outline', gesture: 'any hand', from: 'handfx_filter (ShockFX)' },
  { id: 'wires', title: 'Wire skeleton', gesture: 'any hand (follows the skeleton)', from: 'handfx_filter (ShockFX)' },
  { id: 'frost', title: 'Frost creep', gesture: 'open palm towards the camera', from: 'handfx_filter (ShockFX)' },
  { id: 'portal', title: 'Portal ring', gesture: 'open palm towards the camera', from: 'handfx_filter (ShockFX)' },
  { id: 'disco', title: 'Disco ball', gesture: 'both hands raised', from: 'handfx_filter (ShockFX)' },
  { id: 'slime', title: 'Slime drip', gesture: 'palms together', from: 'handfx_filter (ShockFX)' },
  { id: 'inkflow', title: 'Ink flow', gesture: 'swipe', from: 'handfx_filter (ShockFX)' },
  { id: 'shatter', title: 'Shatter shards', gesture: 'fist', from: 'handfx_filter (ShockFX)' },
  { id: 'cyber', title: 'Cyber glitch', gesture: 'fist', from: 'handfx_filter (ShockFX)' },
  { id: 'bloomlife', title: 'Bloom life', gesture: 'both palms up', from: 'handfx_filter (ShockFX)' },
  { id: 'echo', title: 'Echo trails', gesture: 'any hand', from: 'handfx_filter (ShockFX)' },
  { id: 'bodyonfire', title: 'Body on fire', gesture: 'body page sees a body', from: 'ShockFX body page (PoseLandmarker)' },
  { id: 'bodysmoke', title: 'Body smoke', gesture: 'body page sees a body', from: 'ShockFX body page (PoseLandmarker)' },
  { id: 'frozenbody', title: 'Frozen body', gesture: 'body page sees a body', from: 'ShockFX body page (PoseLandmarker)' },
  { id: 'edit', title: 'Hand edit', gesture: 'fist (draws where the fingertips point)', from: 'handfx_filter (ShockFX)' },
  { id: 'electroshock', title: 'Electro shockwave', gesture: 'open palm towards the camera', from: 'handfx_filter (ShockFX)' },
  { id: 'meteor', title: 'Meteor', gesture: 'both hands raised', from: 'handfx_filter (ShockFX)' },
  { id: 'shoot', title: 'Shoot', gesture: 'point (index only)', from: 'handfx_filter (ShockFX)' },
];

/** Projectile skins `shoot` may wear; the renderer's registry accepts exactly these two. */
export const SKINS = ['projectile', 'heart'];

const VENDOR = path.join(HERE, 'vendor');
// The model search order: the module's own models dir (gitignored — models are licensed per
// machine and large), then the repo's bake-off copy (not shipped), then the page fetches from
// the model URL below and caches it. Serving a local model keeps the overlay offline.
// The module's own models dir wins; then the OBS project's copy, which is where the rig keeps
// hand_landmarker.task already (the same Apache-2.0 file), so a first install needs no download.
const MODEL_DIRS = [path.join(HERE, 'models'), path.resolve(HERE, '../../..', 'handfx-bakeoff/models')];
const MODEL_NAME = 'hand_landmarker.task';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
// The body page's models: one pose model (33 landmarks) and one segmentation model (the mask).
// Both are Apache-2.0 from the same MediaPipe model garden; the same MODEL_DIRS search applies.
const POSE_NAME = 'pose_landmarker_lite.task';
const POSE_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const SEG_NAME = 'selfie_segmenter.tflite';
const SEG_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function findModel() {
  return findIn(MODEL_NAME);
}

/** The first MODEL_DIRS entry that holds `name`, or null. */
function findIn(name) {
  for (const dir of MODEL_DIRS) {
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Whether the body page's two models are on disk (`local`) or must be downloaded once. */
function bodyModels() {
  const pose = findIn(POSE_NAME);
  const seg = findIn(SEG_NAME);
  return {
    pose: { local: Boolean(pose), name: POSE_NAME, url: POSE_URL },
    segmenter: { local: Boolean(seg), name: SEG_NAME, url: SEG_URL },
    local: Boolean(pose && seg),
  };
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Where the overlay finds each runtime file. The SDK decides its wasm paths from the fileset
 * directory (`{dir}/vision_wasm_internal.js` next to `{dir}/vision_wasm_internal.wasm`), but
 * 0.10.14 loads BOTH the loader and the binary as classic scripts, and a page cannot `eval` a
 * classically loaded wasm loader (top-level `await` is a SyntaxError — verified). So the page is
 * handed paths that are not directory siblings and this table is the whole mapping, not a guess.
 */
const VENDOR_ALIASES = {
  'vision-runtime/wasm/vision_wasm_internal.js': 'vision/wasm/vision_wasm_internal.js',
  'vision-runtime/wasm/vision_wasm_internal.wasm': 'vision/simd-wasm/vision_wasm_internal.wasm',
  'vision-runtime-nosimd/wasm/vision_wasm_nosimd_internal.js': 'vision/wasm-nosimd/vision_wasm_nosimd_internal.js',
  'vision-runtime-nosimd/wasm/vision_wasm_nosimd_internal.wasm': 'vision/wasm-nosimd/vision_wasm_nosimd_internal.wasm',
};

/** Serve one file out of the vendor directory, never escaping it. */
function serveVendor(res, req, rel, { immutable = false } = {}) {
  const clean = String(rel || '').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return false;
  const file = path.join(VENDOR, VENDOR_ALIASES[clean] || clean);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // The runtime never changes under a versioned URL (the page imports it versioned); the
    // 9 MB wasm is the one asset that must not be re-downloaded for every page load.
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': st.size,
    'cross-origin-resource-policy': 'same-origin',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

function build(ctx) {
  const { events, log } = ctx;
  const settings = ctx.settings;
  let lastCmd = null;
  // The ratio this page draws. `default` follows the show-wide core ratio, exactly like the wall,
  // the dialogs and the notifications, so one global value drives every surface. Resolved on every
  // read, never stored: a `default` left in a settings document must not freeze an old resolution.
  const effectiveRatio = () => {
    const own = settings.get('ratio');
    if (own === '9:16' || own === '16:9') return own;
    const core = ctx.core && ctx.core.settings;
    const global = core && typeof core.get === 'function' ? core.get('ratio') : null;
    return global === '9:16' ? '9:16' : '16:9';
  };
  // The settings document plus the one derived value a page cannot compute itself: `ratio` is
  // declared as `default`, and the fence geometry depends on what that resolved to right now.
  const settingsPayload = () => {
    const out = settings.describe();
    if (out.ratio && typeof out.ratio === 'object') out.ratio.effective = effectiveRatio();
    return out;
  };
  // Body-tracking status: updated only by the overlay's /ack (a timestamp, never a frame) and by
  // the body page's own /ack. Read back on /status so the pane can say whether a mask is arriving.
  const body = { lastMaskAt: 0, pageOpen: false, lastPoseAt: 0 };
  // What one ack can say that no client record holds: the anchor source a page from before
  // `clientId` existed still reaches `freshestPage` through, the last-ack stamp that fallback reads,
  // the bundle in flight, and the tracker's last report. Everything else the page reports is per
  // document now — it lives on the client record `touchClient` writes — so nothing here can latch a
  // dead predecessor's maximum over a live page.
  const draw = { anchors: 'none', lastAckAt: 0, build: '', tracker: null };
  // The page's own error reports (POST /page-event), newest first. Overlay-only and additive: the
  // page buffers its own ring too, but a page that dies cannot be asked, so the server keeps the
  // last 50 it heard. Each entry carries the reporting clientId and build.
  const pageEvents = [];
  /**
   * Block testimony from the overlay's watchdog *worker* (GET /page-blame), one entry per client.
   *
   * This is the only report that can arrive while the page's main thread is blocked, because the
   * worker owns a thread and a `fetch` of its own. It is deliberately *not* a liveness signal: a
   * blame never stamps `lastAckAt` or `beatAt`, so a blocked page still reads as stale, and a page
   * that keeps being blamed cannot look fresh. Bounded at 32 clients and rewritten in place, so a
   * permanently blocked page increments `count` instead of growing the ring.
   */
  const pageBlames = new Map();
  const PAGE_BLAME_CLIENTS = 32;
  /**
   * Record one blame. Returns the entry so the caller can log the first one for a client: the log
   * line answers "when did this page go mute" without polling /status.
   */
  function recordPageBlame(clientId, q, now) {
    let entry = pageBlames.get(clientId);
    const first = !entry;
    if (!entry) {
      if (pageBlames.size >= PAGE_BLAME_CLIENTS) pageBlames.delete(pageBlames.keys().next().value);
      entry = { clientId, firstAt: now, lastAt: now, count: 0, why: '', gap: 0, last: '' };
      pageBlames.set(clientId, entry);
    }
    entry.lastAt = now;
    entry.count += 1;
    const why = typeof q.get('why') === 'string' ? q.get('why') : '';
    if (why) entry.why = why.slice(0, 60);
    const gap = Number(q.get('gap'));
    if (Number.isFinite(gap)) entry.gap = Math.max(0, Math.round(gap));
    const last = q.get('last');
    if (typeof last === 'string') entry.last = last.slice(0, 900);
    return { entry, first };
  }
  /** The public shape: newest blame first, so /status leads with the page that just went mute. */
  function pageBlameList() {
    return [...pageBlames.values()].sort((a, b) => b.lastAt - a.lastAt);
  }
  // Why the overlay's camera did not open (the page's own diagnostic object), the label of the
  // device it did open, which pipe is carrying frames (relay | device | synthetic | none) and why
  // the relay is not it. Reported on /ack, read back on /status; never a frame.
  const camera = { error: null, label: null, source: null, relayError: null };
  // The page's per-frame publish cost, reported on /ack and read back on /status: numbers, never
  // frames. It is what says whether `publish.frames` is short of `cameraFeed.frames` because the
  // page is slow to read back, to convert, or to upload.
  const publishTiming = { at: 0, composeMs: 0, readMs: 0, convertMs: 0, sendMs: 0, totalMs: 0 };
  // The ShockBox Virtual Camera pipe (publish-pipe.mjs). `off` opens nothing at all: no listener,
  // no buffer, no conversion. The pane's select is the only writer; the page sends the pictures.
  const pipe = createPublisher({ log });
  // The camera feed the overlay page cannot open itself. ffmpeg either reads WebcamSwitcher's frame
  // pipe (`capture: auto|pipe`) or the dshow device it publishes (`dshow`); this relays JPEG frames
  // over multipart. Nothing spawns until a client asks for the stream, and `cameraRelay: off` never
  // spawns at all.
  const relay = createCameraRelay({
    log,
    read: () => ({
      enabled: settings.get('cameraRelay') !== 'off',
      source: settings.get('cameraRelaySource'),
      fps: settings.get('cameraRelayFps'),
      size: settings.get('cameraRelaySize'),
      ffmpegPath: settings.get('ffmpegPath'),
      capture: settings.get('cameraRelayCapture'),
      // ffmpeg holds the device with no page connected when this is on (relay's own key name).
      cameraRelayKeepWarm: settings.get('cameraRelayKeepWarm') === true,
    }),
  });
  const unsubRelay = settings.subscribe((changed) => {
    if (changed.some((k) => k.startsWith('cameraRelay') || k === 'ffmpegPath')) relay.sync();
  });

  /**
   * Per-client ack identity: `clientId → { … }`. The page mints a uuid on load and sends it on
   * /ack; it is optional, because a document cached from before this existed never sends one.
   *
   * Why the map exists: "the newest ack, from any client" let a live document keep a dead one
   * looking healthy — several pages share one OBS window, and a hidden or throttled document can
   * still heartbeat on a timer. One entry per id means liveness is asked of a *particular* page.
   */
  const clientsById = new Map();
  /**
   * The socket census: one row per long-lived response this process holds open, with the identity
   * that owns it and how long it has been open. The pane polls /status at 1 Hz, so it can read the
   * inventory a socket table shows only as anonymous ESTABLISHED rows, and answer "which response
   * is holding a slot, and whose is it" without a guess about identity.
   *
   * The bus is core's (`core/events.mjs`), so it is observed through its one public entry point:
   * `attach` is wrapped read-only — it records the request's declared role/ref and the response's
   * close, and never changes what attach does. The bus cap mirrors `SSE_MAX_MS` there; if the two
   * ever disagree, only this label is wrong, never a response's life.
   */
  const BUS_MAX_MS = Number(process.env.SHOCKBOX_STREAM_MAX_MS) || 300_000;
  const streams = new Map();
  let streamSeq = 0;
  // The standing invariant published as `census.violations`; rebuilt on every status read by
  // `sweepClients`. Empty is the healthy state.
  let lastCensusViolations = [];
  // Closed responses, newest first: a cap close is the deterministic release an ack waits on, and
  // this ring is how /status shows it without anyone tailing the log.
  const streamRing = [];
  const STREAM_RING_MAX = 16;

  function openStream(row) {
    const rec = { id: ++streamSeq, ...row };
    streams.set(rec.id, rec);
    return rec;
  }

  /**
   * Per-stream frame accounting, installed on the response the camera route owns before the relay
   * is handed it. The relay writes every frame through this same `res`, so wrapping `write` sees
   * exactly the frames it hands over, and `writableLength` sampled at that moment is the socket's
   * own backlog.
   *
   * This is the honest liveness signal, and it is honest because of what it *cannot* do:
   *
   *   - `write()` returning true is not evidence on its own — Node accepts into its own queue
   *     whether or not the peer reads. So `frames` advancing is never used alone.
   *   - What is used is the pair: frames still going out (`lastWriteAt` recent) **while** the
   *     unflushed backlog stays bounded (`buffered`) **and** the stream is not parked in `drain`
   *     (`blockedSince`). A page that stopped reading fills the kernel send buffer within a frame
   *     or two, `write()` starts returning false, no `drain` ever fires, and all three go false
   *     together while the camera keeps producing at 30 fps.
   *
   * The residual gap, stated rather than hidden: this proves bytes left this server's socket, not
   * that the page decoded them. The difference is bounded by the OS and Chrome receive buffers —
   * well under a second at this rate — and the only thing that could close it is the ack path,
   * which the six-socket cap starves. `ackAgeMs` stays published so that starvation stays visible.
   */
  function meterStream(res, rec) {
    const meter = { frames: 0, lastWriteAt: 0, buffered: 0, blockedSince: 0 };
    const rawWrite = res.write.bind(res);
    res.write = function meteredWrite(chunk, ...rest) {
      const ok = rawWrite(chunk, ...rest);
      meter.frames += 1;
      meter.lastWriteAt = Date.now();
      meter.buffered = res.writableLength;
      if (ok) {
        meter.blockedSince = 0;
      } else if (!meter.blockedSince) {
        meter.blockedSince = Date.now();
      }
      return ok;
    };
    res.on('drain', () => {
      meter.buffered = res.writableLength;
      meter.blockedSince = 0;
    });
    rec.meter = meter;
    return meter;
  }

  function closeStream(rec, why) {
    if (!rec || !streams.delete(rec.id)) return;
    streamRing.unshift({
      path: rec.path,
      role: rec.role,
      clientId: rec.clientId,
      ageMs: Math.max(0, Date.now() - rec.born),
      capMs: rec.cap,
      why,
    });
    if (streamRing.length > STREAM_RING_MAX) streamRing.length = STREAM_RING_MAX;
  }

  // Read-only: the hub keeps its own list; this only observes the responses it opens.
  {
    const rawAttach = events.attach;
    events.attach = function attachObserved(req, res, opts) {
      try {
        const rec = openStream({
          path: '/events',
          role: roleOf(req),
          ref: refPath(req),
          // The ack identity the document declared on its own URL (`?clientId=`), the same id it
          // posts to `/ack`. With it, `relay.endClient`/`events.endClient` can end this response —
          // without it the bus is `unowned` and lives only until its age cap. Absent is `null`,
          // which is exactly the old behaviour for a page cached before the parameter existed.
          // `client=` is a human label, not the ack identity, so it is reported and never matched.
          clientId: clientIdOf(req),
          label: opts && typeof opts.client === 'string' ? opts.client.slice(0, 64) : null,
          remote: req.socket?.remoteAddress || '?',
          // The socket's own two ends, so this row can be matched to a CEF-side socket in a census
          // of `obs-browser-page`: identity on the wire is the only thing a long-lived response
          // cannot otherwise be found by.
          localPort: req.socket?.localPort ?? null,
          remotePort: req.socket?.remotePort ?? null,
          born: Date.now(),
          cap: BUS_MAX_MS,
        });
        res.on('close', () => {
          const age = Date.now() - rec.born;
          // `superseded` is the hub's rule (core/events.mjs `attach`): a newer client of the same
          // role, or of the ancestor's Referer path when the older row declared no role at all.
          const newer = [...streams.values()].some(
            (s) =>
              s !== rec &&
              s.path === '/events' &&
              s.born > rec.born &&
              (s.role === rec.role || (!rec.role && s.role === rec.ref)),
          );
          closeStream(rec, age >= rec.cap - 2000 ? 'max age' : newer ? 'superseded' : 'client closed');
        });
      } catch {
        /* the census must never be the reason a bus does not attach */
      }
      return rawAttach.apply(this, arguments);
    };
  }

  /**
   * Does a live document on this server own this identity? Two ledgers hold owners: handfx's own
   * ack/beat record, and the bus's open responses — exactly the set `events.endClient` can end.
   * The wall documents only appear in the second: they mint a stable clientId in `sessionStorage`
   * and send it as `?clientId=` on `/events`, so the bus can supersede and end their rows, but they
   * never ack. They must not ack either — an ack puts a non-handfx document in `clientsById`, which
   * `freshestPage` would then name as "the page", and the beat `<img>` would add a 1 s request
   * cadence to a document that already posts every 2 s. So ownership is read from both ledgers.
   */
  const ownedByDocument = (clientId) =>
    Boolean(clientId) && (clientsById.has(clientId) || events.ownsClient(clientId));

  /**
   * The census as /status reads it. `current` is asked of the identity the response declared: the
   * relay's live consuming reader first (`consuming` outranks ack recency, because only the reader
   * being handed frames at 30 fps can be the one taking them), then the freshest ack of its role.
   * A response whose role already has a newer holder is a *predecessor* that was expected to be
   * closed and was not — the row an operator needs to see. A stream with no clientId is `unowned`:
   * no `endClient` can match it, so only its age cap frees it.
   */
  function streamCensus(now, consuming) {
    const freshest = new Map();
    for (const c of clientsById.values()) {
      if (!c.role) continue;
      const prev = freshest.get(c.role);
      if (!prev || (c.lastAckAt || 0) > (prev.lastAckAt || 0)) freshest.set(c.role, c);
    }
    const rows = [];
    for (const rec of streams.values()) {
      const holder = rec.role ? freshest.get(rec.role) || null : null;
      // Consuming outranks ack recency: the relay hands a reader 30 frames a second only to the
      // response that is actually taking them, which a predecessor that merely acks more recently
      // cannot claim. Recency alone labelled the live 30 fps reader a `predecessor`.
      const streaming = Boolean(rec.path === '/api/handfx/camera/stream' && rec.clientId && consuming && consuming.has(rec.clientId));
      const current = streaming
        ? true
        : !holder
          ? null
          : rec.clientId
            ? holder.id === rec.clientId
            : rec.born >= (holder.firstAckAt || holder.lastAckAt || 0);
      rows.push({
        path: rec.path,
        role: rec.role || null,
        // The page's own name for itself (`?client=`), when it sent one. A label, not an identity.
        label: rec.label || null,
        clientId: rec.clientId || null,
        // `bus`: no ack record, but the bus holds an open response for this identity, so
        // `events.endClient` can still end the row. `unknown` is the one that cannot be reaped.
        owner: rec.clientId
          ? clientsById.has(rec.clientId)
            ? 'acked'
            : events.ownsClient(rec.clientId)
              ? 'bus'
              : 'unknown'
          : 'unowned',
        // Why this row cannot be reaped by `endClient`, when that is the case: no identity on the
        // request, or one that neither ledger holds. `owner: unowned` alone was the misleading half
        // of the old reading — the row said who did not own it and never why.
        ownerReason: rec.clientId
          ? (ownedByDocument(rec.clientId) ? null : 'no live document owns this clientId')
          : 'request carried no clientId',
        // The socket's two ends and when the response opened: the row's per-socket identity.
        localPort: rec.localPort ?? null,
        remotePort: rec.remotePort ?? null,
        since: rec.born,
        current,
        predecessor: current === false,
        ageMs: Math.max(0, now - rec.born),
        capMs: rec.cap,
        ref: rec.ref || null,
        remote: rec.remote,
      });
    }
    rows.sort((a, b) => b.ageMs - a.ageMs);
    return {
      // Cross-check for the rows above: core's own count of bus responses.
      busClients: events.clientCount,
      busChannels: events.clientsByChannel(),
      open: rows.length,
      streams: rows,
      closed: streamRing.slice(),
      caps: { eventBusMs: BUS_MAX_MS, cameraMs: CAMERA_MAX_MS },
    };
  }

  /**
   * Which clientId is currently holding the relay open by asking for frames, or null. Reported on
   * /status so "nobody asked for frames" is a visible fact instead of an `idle` feed with no error.
   */
  let feedArmedBy = null;
  /**
   * The release deadline. One unref'd timeout, reset by each asking ack: when the last asking page
   * stops acking (a closed tab, an OBS reload) the relay is released without a poll loop.
   */
  let demandTimer = null;

  /**
   * The single truth table for the feed. `effectiveSource`, `stale`, `state` and `reason` are all
   * computed here and nowhere else, so one payload cannot contradict itself:
   *
   *   feed not live                → effectiveSource 'stale', stale, state = the feed's own state
   *   feed live, acks stale, beats fresh → 'page-mute': alive and drawing, not reporting
   *   feed live, fresh ack camera  → effectiveSource 'camera', not stale
   *   feed live, fresh ack other   → effectiveSource = that source, not stale
   */
  /**
   * One rule for every payload-derived value: if the payload is older than `PAGE_FRESH_MS`, the
   * value is last-known and is reported as null. Two passes were read against numbers that were
   * not live because this was patched per field; it is applied once, to all of them.
   */
  function fresh(at, value) {
    return at && Date.now() - at <= PAGE_FRESH_MS ? value : null;
  }

  // A page-reported string, shortened and typed. Same rule as the numbers beside it: the payload
  // carries a copy of what the page said, never a reference to an object of the page's choosing.
  const pageStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

  /**
   * Which browser answered: the User-Agent of the request that created or touched a client, bounded
   * like every other page-reported string. Captured from the `/ack` or `/beat` that registered the
   * record. Acks may arrive from the page's worker, whose User-Agent is the same as the page's first
   * HTTP request; a client that sends none leaves this `null` (not captured) rather than a guess.
   */
  const clientUa = (req) => pageStr(req && req.headers ? req.headers['user-agent'] : '', 200) || null;

  /**
   * The path the document is actually on, in fallback order: the page's own report (`role`, which
   * the overlay sets to `location.pathname`), else its Referer's pathname, else the path of the
   * request that registered it. A page that says where it is is believed over any header; the
   * Referer covers one from before `role` existed. `validRole` is the same charset bound `role`
   * itself uses.
   */
  const clientPath = (req, roleIn) =>
    validRole(roleIn) ||
    refPath(req) ||
    pageStr(req && typeof req.url === 'string' ? req.url.split('?')[0] : '', 200) ||
    null;

  /**
   * The tracker's own report, made unambiguous. The tracker runs in the page, so this server only
   * ever repeats what the last ack said — and `reported` says whether one ever arrived, which is a
   * different question from `available` (is it still fresh) and from `hands` (is anything in front
   * of the camera). `null` collapsed "no page has ever reported" and "the page reported zero hands"
   * into one value, which is why a dead tracker and an empty frame used to read the same.
   *
   *   reported:false  → no ack has ever carried a tracker block; nothing is known
   *   reported:true, available:false → one did, but it is older than PAGE_FRESH_MS; `ageMs` says how
   *   available:true  → the full report, and `hands: 0` there means "tracking, nothing in view"
   */
  function trackerStatus(now) {
    if (!draw.tracker) {
      return { origin: 'page', available: false, reported: false, reason: 'page has not reported tracker state' };
    }
    const ageMs = draw.lastAckAt ? Math.max(0, now - draw.lastAckAt) : null;
    if (ageMs == null || ageMs > PAGE_FRESH_MS) {
      return {
        origin: 'page',
        available: false,
        reported: true,
        ageMs,
        reason: ageMs == null
          ? 'tracker state arrived without an ack clock'
          : `page last reported tracker state ${Math.round(ageMs / 1000)} s ago`,
      };
    }
    return { origin: 'page', available: true, reported: true, ageMs, ...draw.tracker };
  }

  /**
   * The camera readers that are provably *consuming* frames right now, keyed by the client id their
   * stream was opened with. Read from the meters the camera route installs (see `meterStream`), the
   * one population that has a writer to sample:
   *
   *   - `sentAgeMs` — the relay handed this reader a frame within `STREAM_LIVE_MS`. It advances only
   *     while bytes are leaving the socket, so it freezes when the peer stops reading.
   *   - `buffered` — the response's `writableLength`, sampled at each write: shallow when drained.
   *   - `blockedMs` — the reader is not parked in backpressure. A page that stops reading fills the
   *     kernel send buffer within a frame or two, `write()` returns false, no `drain` ever comes,
   *     and this grows without bound while `frames` freezes.
   *
   * A page that stopped reading therefore fails all three within about a second at this frame rate.
   * The residual limit is stated in `meterStream`: this proves the bytes left the socket, not that
   * the page decoded them, and that gap is bounded by the OS/Chrome receive buffers.
   */
  function consumingReaders(now) {
    const out = new Map();
    for (const rec of streams.values()) {
      if (rec.path !== '/api/handfx/camera/stream') continue;
      const m = rec.meter;
      if (!m || !rec.clientId || !m.frames) continue;
      const sentAgeMs = m.lastWriteAt ? Math.max(0, now - m.lastWriteAt) : null;
      const blockedMs = m.blockedSince ? Math.max(0, now - m.blockedSince) : 0;
      if (sentAgeMs == null || sentAgeMs > STREAM_LIVE_MS) continue;
      if ((m.buffered || 0) > STREAM_BUFFER_MAX) continue;
      if (blockedMs > STREAM_BLOCKED_MAX_MS) continue;
      out.set(rec.clientId, {
        clientId: rec.clientId,
        sent: m.frames,
        sentAgeMs,
        buffered: m.buffered || 0,
        blockedMs,
      });
    }
    return out;
  }

  function pageTruth(feed, page, now, consuming) {
    const live = feed.state === 'live';
    const pageAckAgeMs = page && page.lastAckAt ? Math.max(0, now - page.lastAckAt) : Infinity;
    const pageBeatAgeMs = page && page.beatAt ? Math.max(0, now - page.beatAt) : Infinity;
    const pageFresh = pageAckAgeMs <= PAGE_FRESH_MS;
    const beatFresh = pageBeatAgeMs <= PAGE_BEAT_STALE_MS;
    // Precedence, in the order the evidence is worth: a page consuming the camera stream is alive by
    // construction (it is being handed 30 frames a second and taking them), then a fresh ack, then
    // nothing. `livenessBasis` names which one answered so a reading is never ambiguous.
    const streamReader = live && page && page.id && consuming ? consuming.get(page.id) || null : null;
    const streamLive = Boolean(streamReader);
    const livenessBasis = streamLive ? 'stream' : pageFresh ? 'ack' : 'none';
    const alive = streamLive || pageFresh;
    // The three page states, named. Acks are the page *talking*; beats are the page *running*, and
    // they travel different paths on purpose, so the pair says which of the two failed.
    const pageState = alive ? 'live' : beatFresh ? 'page-mute' : 'page-dead';
    const loopStale = clientLoopStale(page, now);
    const aged = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : 'never');
    if (!live) {
      return {
        live,
        pageFresh,
        pageState,
        pageAckAgeMs,
        pageBeatAgeMs,
        beatFresh,
        loopStale,
        livenessBasis,
        stale: true,
        effectiveSource: 'stale',
        state: feed.state,
        reason: `feed ${feed.state}${feed.reason || feed.error ? `: ${feed.reason || feed.error}` : ''}`,
      };
    }
    if (!alive) {
      return {
        live,
        pageFresh,
        pageState,
        pageAckAgeMs,
        pageBeatAgeMs,
        beatFresh,
        loopStale,
        livenessBasis,
        stale: true,
        effectiveSource: 'stale',
        // Not 'live': the pipe is running, but the page is not reporting what it draws. The two
        // stale cases are finally distinguishable — a mute page is still beating.
        state: pageState,
        reason: page
          ? beatFresh
            ? `page mute: ${page.lastAckAt ? `no ack for ${aged(pageAckAgeMs)}` : 'no ack ever'} but beating ${aged(pageBeatAgeMs)} ago (ticks ${page.beatTicks || 0}, draws ${page.beatDraws || 0}) — alive and drawing, not reporting`
            : `page dead: ${page.lastAckAt ? `no ack for ${aged(pageAckAgeMs)}` : 'no ack ever'} and ${page.beatAt ? `no beat for ${aged(pageBeatAgeMs)}` : 'no beat ever'} — the page is gone`
          : 'page dead: no page has ever acked or beaten',
      };
    }
    const acked = ['camera', 'synthetic', 'none'].includes(page.source) ? page.source : 'none';
    // What is driving, not what was last acked. A page taking the camera stream is on the camera by
    // construction — `main.js` only opens `/camera/stream` when the camera is wanted — so a stream
    // reading answers `camera` even where the ack path is too starved to say anything.
    const source = streamLive && !pageFresh ? 'camera' : acked;
    return {
      live,
      pageFresh,
      pageState,
      pageAckAgeMs,
      pageBeatAgeMs,
      beatFresh,
      loopStale,
      livenessBasis,
      stale: false,
      effectiveSource: source,
      state: 'live',
      // Reader evidence, so the basis is inspectable rather than a bare enum.
      stream: streamReader
        ? { clientId: streamReader.clientId, sent: streamReader.sent, sentAgeMs: streamReader.sentAgeMs, buffered: streamReader.buffered, blockedMs: streamReader.blockedMs }
        : null,
      reason: streamLive
        ? `feed live, page live on the stream: ${streamReader.sent} frames sent to reader ${streamReader.clientId}, last ${aged(streamReader.sentAgeMs)} ago, ${streamReader.buffered} B queued${pageFresh ? `; ack ${aged(pageAckAgeMs)} ago` : `; no ack for ${aged(pageAckAgeMs)} — the ack path is starved, not the page`}`
        : loopStale === true
          ? `feed live, page live: ack ${aged(pageAckAgeMs)} ago, but its loop has not advanced for ${aged(now - (page.loopAdvAt || now))} — reporting, not drawing`
          : `feed live, page live: ack ${aged(pageAckAgeMs)} ago, reporting ${source}`,
    };
  }

  /**
   * Is this client still reporting at all? An ack or a beat inside the candidate window, or a
   * camera reader it owns that is provably taking frames. The third is not a courtesy: under the
   * six-socket cap the ack POST and the beat `<img>` are both starved for most of every camera-cap
   * cycle, so a page that is demonstrably consuming 30 fps would otherwise be dropped from candidacy
   * and the headline would fall to "no page ever reported". Consuming is stronger evidence than
   * either ack or beat, so it has to count here.
   */
  function clientAlive(c, now, consuming) {
    if (consuming && c.id && consuming.has(c.id)) return true;
    const seen = Math.max(c.lastAckAt || 0, c.beatAt || 0);
    return seen > 0 && now - seen <= CLIENT_CANDIDATE_MS;
  }

  /**
   * How good one client is as its role's answer. Ranked first on whether it is drawing *now* — a
   * document that survived has an advancing paint clock, one that died mid-boot does not — and only
   * then on ack recency. Recency alone is what let a transient boot row outrank the live document.
   * A consuming stream counts as drawing: frames are arriving and being taken, which is the one
   * thing a dead document cannot do.
   */
  function candidateRank(c, now, consuming) {
    const streaming = Boolean(consuming && c.id && consuming.has(c.id));
    const ackFresh = c.lastAckAt > 0 && now - c.lastAckAt <= PAGE_FRESH_MS;
    // A hidden document is not drawing on air, however recently it acked: an occluded OBS source
    // gets no `requestAnimationFrame`, so it can keep acking a loop it is not running. It can still
    // be a role's liveness answer (see `clientAlive`); it just cannot win the draw title.
    const visible = c.hidden !== true;
    const drawing = visible && (clientDrawing(c, now) || (ackFresh && c.loopTicks > 0 && clientLoopStale(c, now) === false));
    return [drawing ? 2 : ackFresh ? 1 : 0, Math.max(c.lastAckAt || 0, streaming ? Number.MAX_SAFE_INTEGER : 0)];
  }

  /** The best live client matching `match`, or null. */
  function bestClient(now, match, consuming) {
    let best = null;
    let bestRank = null;
    for (const c of clientsById.values()) {
      if (!match(c) || !clientAlive(c, now, consuming)) continue;
      const r = candidateRank(c, now, consuming);
      if (!best || r[0] > bestRank[0] || (r[0] === bestRank[0] && r[1] > bestRank[1])) {
        best = c;
        bestRank = r;
      }
    }
    return best;
  }

  /**
   * The client that answers for one role: live, and the best of its live documents. A null-role row
   * (a document cached from before `?role=` existed) matches no role at all, so it can never be
   * handed back here however recent its `lastAckAt` is.
   */
  function rolePage(role, now, consuming) {
    return role ? bestClient(now, (c) => (c.role || null) === role, consuming) : null;
  }

  /**
   * The page the headline verdict is built from. It is the `/shockfx` document and no other. When
   * no `/shockfx` document is reporting, another role's live document is still the page talking
   * (its path changed), so it answers. Only a tree with no role-bearing client at all — a page
   * cached before `?role=` existed — falls back to the old any-client behaviour.
   */
  function freshestPage(now, consuming) {
    const headline = rolePage(HEADLINE_ROLE, now, consuming);
    if (headline) return headline;
    const other = bestClient(now, (c) => Boolean(c.role), consuming);
    if (other) return other;
    if ([...clientsById.values()].some((c) => c.role)) return null; // roles exist, none reporting
    const legacy = bestClient(now, () => true, consuming);
    if (legacy) return legacy;
    // A document cached before `clientId` existed still acks, and calling it dead because it has no
    // id would be a worse lie than trusting the one stamp it does send.
    if (draw.lastAckAt > 0) return { id: null, lastAckAt: draw.lastAckAt, beatAt: 0, source: draw.anchors };
    return null;
  }

  /**
   * Forget entries silent for 10 minutes, and log the first 30 s of silence once per client.
   * It rides the status read (the pane's 1 Hz poll) instead of a timer, so an idle module logs
   * nothing, and `silentLogged` is what keeps the line off every subsequent poll.
   */
  function sweepClients(now) {
    // The invariant is read BEFORE the reap: a response that trips a predicate is reported on the
    // read that heals it, so the violation is observable instead of being closed out of existence
    // in the same pass. Published as `census.violations`; empty means healthy.
    lastCensusViolations = violationsNow(now);
    for (const [id, c] of clientsById) {
      // A page is gone only when it has stopped both ways. Ack age alone used to be the line, but
      // the ack is a `fetch` out of the same six-per-origin pool the page's `/events` EventSource
      // and camera stream keep full: an ack 120 ticks stale (`ACK_MS` 500 ms) is the ordinary look
      // of a live page that lost the slot race, and pruning it RSTs the camera stream it is still
      // reading and restarts the attach loop. The beat is the second signal: a 1 s `<img>` GET that
      // shares no `fetch` with the ack, so it still lands when the ack cannot. Both stale is the
      // only death sentence; ack stale + beat fresh is starvation, already reported as `ack-stale`
      // by `violationsNow` above. `hidden` is legitimate (a non-composited source still acks) and a
      // beat is not an ack, so a mute page stays diagnosable for this window. The invariant was
      // read before the reap, so the pass that prunes also reports.
      const ackGoneMs = c.lastAckAt ? now - c.lastAckAt : 0;
      const beatGoneMs = c.beatAt ? now - c.beatAt : Infinity;
      if (ackGoneMs > CLIENT_ACK_GONE_MS && beatGoneMs > PAGE_BEAT_STALE_MS) {
        const ended = relay.endClient(id);
        const busEnded = events.endClient(id);
        clientsById.delete(id);
        log.info(`handfx page: pruned clientId=${id}: no ack for ${Math.round(ackGoneMs / 1000)}s, no beat for ${Number.isFinite(beatGoneMs) ? `${Math.round(beatGoneMs / 1000)}s` : 'ever'}, ended=${ended} stream(s), ${busEnded} bus response(s)`);
        continue;
      }
      // A beat is proof of life too: a mute page (acks broken, beats arriving) must not be swept
      // out from under the truth table just because its ack path is the thing that failed.
      const silentFor = now - Math.max(c.lastAckAt || 0, c.beatAt || 0);
      if (silentFor > CLIENT_REAP_MS) {
        // Silence, not cooperation: end the readers this document still holds so the next ack of a
        // live successor can get a socket at all. Both long-lived responses it owns are reaped —
        // the camera stream and the bus response — because either one left open burns a slot out of
        // CEF's six-per-origin budget, and the bus is the one that starves the ack POST.
        const ended = relay.endClient(id);
        const busEnded = events.endClient(id);
        clientsById.delete(id);
        log.info(`handfx page: reaped clientId=${id} after ${Math.round(silentFor / 1000)}s silence, ended=${ended} stream(s), ${busEnded} bus response(s)`);
        continue;
      }
      if (silentFor > CLIENTS_TTL_MS) {
        clientsById.delete(id);
        continue;
      }
      if (!c.silentLogged && silentFor > CLIENT_SILENT_MS) {
        c.silentLogged = true;
        log.info(`handfx page: silent clientId=${id} for ${Math.round(silentFor / 1000)}s`);
      }
    }
  }

  /**
   * The standing invariant: every condition that makes /status untrustworthy, as short named
   * entries, empty when healthy. Read on the same 1 Hz status pass as the reap and *before* it, so
   * the pass that heals a condition still reports it. Assertable from a plain GET, no browser.
   */
  function violationsNow(now) {
    const out = [];
    // One read of both populations, shared by every predicate below and identical to the rows
    // /status publishes, so the standing check and the census cannot disagree.
    const consuming = consumingReaders(now);
    const rows = streamCensus(now, consuming).streams;
    // origin-sockets-exhausted: CEF allows six sockets per origin. At six there is no slot left for
    // the ack POST or the beat `<img>` — the failure this census exists to name. `rows` is every
    // long-lived stream on the origin, so this is a headcount of the origin, not an allowance held
    // by any one client: nobody here is over budget. `oldestClientId` is merely the oldest row's
    // owner, kept for orientation; the per-owner check is `owner-over-budget` below. (This used to
    // be called `budget-exhausted` with an `owner` field, which read as client blame and caused a
    // wrong diagnosis. Do not put `owner` back.)
    if (rows.length >= SOCKET_BUDGET) {
      const oldest = rows.reduce((a, b) => (a.ageMs >= b.ageMs ? a : b));
      out.push({ kind: 'origin-sockets-exhausted', open: rows.length, budget: SOCKET_BUDGET, path: oldest.path, oldestClientId: oldest.clientId });
    }
    const byOwner = new Map();
    for (const row of rows) {
      // unowned-stream: nothing on this row names a live document, so no `endClient` call can end
      // it by identity. `reason` says which half is missing rather than the old bare `unowned`.
      if (!row.clientId) {
        out.push({ kind: 'unowned-stream', path: row.path, role: row.role, localPort: row.localPort, remotePort: row.remotePort, reason: 'request carried no clientId' });
      } else {
        const list = byOwner.get(row.clientId);
        if (list) list.push(row);
        else byOwner.set(row.clientId, [row]);
        if (!ownedByDocument(row.clientId)) {
          out.push({ kind: 'unowned-stream', clientId: row.clientId, path: row.path, role: row.role, localPort: row.localPort, remotePort: row.remotePort, reason: 'no live document owns this clientId' });
        }
      }
      // silent-unreaped: an open response nobody is speaking for. A row with an owner record is
      // judged by that owner's silence (ack or beat, so a mute-but-beating page is not swept); a
      // row with no owner can only be judged by its own age. This reads ack/beat timestamps and
      // nothing else — it does not inspect socket state, so it cannot vouch that a peer is
      // half-closed (FIN_WAIT); only that nothing has spoken for this long.
      const c = row.clientId ? clientsById.get(row.clientId) || null : null;
      const silentFor = c ? now - Math.max(c.lastAckAt || 0, c.beatAt || 0) : row.ageMs;
      if (silentFor <= CLIENT_REAP_MS) continue;
      out.push({ kind: 'silent-unreaped', owner: row.clientId, path: row.path, silentMs: Math.round(silentFor) });
    }
    for (const [clientId, list] of byOwner) {
      // owner-over-budget: one document may declare its bus response and at most one camera
      // stream. A third row under one clientId is a leaked predecessor, and it is what starves
      // this page's own ack POST out of the six-socket pool.
      if (list.length > LONG_LIVED_PER_CLIENT) {
        out.push({ kind: 'owner-over-budget', clientId, open: list.length, allowed: LONG_LIVED_PER_CLIENT, paths: list.map((r) => r.path) });
      }
    }
    // draw-client-hidden: the draw document reported `document.hidden === true`. That is a
    // visibility flag and nothing more — an occluded OBS source, a non-composited source and a
    // throttled rAF all leave it false or true independently, so it is not evidence the page
    // stopped painting. Reported as the observation it is; do not read it as "misattributed".
    // misattributed below is reserved for the two cases that are genuine set-disagreement: the
    // census and the relay naming different responses as the frame consumer.
    const page = freshestPage(now, consuming);
    const drawPage = page && Number.isFinite(page.drawCount) ? page : null;
    if (drawPage && drawPage.hidden === true) {
      out.push({ kind: 'draw-client-hidden', owner: drawPage.id, path: drawPage.pagePath || null, why: 'drawClientId document reports hidden=true (visibility flag, not proof it stopped painting)' });
    }
    for (const row of rows) {
      if (row.path !== '/api/handfx/camera/stream') continue;
      const streaming = Boolean(row.clientId && consuming.has(row.clientId));
      if (row.current === true && !streaming) {
        out.push({ kind: 'misattributed', owner: row.clientId, path: row.path, why: 'current response is not in the relay consuming set' });
      }
      if (streaming && row.current !== true) {
        out.push({ kind: 'misattributed', owner: row.clientId, path: row.path, why: 'consuming stream is not current' });
      }
    }
    const streamClients = relay.status().clients;
    for (const c of clientsById.values()) {
      const ackAgeMs = c.lastAckAt ? Math.max(0, now - c.lastAckAt) : null;
      const ackFresh = ackAgeMs != null && ackAgeMs <= PAGE_FRESH_MS;
      if (ackFresh) continue;
      const beatAgeMs = c.beatAt ? Math.max(0, now - c.beatAt) : null;
      const beatFresh = beatAgeMs != null && beatAgeMs <= PAGE_BEAT_STALE_MS;
      // The ack is the one channel this file documents as unreliable under load: a `fetch` out of
      // the same six-per-origin pool the page's `/events` EventSource and camera stream keep full,
      // so a stale ack is the ordinary look of a live page that lost the slot race. Liveness is
      // read from all three testimonies — `lastAckAt`, `beatAt` (a 1 s `<img>` GET on its own
      // path) and the relay's consuming set — the same inputs the reap and `pageTruth` use.
      // `consuming` is per document; `streamClients` is the pool-level count and is carried as
      // evidence, because a nonzero relay count does not vouch for *this* client.
      const streaming = Boolean(consuming && c.id && consuming.has(c.id));
      // ack-stale: acks stopped, but the page is still running (fresh beat) or still taking frames
      // (a consuming reader). That is a starved request path, not a dead page. Say what was
      // observed; do not conclude the page is gone from the one channel that lies under pressure.
      if (beatFresh || streaming) {
        out.push({
          kind: 'ack-stale',
          clientId: c.id,
          role: c.role || null,
          ackAgeMs,
          beatAgeMs,
          streaming,
          streamClients,
          hidden: c.hidden === true,
          why: `${ackAgeMs == null ? 'no ack ever' : `no ack for ${Math.round(ackAgeMs / 1000)} s`}, ${beatAgeMs == null ? 'no beat ever' : `beat ${Math.round(beatAgeMs / 1000)} s old`}, ${streaming ? 'relay is handing this client frames' : 'relay has no reader for this client'} — ack path starved, liveness not judged dead`,
        });
        continue;
      }
      // client-not-live: every channel is silent — the ack past `PAGE_FRESH_MS`, the beat past
      // `PAGE_BEAT_STALE_MS` (or never), and no consuming reader. That is the only death verdict,
      // and the `ack-stale` split above does not loosen it: a page with no ack, no beat and no
      // consumer still lands here.
      out.push({
        kind: 'client-not-live',
        clientId: c.id,
        role: c.role || null,
        state: ackAgeMs == null ? 'never-acked' : 'stale',
        ackAgeMs,
        beatAgeMs,
        streamClients,
        why: `${ackAgeMs == null ? 'no ack ever' : `no ack for ${Math.round(ackAgeMs / 1000)} s`}, ${beatAgeMs == null ? 'no beat ever' : `no beat for ${Math.round(beatAgeMs / 1000)} s`}, relay has no reader for this client — no channel testifies for the page`,
      });
    }
    return out;
  }

  /** One /ack from one page. Registered on the first ack; the first-ack line is once per id. */
  function touchClient(id, bodyIn, roleIn = null, req = null) {
    const now = Date.now();
    touchClientCalls += 1;
    if (!clientsById.has(id)) ackNewClient += 1;
    let c = clientsById.get(id);
    if (!c) {
      const source = ['camera', 'synthetic', 'none'].includes(bodyIn.anchors) ? bodyIn.anchors : 'none';
      c = { id, role: roleIn, userAgent: clientUa(req), pagePath: clientPath(req, roleIn), firstAckAt: now, lastAckAt: now, lastDrawAt: 0, loopTicks: 0, lastLoopAt: 0, hidden: null, visibility: '', effect: null, build: null, source, drawCount: 0, drawSeenCount: -1, drawSeenAt: 0, phases: [], silentLogged: false, wantsFeed: false, reloads: 0, lastReloadAt: 0, staleSince: 0, beatAt: 0, beatTicks: 0, beatDraws: 0, beatPhase: '', loopAdvAt: now };
      clientsById.set(id, c);
      log.info(`handfx page: first ack clientId=${id} role=${roleIn || '-'} build=${typeof bodyIn.build === 'string' ? bodyIn.build : ''} source=${source}`);
    }
    // The document's identity, not its ephemeral clientId: a reload makes a new clientId but keeps
    // the same role, which is what /status groups on.
    if (roleIn) c.role = roleIn;
    // Identity, captured from whichever request first carried it and never overwritten: a later ack
    // from the worker may arrive without a User-Agent, and filling only when empty keeps that from
    // erasing the first capture.
    if (!c.userAgent) c.userAgent = clientUa(req);
    if (!c.pagePath) c.pagePath = clientPath(req, roleIn);
    if (!c.firstAckAt) c.firstAckAt = now;
    c.lastAckAt = now;
    c.silentLogged = false;
    if (Number.isFinite(bodyIn.draws)) c.drawCount = Math.max(c.drawCount, Math.max(0, bodyIn.draws | 0));
    if (Number.isFinite(bodyIn.lastDrawAt) && bodyIn.lastDrawAt > c.lastDrawAt) c.lastDrawAt = Math.min(now, bodyIn.lastDrawAt);
    if (Number.isFinite(bodyIn.loopTicks)) {
      const ticks = Math.max(0, bodyIn.loopTicks | 0);
      // The loop-advance clock: when this page's paint counter last moved. A page that acks forever
      // with a frozen `loopTicks` is alive and not drawing, and only this stamp can say so for a
      // *particular* client — a second page acking cannot mask it.
      if (ticks > c.loopTicks) c.loopAdvAt = now;
      c.loopTicks = Math.max(c.loopTicks, ticks);
    }
    if (typeof bodyIn.hidden === 'boolean') c.hidden = bodyIn.hidden;
    // The effect this document believes is current, as the page computes it every frame from its
    // *applied* list (`state.effect`, null when that list is empty). It is the page's own answer to
    // "is there anything visible to draw": a failed boot status read applies no effects, so every
    // `fx.trigger` refuses and this reads null while the render loop keeps ticking. Used by
    // `drawing` only — never by the pass counters, which stay a liveness signal.
    c.effect = typeof bodyIn.effect === 'string' && bodyIn.effect ? bodyIn.effect.slice(0, 64) : null;
    // The paint clock's own wall-clock stamp and the document's visibility, per page: a page whose
    // loop stopped and a hidden one are the two states that look identical from the headline count.
    if (Number.isFinite(bodyIn.lastLoopAt) && bodyIn.lastLoopAt > c.lastLoopAt) c.lastLoopAt = Math.min(now, bodyIn.lastLoopAt);
    if (typeof bodyIn.visibility === 'string' && bodyIn.visibility.length <= 16) c.visibility = bodyIn.visibility;
    if (typeof bodyIn.build === 'string' && bodyIn.build) c.build = bodyIn.build.slice(0, 64);
    // The page's build self-heal, reported on its own beat. `reloads` is monotonic per server
    // build, `staleSince` is the first mismatch this document saw (0 while it matches). Clamped,
    // so /status cannot carry a page's stray numbers, and never latched downward: a reloaded
    // document re-reports the budget it restored from sessionStorage.
    if (Number.isFinite(bodyIn.reloads)) c.reloads = Math.max(0, bodyIn.reloads | 0);
    if (Number.isFinite(bodyIn.lastReloadAt)) c.lastReloadAt = Math.min(now, Math.max(0, bodyIn.lastReloadAt));
    if (Number.isFinite(bodyIn.staleSince)) c.staleSince = bodyIn.staleSince > 0 ? Math.min(now, bodyIn.staleSince) : 0;
    // Which boot breadcrumbs this page reached (module-start … first-draw). Overwritten whole, so
    // the list always reads as the page's current progress and never accumulates.
    if (Array.isArray(bodyIn.phases)) {
      c.phases = bodyIn.phases.filter((p) => typeof p === 'string').map((p) => p.slice(0, 40)).slice(0, 24);
    }
    if (['camera', 'synthetic', 'none'].includes(bodyIn.anchors)) c.source = bodyIn.anchors;
    // Does this page need camera frames? Overwritten on every ack, never latched: the ack that
    // stops saying it (or stops arriving) is the release.
    c.wantsFeed = bodyIn.wantsFeed === true;
  }

  /**
   * One beat from one page: a GET with no body, on a 1 s timer that shares nothing with `ack()` —
   * no fetch, no JSON, no socket held. It registers the client if no ack has arrived yet (a page
   * whose ack path is broken still proves it is running), and stamps the counters the node
   * otherwise only learns from an ack, so `clientList` stops lying when acks go mute.
   */
  function touchBeat(id, q, now, req = null) {
    let c = clientsById.get(id);
    if (!c) {
      c = { id, userAgent: clientUa(req), pagePath: clientPath(req, null), firstAckAt: 0, lastAckAt: 0, lastDrawAt: 0, loopTicks: 0, lastLoopAt: 0, hidden: null, visibility: '', effect: null, build: null, source: 'none', drawCount: 0, drawSeenCount: -1, drawSeenAt: 0, phases: [], silentLogged: false, wantsFeed: false, reloads: 0, lastReloadAt: 0, staleSince: 0, beatAt: 0, beatTicks: 0, beatDraws: 0, beatPhase: '', loopAdvAt: now };
      clientsById.set(id, c);
      log.info(`handfx page: first beat clientId=${id} (no ack yet)`);
    }
    if (!c.userAgent) c.userAgent = clientUa(req);
    if (!c.pagePath) c.pagePath = clientPath(req, null);
    c.beatAt = now;
    const ticks = Number(q.get('t'));
    if (Number.isFinite(ticks)) {
      const t = Math.max(0, Math.floor(ticks));
      if (t > c.beatTicks) c.beatTicks = t;
      if (t > c.loopTicks) {
        c.loopTicks = t;
        c.loopAdvAt = now;
      }
    }
    const draws = Number(q.get('d'));
    if (Number.isFinite(draws)) c.beatDraws = Math.max(c.beatDraws || 0, Math.max(0, Math.floor(draws)));
    const phase = q.get('p');
    if (typeof phase === 'string') c.beatPhase = phase.slice(0, 40);
    const build = q.get('b');
    if (typeof build === 'string' && build && !c.build) c.build = build.slice(0, 64);
    // Demand is re-evaluated here as well as on the ack, so a page whose acks died (the one
    // transport that can die alone) neither loses the camera nor leaves it armed forever.
    applyFeedDemand();
  }

  /**
   * Is this client's paint clock frozen *while it is still acking*? Read-only reporting: a page
   * that acks forever and never advances `loopTicks` is alive and not drawing, and this is asked
   * of one client so a second page cannot answer for it.
   *
   * A silent client cannot testify about its loop: when its ack is older than `PAGE_FRESH_MS` there
   * is no current answer, so `null` (unknown) is returned rather than `false`. `false` here reads as
   * "the loop is fine", which is the opposite of what a missing input licenses.
   */
  function clientLoopStale(c, now) {
    if (!c || !(c.lastAckAt > 0) || now - c.lastAckAt > PAGE_FRESH_MS) return null;
    return now - (c.loopAdvAt || c.firstAckAt || now) > LOOP_STALE_MS;
  }

  /**
   * Is this client painting frames? The page's own draw progress is the only positive evidence: its
   * paint clock (`lastDrawAt`) inside `LOOP_STALE_MS`, or an advance in its own `draws` counter since
   * the previous status read. `c.streaming` proves only that the socket layer accepted bytes — a
   * page can be handed every frame with an empty send queue while drawing nothing — and a fresh ack
   * proves the page is talking, not painting. The counter baseline is per client (`drawSeenCount`),
   * so a reload starts from zero and a second document cannot answer for this one.
   */
  function clientDrawing(c, now) {
    if (!c || c.hidden === true) return false;
    if (c.lastDrawAt > 0 && now - c.lastDrawAt <= LOOP_STALE_MS) return true;
    const draws = Number.isFinite(c.drawCount) ? c.drawCount : 0;
    const seen = Number.isFinite(c.drawSeenCount) ? c.drawSeenCount : -1;
    if (seen < 0) c.drawSeenCount = draws; // the first read is a baseline, not evidence
    else if (draws > seen) {
      c.drawSeenCount = draws;
      c.drawSeenAt = now;
    }
    return c.drawSeenAt > 0 && now - c.drawSeenAt <= LOOP_STALE_MS;
  }

  /**
   * Arm or release the camera relay from the pages' own heartbeats. Any client whose ack says
   * `wantsFeed` holds the producer while it is *fresh*, and freshness is read from the beat, not the
   * ack: the beat is a plain `<img>` GET, so one broken transport (the ack POST) must never take the
   * camera from a page that is demonstrably alive. `lastAckAt` is the fallback only until the first
   * beat arrives, so a client that has acked but not yet beaten is not dropped in its first second.
   * When no client holds, the producer is released. The heartbeat is the only
   * subscription involved, so a page that reconnects after a node restart re-arms the camera with
   * its next ack — no reload, no operator action, and nothing to lose on a reconnect.
   */
  function applyFeedDemand() {
    const now = Date.now();
    let holder = null;
    for (const c of clientsById.values()) {
      if (c.wantsFeed !== true) continue;
      const heardAt = c.beatAt || c.lastAckAt || 0;
      if (!heardAt || now - heardAt > PAGE_FRESH_MS) continue;
      if (!holder || c.lastAckAt > holder.lastAckAt) holder = c;
    }
    feedArmedBy = holder ? holder.id : null;
    relay.setDemand(Boolean(holder));
    if (demandTimer) {
      clearTimeout(demandTimer);
      demandTimer = null;
    }
    if (holder) {
      // One more freshness window, then re-ask: a page that went away releases the camera by
      // itself, and a page that is still there keeps it armed with each ack in between.
      demandTimer = setTimeout(applyFeedDemand, PAGE_FRESH_MS + 1000);
      demandTimer.unref?.();
    }
  }

  /**
   * One client's answer, in the same vocabulary as `pageTruth`: `live` (acking), `page-mute`
   * (beating, not acking), `page-dead` (neither, but still inside the candidate window) and `stale`
   * (past it — listed, never counted). `drawing` is null when the page is not acking, because
   * nothing is known about a loop that is not reporting. `candidate` is what a role's verdict may
   * pick: a real role, still reporting.
   */
  function clientVerdict(c, now, consuming) {
    const ackAgeMs = c.lastAckAt ? Math.max(0, now - c.lastAckAt) : null;
    const beatAgeMs = c.beatAt ? Math.max(0, now - c.beatAt) : null;
    const ackFresh = ackAgeMs != null && ackAgeMs <= PAGE_FRESH_MS;
    const beatFresh = beatAgeMs != null && beatAgeMs <= PAGE_BEAT_STALE_MS;
    const streamReader = consuming && c.id ? consuming.get(c.id) || null : null;
    const streaming = Boolean(streamReader);
    const alive = clientAlive(c, now, consuming);
    // Read-only: this client is acking but its paint counter has stopped advancing. Asked of one
    // client so a second page's ticking cannot answer for it.
    const loopStale = clientLoopStale(c, now);
    const livenessBasis = streaming ? 'stream' : ackFresh ? 'ack' : 'none';
    return {
      state: streaming || ackFresh ? 'live' : beatFresh ? 'page-mute' : alive ? 'page-dead' : 'stale',
      live: streaming || ackFresh,
      livenessBasis,
      ackAgeMs,
      beatAgeMs,
      candidate: Boolean(c.role) && alive,
      // Three independent questions, three independent sources. `drawing` is "are frames being
      // painted": the page's own draw progress, never a consuming stream (bytes accepted by the
      // socket layer are not output) and never an ack (talking is not painting). `null` when the page
      // is not acking at all: nothing is known about a loop that is not reporting. `loopStale` is
      // "is the loop at fault" and is `null` for the same reason. `payloadFresh` on /status answers
      // "is the page talking". A live, ticking loop over an empty effect list paints a transparent
      // canvas, but it still paints: `drawing` reports paint, not visibility of an effect.
      drawing: c.lastAckAt > 0 && now - c.lastAckAt <= PAGE_FRESH_MS ? clientDrawing(c, now) : null,
      loopStale,
    };
  }

  /**
   * The per-role view. One entry per role present, carrying the authoritative row (`rolePage`) and
   * the answers /status publishes: live, build, ack age, beat age, drawing. Rows that no longer
   * report are still counted in `documents` but never become a role's answer. The `null` group is
   * documents from before `?role=` existed: reported, never authoritative for any role.
   */
  function rolesView(now, consuming) {
    const groups = new Map();
    for (const c of clientsById.values()) {
      const key = c.role || null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const roles = [];
    for (const [role, list] of groups) {
      const best = role ? rolePage(role, now, consuming) : bestClient(now, (c) => !c.role, consuming);
      const verdict = best ? clientVerdict(best, now, consuming) : null;
      roles.push({
        role,
        state: verdict ? verdict.state : 'absent',
        live: verdict ? verdict.live : false,
        build: best ? best.build || null : null,
        ackAgeMs: verdict ? verdict.ackAgeMs : null,
        beatAgeMs: verdict ? verdict.beatAgeMs : null,
        drawing: verdict ? verdict.drawing : null,
        loopStale: verdict ? verdict.loopStale : null,
        clientId: best ? best.id : null,
        documents: list.length,
      });
    }
    return {
      headlineRole: HEADLINE_ROLE,
      headline: roles.find((r) => r.role === HEADLINE_ROLE) || null,
      roles,
    };
  }

  /** The public shape: the barest facts, no internal bookkeeping (`silentLogged` stays here). */
  function clientList(consuming) {
    const now = Date.now();
    return [...clientsById.values()].map((c) => ({
      id: c.id,
      // Which document this is, independent of the ephemeral clientId: two entries with the same
      // role are one page's predecessor and successor, and /status can say so.
      role: c.role || null,
      // What the browser said it is, and the path it is actually on. Together these tell an OBS
      // browser source from a Brave tab that both reach this port from the same host, which no
      // other field here can. Always present; null when the registering request carried no
      // User-Agent, never a guess.
      userAgent: c.userAgent || null,
      pagePath: c.pagePath || null,
      ...clientVerdict(c, now, consuming),
      firstAckAt: c.firstAckAt,
      lastAckAt: c.lastAckAt,
      lastDrawAt: c.lastDrawAt,
      loopTicks: c.loopTicks,
      hidden: c.hidden,
      build: c.build,
      // The build self-heal: how many self-reloads this page spent on the build it reports, when
      // the last one happened, and when it first saw a mismatch (0 while it matches).
      reloads: c.reloads || 0,
      lastReloadAt: c.lastReloadAt || 0,
      staleSince: c.staleSince || 0,
      source: c.source,
      drawCount: c.drawCount,
      wantsFeed: c.wantsFeed === true,
      phases: c.phases || [],
      // The beat: the last `<img>` GET this page sent, and the counters it carried. Read beside
      // `lastAckAt`, it separates a mute page (beat fresh, ack stale) from a dead one (both stale).
      beatAt: c.beatAt || 0,
      beatTicks: c.beatTicks || 0,
      beatDraws: c.beatDraws || 0,
      beatPhase: c.beatPhase || '',
      // Block testimony from this client's own worker, or null. Beside `lastAckAt` it separates a
      // blocked page (blame fresh, ack stale) from a gone one (both stale).
      pageBlame: pageBlames.get(c.id) || null,
    }));
  }

  /**
   * The camera inventory envelope for /cameras and /cameras/rescan. `list()` is the only enumerator
   * and it is called from a route, never from `status()`: enumerating starts other processes' DLLs.
   * A failed enumeration is a 200 with `ok: false`, so the pane can say *why* nothing is listed
   * instead of showing a broken request.
   */
  async function camerasPayload(force) {
    const started = Date.now();
    let out;
    try {
      out = force ? await rescanCameras() : await listCameras();
    } catch (err) {
      out = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    const ms = Date.now() - started;
    const devices = Array.isArray(out.devices) ? out.devices : [];
    const nonVideo = Array.isArray(out.nonVideo) ? out.nonVideo : [];
    if (out.ok === true) log.info(`handfx cameras: enumerate ok=${devices.length} cached=${out.cached === true} ms=${ms}`);
    else log.warn(`handfx cameras: enumerate failed "${out.error || 'unknown'}"`);
    // The relay's own view, not a second enumeration: is something actually capturing right now?
    const feed = relay.status();
    return {
      ok: out.ok === true,
      cached: out.cached === true,
      ageMs: Number.isFinite(out.ageMs) ? out.ageMs : 0,
      devices,
      nonVideo,
      error: out.error || null,
      configured: configuredSource(),
      live: feed.state === 'live' ? { source: feed.source, mode: feed.capture ? feed.capture.mode : null } : null,
    };
  }


  function publish(cmd, args) {
    // The replay stamp lives on its own key: `args.id` belongs to the caller (it is the effect id
    // a deck key or the pane names), and overwriting it here made `effect.set {id:"fireball"}`
    // arrive at the page as `{id:"m1x2y3z"}` — published, acknowledged, and silently ignored.
    const rec = events.publish('handfx', cmd, { ...args, at: Date.now(), sid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
    lastCmd = { cmd, args, seq: rec?.seq ?? null, at: Date.now() };
    return rec;
  }

  function status() {
    // The module is built twice (once for init, once for routes), so a pipe opened in init would
    // belong to an instance nobody serves from. Sync here instead: the pane and the overlay both
    // read this document, so the setting takes effect at the first read, and `off` costs a compare.
    pipe.setMode(settings.get('publish'));
    // Same reasoning for the relay: off costs a compare, on applies any changed device/size, and
    // a client still connected is restarted onto the new settings. The demand is re-derived first,
    // so a page that acked while this document was being built is armed by the first read.
    applyFeedDemand();
    relay.sync();
    const s = settings.all();
    const model = findModel();
    // Freshness is one table now (`pageTruth`), not a set of separate age checks: the payload used
    // to be able to say `stale: true` next to `effectiveSource: "camera"`, and `stale: false` was
    // unreachable while the feed was merely healthy. The table reads the relay's own state and the
    // *freshest* page ack, so a live document cannot keep a dead one looking healthy.
    const now = Date.now();
    sweepClients(now);
    const feed = relay.status();
    // One read of the per-stream metering, shared by every verdict below, so the payload cannot
    // say two things about the same reader.
    const consuming = consumingReaders(now);
    const page = freshestPage(now, consuming);
    const truth = pageTruth(feed, page, now, consuming);
    const stale = truth.stale;
    // The build the authoritative page reports, which is the headline role's row whenever it has
    // one: `draw.build` is the overlay's own last ack and cannot see a second document take over.
    const pageBuild = (page && page.build) || draw.build;
    // A page running a bundle this server no longer serves is its own fault, not the feed's: the
    // picture can look healthy while none of the deployed code is running. Named here so /status
    // reads as `page on stale build …` instead of `feed idle`.
    const buildStale = Boolean(pageBuild && pageBuild !== BUILD);
    const staleForMs = stale ? Math.round(truth.pageAckAgeMs) : 0;
    // The paint clock, read as its own state, from the page that answers this payload. `ackFresh`
    // is the difference that matters: an acking page whose loop is silent is alive and not painting
    // (an occluded OBS source — Chrome sends a document it does not composite no
    // `requestAnimationFrame` at all), which is a real fault on air and must not read as `stale`.
    // `unknown` is the honest answer when no page ever reported, or when the page stopped reporting
    // altogether: then nothing is known about its loop. Read per page, never latched module-wide: a
    // second document acking cannot say anything about this one's loop.
    const loopAt = page && Number.isFinite(page.lastLoopAt) ? page.lastLoopAt : 0;
    const ackAt = page ? page.lastAckAt : 0;
    const loopIdleMs = loopAt > 0 ? Math.max(0, now - loopAt) : null;
    const ackFresh = ackAt > 0 && now - ackAt <= PAGE_STALE_MS;
    const renderLoop = !ackFresh || loopAt === 0 ? 'unknown' : loopIdleMs > LOOP_STALE_MS ? 'stopped' : 'running';
    // Draw truth per document. `page` carries its own record (written by `touchClient`), so a
    // reloaded page reports its own counters from zero and never inherits a predecessor's. A page
    // from before `clientId` existed answers through `freshestPage` as a stub with no record: its
    // counters are unattributable, so they read null rather than borrowing anyone else's.
    const drawPage = page && Number.isFinite(page.drawCount) ? page : null;
    const drawFrom = (key) => (drawPage ? (drawPage[key] ?? null) : null);
    return {
      cmds: CMDS,
      effects: EFFECTS,
      model: { local: Boolean(model), name: MODEL_NAME, url: MODEL_URL },
      bodyModels: bodyModels(),
      body: { lastMaskAt: body.lastMaskAt, pageOpen: body.pageOpen && Date.now() - body.lastPoseAt < 5000, lastPoseAt: body.lastPoseAt },
      // The two facts a reader should not have to dig out of `settings` (which carries the whole
      // describe document): the persisted mode, and what is actually driving the particles right
      // now. `trackingSource: 'auto'` + `effectiveSource: 'synthetic'` is the fallback — read
      // `cameraError`/`relayError`/`cameraSource` for why — and is not the same thing as the
      // operator asking for synthetic.
      trackingSource: ['camera', 'synthetic'].includes(settings.get('trackingSource')) ? settings.get('trackingSource') : 'auto',
      // Answered by `pageTruth` only: `stale` is not a source, it says the feed or the page is not
      // current, so `effectiveSource` degrades to `stale` with a `reason` in the same breath.
      effectiveSource: truth.effectiveSource, // camera | synthetic | none | stale
      lastAckedSource: draw.anchors,
      // Where the freshest page says its boot got to (module-start … first-draw). Empty until a
      // page acks; the list is the answer to "it acked once and stopped": last crumb reached.
      phases: page && Array.isArray(page.phases) ? page.phases : [],
      stale,
      staleForMs,
      /** Why `effectiveSource` reads what it reads — feed state, page ack age, or a stale bundle. */
      reason: buildStale ? `page on stale build ${pageBuild} (server ${BUILD}); ${truth.reason}` : truth.reason,
      /**
       * The clientId whose heartbeat is holding the relay open, or null. Beside `reason`: a null
       * here with `state: "idle"` is "no page asked for frames", which is a fact, not silence.
       */
      feedArmedBy,
      /** True when the freshest known page acked inside `PAGE_FRESH_MS`. */
      pageFresh: truth.pageFresh,
      // The page's state, named: `live` (acks fresh), `page-mute` (acks stale, beats fresh: alive
      // and drawing, not reporting) or `page-dead` (both stale). Passed through from the feed's own
      // state when the feed is not live. `truth.reason` says the same thing in words.
      pageState: truth.pageState,
      // Which evidence `pageState`/`effectiveSource` were derived from — `stream` (a camera reader
      // that is provably taking frames: the basis outranks acks), `ack` (a fresh ack) or `none`.
      // A reading is never ambiguous about why it says what it says.
      livenessBasis: truth.livenessBasis,
      beatFresh: truth.beatFresh === true,
      beatAgeMs: Number.isFinite(truth.pageBeatAgeMs) ? Math.round(truth.pageBeatAgeMs) : null,
      // The beat itself: when the freshest page last proved it is running, and the counters it
      // carried. These are populated even when acks are mute, which is the point.
      beatAt: (page && page.beatAt) || 0,
      beatTicks: (page && Number.isFinite(page.beatTicks) && page.beatTicks) || 0,
      beatDraws: (page && Number.isFinite(page.beatDraws) && page.beatDraws) || 0,
      beatPhase: (page && page.beatPhase) || '',
      // Read-only: the freshest page is acking but its loop counter has stopped advancing.
      loopStale: truth.loopStale ?? null,
      // What the page is running vs what this server serves. `null` before the first ack.
      build: BUILD,
      clientBuild: pageBuild || null,
      buildMatches: pageBuild ? pageBuild === BUILD : null,
      // The bundle fault on its own: `buildMatches: false` used to be one boolean beside a `stale`
      // that still said the feed was fine. This is the field a reader can key on.
      buildStale,
      // Whether the overlay is drawing at all, and on what: `none` means the page is open but no
      // loop has rendered (or no page is open), which is the state that looks like a dead source.
      // `drawClientId` is whose numbers these are — a reader can no longer be handed one document's
      // counters while believing they describe another. It, and every field below it, is null when
      // no page is live, instead of repeating a predecessor's last maximum.
      drawClientId: drawPage ? drawPage.id : null,
      draws: drawFrom('drawCount'),
      anchors: page ? (page.source ?? null) : null,
      lastDrawAt: drawFrom('lastDrawAt'),
      // The tracker's last report, on the same ack clock as every other payload-derived value but
      // never `null`: see `trackerStatus` for why "never reported" and "reported, nothing in view"
      // must not both read as absent.
      tracker: trackerStatus(now),
      // The page's own beat: fresh here with `draws` frozen is a page that cannot paint. `renderLoop`
      // is that reading done properly — `running` | `stopped` | `unknown` — with `loopIdleMs` and
      // `hidden` saying how long and whether Chrome has marked the document as not composited. All
      // of it belongs to `drawClientId`'s document, not to whichever page acked last.
      lastAckAt: page ? page.lastAckAt : null,
      renderLoop,
      loopIdleMs,
      loopTicks: drawFrom('loopTicks'),
      lastLoopAt: drawFrom('lastLoopAt'),
      hidden: drawFrom('hidden'),
      visibility: drawFrom('visibility') || null,
      // The overlay's camera answer: why it did not open (object or null) and what it did open.
      // A feed that is not live carries neither: a stale document must not hand the pane a
      // live-looking device name, or an ffmpeg error from an hour ago that reads as today's.
      cameraError: camera.error,
      cameraLabel: camera.label,
      cameraSource: truth.live ? camera.source : null,
      // The page's own reason the relay is not the source, reported even when the feed is live: a
      // live feed with no client is exactly the case that hid this string before.
      relayError: camera.relayError,
      // The virtual camera's truth: off | waiting (no consumer, or connected and silent) | live
      // (a consumer is reading frames), plus the counters and the geometry both sides agreed on.
      publish: { ...pipe.status(), timing: publishTiming.at ? publishTiming : null },
      // `state` is the table's, not the relay's alone, so it can no longer read `live` beside
      // `stale: true`. The rest of the relay's report is carried through untouched, and `clients`
      // stays the number of stream readers it has always been; `clientCount`/`clientList` are the
      // acking pages, which is a different population.
      cameraFeed: { ...feed, state: truth.state, live: truth.live, reason: truth.reason, clientCount: clientsById.size, clientList: clientList(consuming) },
      // Two independent clocks for bracketing a freeze: the worker's tick count and the provenance
      // of the last ack. A page frozen mid-draw while these advance is a thread-level stall; these
      // stopping with it is a wedged renderer process.
      // Every payload-derived field goes through `fresh()`: a value from a payload older than
      // PAGE_FRESH_MS is last-known, not current, and reads null. `workerTickAt` and `ackViaAt`
      // stay raw so the age is always visible. Client rows keep their own marker (`state: stale`
      // plus `ackAgeMs`) rather than being nulled, because the verdict reads those fields.
      workerTicks: fresh(workerTickAt, workerTicks),
      workerTickGapMs: fresh(workerTickAt, workerTickGapMs),
      workerTickSinceOk: fresh(workerTickAt, workerTickSinceOk),
      workerAckStats: fresh(workerTickAt, workerAckStats),
      workerTickAt,
      payloadFresh: {
        tick: Boolean(workerTickAt && Date.now() - workerTickAt <= PAGE_FRESH_MS),
        ack: Boolean(ackViaAt && Date.now() - ackViaAt <= PAGE_FRESH_MS),
      },
      ackVia: fresh(ackViaAt, ackVia),
      ackViaAt,
      ackRequests,
      touchClientCalls,
      ackNewClient,
      // The per-role verdict: one entry per document role present, and the headline role's row
      // (`/shockfx`). The top-level `pageState`/`clientBuild` follow this row; the other roles are
      // reported beside it. A second document of a role can no longer mask the real one, and a
      // null-role row from before `?role=` existed answers for nothing.
      pageRoles: rolesView(now, consuming),
      // Every long-lived response this process is holding, and the identity that owns it. The
      // inventory a socket table cannot give: path, role, clientId, age, cap, and whether the
      // declared identity is still the current one. See `streamCensus`.
      sockets: streamCensus(now, consuming),
      // The standing check: the predicates that keep the six-socket budget healthy, one entry per
      // violation, each naming the offending owner and path. Empty means healthy. Computed by the
      // same 1 Hz pass that reaps (`sweepClients`), so a violation is visible exactly as long as it
      // exists and never needs a browser to assert.
      census: { violations: lastCensusViolations },
      // The page's own error reports, newest first, capped at 50. Empty until a page reports.
      pageEvents: pageEvents.slice(),
      // Block testimony from the watchdog worker, newest first. A page whose main thread is blocked
      // still reports here while it cannot ack or beat, which is the whole point: an entry with a
      // fresh `lastAt` beside a stale `lastAckAt` is a blocked page, not a gone one.
      pageBlame: pageBlameList(),
      runtime: {
        vendored: fs.existsSync(path.join(VENDOR, 'vision', 'vision_bundle.mjs')),
        simdWasm: fs.existsSync(path.join(VENDOR, 'vision', 'simd-wasm', 'vision_wasm_internal.wasm')),
        nosimdWasm: fs.existsSync(path.join(VENDOR, 'vision', 'wasm-nosimd', 'vision_wasm_nosimd_internal.wasm')),
        base: '/api/handfx/vendor',
      },
      page: '/shockfx',
      bodyPage: '/shockfx/body',
      // The page is isolated by the headers its manifest entry declares (COOP/COEP); the pane
      // reads this to say plainly whether a browser tab of /handfx will be a secure, isolated
      // document — it is the operator's camera permission that depends on it.
      isolation: { crossOriginOpenerPolicy: 'same-origin', crossOriginEmbedderPolicy: 'require-corp' },
      settings: settingsPayload(),
      lastCmd,
    };
  }

  const api = {
    channels: ['handfx'],

    routes: [
      // Everything the pane and the page need in one read: the settings document, the effect
      // registry, the bus contract and whether the vendored runtime is on disk.
      { path: '/status', method: 'GET', handler: (req, res) => send(res, 200, status()) },
      // The build the page must load with (`?v=`) and report on /ack. Kept out of /status on
      // purpose: a page that read its build from /status would always match the server, even when
      // the document itself is a day old — the value has to come from the URL the page loaded.
      // The overlay document's own bootstrap: `pages/overlay.html` fetches this once per document
      // load, so it is the one page-load fact a module route can see (core serves the HTML itself).
      // This is the line that would have named the stale document before it sat there for 16 hours.
      {
        path: '/build',
        method: 'GET',
        handler: (req, res) => {
          const ip = String((req.socket && (req.socket.remoteAddress || '')) || '').replace(/^::ffff:/, '') || '-';
          log.info(`handfx build: poll /api/handfx/build build=${BUILD} clientIp=${ip}`);
          return send(res, 200, { build: BUILD });
        },
      },
      {
        path: '/beat',
        method: 'GET',
        handler: (req, res, url) => {
          const q = url && url.searchParams ? url.searchParams : new URLSearchParams();
          const id = String(q.get('c') || '').slice(0, 64);
          if (id) touchBeat(id, q, Date.now(), req);
          // 204 and no body: the page sends this with `new Image()`, and nothing is waiting to read
          // it. No-store so a proxy can never replay a beat and make a dead page look alive.
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
        },
      },
      // Block testimony from the page's watchdog worker: the only instrument that survives a
      // blocked main thread, because it runs its own thread and its own `fetch`.
      //
      // A GET with query params (never a body) so it works from inside a worker with no request
      // plumbing, and 204 no-store like /beat: nothing reads the answer, and a proxy must never
      // replay a blame. It records nothing in the liveness path — no `lastAckAt`, no `beatAt` — so
      // a blamed page still reads stale, and blaming cannot manufacture freshness.
      {
        path: '/page-blame',
        method: 'GET',
        handler: (req, res, url) => {
          const q = url && url.searchParams ? url.searchParams : new URLSearchParams();
          const id = String(q.get('c') || '').slice(0, 64);
          if (id) {
            const { entry, first } = recordPageBlame(id, q, Date.now());
            if (first) {
              log.warn(
                `handfx page-blame: client=${id} why=${entry.why || '-'} gap=${entry.gap}ms ` +
                  `last=${entry.last ? entry.last.slice(0, 120) : '-'}`,
              );
            }
          }
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
        },
      },
      // A deploy's push, instead of waiting for the page's own 25 s poll: the bus message the page
      // already handles (`applyBusCommand` → `reload`). No page state is touched here, and the
      // route is honest about how many pages were listening.
      {
        path: '/page/reload',
        method: 'POST',
        handler: (req, res) => {
          const rec = publish('reload', {});
          log.info(`handfx page: reload pushed seq=${rec?.seq ?? '-'} clients=${clientsById.size}`);
          return send(res, 200, { ok: true, seq: rec?.seq ?? null, clients: clientsById.size });
        },
      },
      // What ffmpeg can open. An explicit ask, never a poll: enumeration launches the virtual-camera
      // client DLLs in other processes. A failed enumeration is still a 200 with `ok: false`, so the
      // pane renders the reason instead of a broken request.
      {
        path: '/cameras',
        method: 'GET',
        handler: async (req, res) => send(res, 200, await camerasPayload(false)),
      },
      {
        path: '/cameras/rescan',
        method: 'POST',
        handler: async (req, res) => send(res, 200, await camerasPayload(true)),
      },
      // Restart the feed in place, for a wedged ffmpeg or a source the operator just changed.
      // `dispose()` is the relay's stop half: it ends the attached streams, tears the pipe socket
      // down, kills the producer and zeroes the attempt budget (`failed` becomes `idle`). `sync()`
      // is the start half: it re-reads the settings, so a pending `cameraRelaySource` applies, and
      // starts again only when someone is reading or keep-warm is on. Both are synchronous, and
      // `start()` returns while a producer exists, so two presses in a row cannot spawn two
      // producers. The page's stream ends by design; it reconnects on its own.
      {
        path: '/cameras/restart',
        method: 'POST',
        handler: (req, res) => {
          const before = relay.status();
          if (!relay.enabled()) {
            log.warn(`handfx cameras: restart refused — relay off (state=${before.state})`);
            return send(res, 200, { ok: false, restarted: false, error: 'camera relay is off' });
          }
          try {
            relay.dispose();
            relay.sync();
            const after = relay.status();
            log.info(
              `handfx cameras: restart from=${before.state} to=${after.state} source="${after.source || ''}" attempt=${after.attempt} clients=${before.clients}`,
            );
            return send(res, 200, {
              ok: true,
              restarted: true,
              state: after.state,
              source: after.source,
              attempt: after.attempt,
              clients: after.clients,
              error: null,
            });
          } catch (err) {
            const message = err && err.message ? err.message : String(err);
            log.warn(`handfx cameras: restart failed "${message}" state=${before.state}`);
            return send(res, 200, { ok: false, restarted: false, error: message });
          }
        },
      },
      // The bare list a client may expect from the page's own registry — `Object.keys(EFFECTS)`,
      // strings in renderer order. `/status` carries the same ids with their titles and gestures;
      // this one exists so "the effects" is never a shape a client has to unpack to get right.
      {
        path: '/effects',
        method: 'GET',
        handler: (req, res) => send(res, 200, EFFECTS.map((e) => e.id)),
      },
      // The camera relay, for a page that cannot open a camera itself: one response that never
      // ends, parts delimited by `--framebound`, each an image/jpeg with its own Content-Length.
      // The handler keeps the socket until the client leaves; core must not answer for it.
      {
        path: '/camera/stream',
        method: 'GET',
        handler: (req, res, url) => {
          relay.sync();
          if (!relay.enabled()) return send(res, 503, { ok: false, error: 'camera relay is off' });
          // Which document this stream belongs to. The relay ends any older stream of the same
          // identity before taking this one (see `addClient`), so a reloaded page cannot leave its
          // predecessor holding a socket out of the browser's six-per-origin budget.
          const role = roleOf(req);
          // The client id the document acks with: binds this stream to that client so the reaper
          // can end exactly this reader when the document goes silent, never its successor.
          const streamClientId = String(url.searchParams.get('clientId') || '').slice(0, 64) || null;
          res.writeHead(200, {
            'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'cache-control': 'no-store',
          });
          // A clean end at CAMERA_MAX_MS: no error status, so the page's next `fetch` simply opens
          // a new stream. `relay.addClient` already drops its client on `close`.
          const born = Date.now();
          const remote = req.socket?.remoteAddress || '?';
          let why = 'client closed';
          const rec = openStream({
            path: '/api/handfx/camera/stream',
            role,
            ref: refPath(req),
            clientId: streamClientId,
            remote,
            // Same per-socket correlation the bus row carries: without these two ports a row here
            // cannot be matched to a CEF socket, which is exactly how a reader sat in FinWait1
            // while every reading said it was fine.
            localPort: req.socket?.localPort ?? null,
            remotePort: req.socket?.remotePort ?? null,
            born,
            cap: CAMERA_MAX_MS,
          });
          let age = null;
          // Registered before the attach: a throw in the relay must not leak a census row.
          res.on('close', () => {
            closeStream(rec, res.reaped ? 'reaped' : res.superseded ? 'superseded' : why);
            if (!age) return;
            clearTimeout(age);
            // `superseded` is set by the relay when a newer stream of the same identity arrived:
            // this response was ended on purpose, not by the page leaving.
            log.info(
              `handfx camera stream client=${remote} role=${role || '-'} closed (${res.reaped ? 'reaped' : res.superseded ? 'superseded' : why}) after ${Math.round((Date.now() - born) / 1000)} s`,
            );
          });
          age = setTimeout(() => {
            why = 'max age';
            try {
              res.end();
            } catch {
              /* already gone */
            }
          }, CAMERA_MAX_MS);
          if (age.unref) age.unref();
          // Frame accounting for the liveness verdict, installed on this response before the relay
          // ever writes to it (see `meterStream`). Read-only with respect to the stream: the wrapper
          // passes every byte and write()'s return value straight through.
          meterStream(res, rec);
          relay.addClient(res, role, refPath(req), streamClientId);
          return new Promise((resolve) => res.on('close', resolve));
        },
      },
      // The newest single frame, for a page that only wants a picture (and for curl).
      {
        path: '/camera/latest.jpg',
        method: 'GET',
        handler: (req, res) => {
          relay.sync();
          const frame = relay.latest();
          if (!frame) return send(res, 503, { ok: false, error: 'no camera frame yet' });
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'cache-control': 'no-store',
            'content-length': frame.length,
          });
          res.end(frame);
        },
      },
      {
        path: '/settings',
        method: 'PATCH',
        handler: async (req, res, url, patch) => {
          // Core has already read and parsed the JSON body (`readJson`) and hands it in: a module
          // handler must not read the socket again, or it waits for bytes that were consumed.
          patch = patch && typeof patch === 'object' ? patch : {};
          // Effects may only name ids the registry has; a stale id in a saved document is the
          // failure the pane is meant to prevent, so a write that would introduce one is refused.
          if (patch.effects !== undefined) {
            const known = new Set(EFFECTS.map((e) => e.id));
            if (!Array.isArray(patch.effects)) return send(res, 400, { ok: false, error: 'effects must be an array' });
            const bad = patch.effects.filter((id) => !known.has(id));
            if (bad.length) return send(res, 400, { ok: false, error: `unknown effect id(s): ${bad.join(', ')}` });
          }
          try {
            const before = settings.get('publish');
            const changed = settings.patch(patch);
            const now = settings.get('publish');
            // Opening or closing the pipe follows the setting, and the page has to learn the new
            // mode before it starts (or stops) sending pictures: the bus is the only channel the
            // page listens on, and it re-reads the status document on `settings.patch`.
            if (now !== before) {
              pipe.setMode(now);
              publish('settings.patch', { key: 'publish', value: now });
            }
            // A ratio write changes where the wall sits, and the overlay re-derives its fence from
            // the status document: without this frame it would keep the old wall until a reload.
            if (changed.includes('ratio')) publish('settings.patch', { key: 'ratio', value: effectiveRatio() });
            return send(res, 200, { ok: true, changed, settings: settingsPayload(), publish: pipe.status() });
          } catch (err) {
            return send(res, err.status || 400, { ok: false, error: err.message });
          }
        },
      },

      {
        path: '/cmd',
        method: 'POST',
        handler: async (req, res, url, body) => {
          body = body && typeof body === 'object' ? body : {};
          const cmd = body.cmd;
          if (!CMDS.includes(cmd)) {
            return send(res, 400, { ok: false, error: `unknown cmd: ${cmd} (known: ${CMDS.join(', ')})` });
          }
          const args = body.args && typeof body.args === 'object' ? body.args : {};
          // `skins` is optional and per-id: only a skin the renderer implements is written, and
          // only for `shoot` (the one effect that wears one). An unknown skin is refused, never
          // coerced, so a deck key cannot silently switch the picture to something else.
          if (cmd === 'projectile.fire' && args.skin !== undefined) {
            if (!SKINS.includes(args.skin)) return send(res, 400, { ok: false, error: `unknown skin: ${args.skin}` });
            const skins = { ...(settings.get('skins') || {}), shoot: args.skin };
            settings.patch({ skins });
          }
          // `edit.clear` wipes the operator's hand-drawn canvas in the page; the server only
          // relays the command (the picture lives in the page, as everything else does here).
          // `effect.set` and `mirror/tracking` are answered here when they change the document,
          // so a deck key and a pane control never disagree; `next`/`prev`/`reload` are the
          // page's (it holds the cursor, and its cursor is the one an operator sees).
          if (cmd === 'tracking.toggle') {
            const changed = settings.patch({ enabled: !settings.get('enabled') });
            publish(cmd, { ...args, enabled: settings.get('enabled') });
            return send(res, 200, { ok: true, changed, enabled: settings.get('enabled'), settings: settingsPayload() });
          }
          if (cmd === 'mirror.toggle') {
            const changed = settings.patch({ mirror: !settings.get('mirror') });
            publish(cmd, { ...args, mirror: settings.get('mirror') });
            return send(res, 200, { ok: true, changed, mirror: settings.get('mirror'), settings: settingsPayload() });
          }
          if (cmd === 'effect.set') {
            // The pane and Stream Deck set the *effect list*, not a cursor: `args.value` is the
            // array of live ids (the old `args.id` shape is answered the same way it always was,
            // by publishing). Writing the document here is what made `{ok:true}` true — before,
            // the route validated and published but never touched settings, so /status kept
            // reporting the five defaults.
            const value = Array.isArray(args.value) ? args.value : null;
            if (value) {
              const unknown = value.filter((id) => !EFFECTS.some((e) => e.id === id));
              if (unknown.length) {
                return send(res, 400, { ok: false, error: `unknown effect: ${unknown.join(', ')}` });
              }
              const changed = settings.patch({ effects: value });
              publish(cmd, { ...args, effects: settings.get('effects') });
              return send(res, 200, { ok: true, changed, settings: settingsPayload() });
            }
            const id = args.id;
            if (!EFFECTS.some((e) => e.id === id)) {
              return send(res, 400, { ok: false, error: `unknown effect: ${id}` });
            }
          }
          // `effect.next`/`effect.prev`/`reload` are the page's to act on: it owns the cursor,
          // and it reports the effect it reached through POST /ack, so the pane shows the page's
          // answer rather than a server guess. The publish below is the whole of the server's job.
          const rec = publish(cmd, args);
          return send(res, 200, { ok: true, seq: rec?.seq ?? null });
        },
      },

      // The page reports what it reached, and honest state: tracking on/off, the model state,
      // the active effect. Nothing here is a frame or a landmark — this is a status line.
      // `maskAt` (the overlay's receipt time of a body-mask message) and `bodyPage` (the body
      // page's own beat) are two timestamps; a frame never crosses this route.
      {
        path: '/ack',
        method: 'POST',
        handler: async (req, res, url, bodyIn) => {
          bodyIn = bodyIn && typeof bodyIn === 'object' ? bodyIn : {};
          // The pane's live preview is a viewer, not a source: it says `preview: true` and the
          // server drops the whole report. Without this a preview's own draws would make a dead
          // OBS source look healthy (its draws land on no client record).
          if (bodyIn.preview === true) return send(res, 200, { ok: true, preview: true });
          if (bodyIn.source === 'body') {
            // The body page's beat: it is open and its camera is running. Timestamp only.
            body.pageOpen = bodyIn.open === true;
            if (body.pageOpen) body.lastPoseAt = Date.now();
            return send(res, 200, { ok: true });
          }
          ackRequests += 1;
          // Provenance: an ack with no main-thread involvement is the proof the worker is live and
          // posting. Logged only when it changes, so the ledger does not become a 2/s feed.
          const ackViaNow = req.headers['x-handfx-via'] === 'worker' ? 'worker' : 'page';
          if (ackViaNow !== ackVia) {
            ackVia = ackViaNow;
            log.info(`handfx page: ack via=${ackVia} clientId=${typeof bodyIn.clientId === 'string' ? bodyIn.clientId.slice(0, 64) : '-'}`);
          }
          ackViaAt = Date.now();
          // Per-page identity, optional by design: a document cached before `clientId` existed still
          // acks, and its `lastAckAt` and `anchors` are the only facts `freshestPage` can still read
          // from one (its draw counters are unattributable and report null).
          if (typeof bodyIn.clientId === 'string' && bodyIn.clientId && bodyIn.clientId.length <= 64) {
            // Which document this ack belongs to, recorded so /status can show one entry per role
            // rather than one per ephemeral clientId (which changes on every reload). `roleIn` is
            // the body's `role` when the page declares it, else the `?role=` on the ack URL through
            // `roleOf`; a page that declares neither gets a null role, never a guess. Read-only
            // bookkeeping: superseding is done where a long-lived response attaches, never here —
            // an ack cannot tell a successor's own pre-ack stream from its predecessor's, and
            // guessing would drop the live page's feed.
            touchClient(bodyIn.clientId, bodyIn, validRole(bodyIn.role) || roleOf(req), req);
            applyFeedDemand();
          }
          if (Number.isFinite(bodyIn.maskAt) && bodyIn.maskAt > body.lastMaskAt) body.lastMaskAt = Math.min(Date.now(), bodyIn.maskAt);
          // The tracker's own counters, rebuilt into the fixed shape /status serves: numbers and one
          // epoch stamp, so a page cannot plant an arbitrary object in the status response.
          if (bodyIn.tracker && typeof bodyIn.tracker === 'object') {
            const t = bodyIn.tracker;
            // Every field `snapshot()` sends, not just the counters: `state`/`feed`/`source`/`model`
            // are what say *why* hands is 0, and `detects`/`empties` are the only pair that separate
            // "no hand in view" from "nothing came back". A field the server drops is a question the
            // status route cannot answer.
            draw.tracker = {
              state: pageStr(t.state, 32),
              feed: pageStr(t.feed, 16),
              source: pageStr(t.source, 16),
              model: pageStr(t.model, 64),
              hands: Number.isFinite(t.hands) ? Math.max(0, Math.min(4, t.hands | 0)) : 0,
              landmarks: Number.isFinite(t.landmarks) ? Math.max(0, t.landmarks | 0) : 0,
              detects: Number.isFinite(t.detects) ? Math.max(0, t.detects | 0) : 0,
              empties: Number.isFinite(t.empties) ? Math.max(0, t.empties | 0) : 0,
              lastDetectAt: Number.isFinite(t.lastDetectAt) ? Math.min(Date.now(), t.lastDetectAt) : null,
              lastFrameAgeMs: Number.isFinite(t.lastFrameAgeMs) ? Math.max(0, t.lastFrameAgeMs | 0) : null,
              fps: Number.isFinite(t.fps) ? Math.max(0, t.fps | 0) : 0,
              frames: Number.isFinite(t.frames) ? Math.max(0, t.frames | 0) : 0,
              hangCount: Number.isFinite(t.hangCount) ? Math.max(0, t.hangCount | 0) : 0,
            };
          }
          if (['camera', 'synthetic', 'none'].includes(bodyIn.anchors)) draw.anchors = bodyIn.anchors;
          // The bundle this document was loaded from (`?v=`), so a page left running across a
          // deploy is visible as a mismatch instead of looking healthy. Bounded: it is status.
          if (typeof bodyIn.build === 'string' && bodyIn.build) draw.build = bodyIn.build.slice(0, 64);
          // When the page last spoke at all. It is the page's own timer (`main.js` heartbeat), not
          // its render loop, so this stamp keeps moving in a document Chrome refuses to composite;
          // the page's own `draws`/`loopTicks` are what stay frozen there.
          draw.lastAckAt = Date.now();
          // Per-frame publish cost, as the page measured it: readback, conversion, upload and the
          // round trip. Clamped numbers only, so /status cannot carry a page's stray strings.
          if (bodyIn.publishTiming && typeof bodyIn.publishTiming === 'object') {
            const t = bodyIn.publishTiming;
            const ms = (v) => (Number.isFinite(v) && v >= 0 && v < 60000 ? Math.round(v * 100) / 100 : 0);
            publishTiming.composeMs = ms(t.composeMs);
            publishTiming.readMs = ms(t.readMs);
            publishTiming.convertMs = ms(t.convertMs);
            publishTiming.sendMs = ms(t.sendMs);
            publishTiming.totalMs = ms(t.totalMs);
            publishTiming.at = Date.now();
          }
          // The camera's failure reason and the device that opened. The object is the page's; the
          // shape and the stage vocabulary are this server's, so a client cannot inject anything
          // but the fields /status promises.
          if (bodyIn.cameraError === null) camera.error = null;
          else if (bodyIn.cameraError && typeof bodyIn.cameraError === 'object') {
            const ce = bodyIn.cameraError;
            const stage = ['enumerate', 'getUserMedia', 'track', 'timeout'].includes(ce.stage) ? ce.stage : null;
            camera.error = stage
              ? {
                at: Number.isFinite(ce.at) ? ce.at : Date.now(),
                stage,
                name: typeof ce.name === 'string' ? ce.name.slice(0, 60) : '',
                message: typeof ce.message === 'string' ? ce.message.slice(0, 240) : '',
              }
              : null;
          }
          if (bodyIn.cameraLabel === null) camera.label = null;
          else if (typeof bodyIn.cameraLabel === 'string' && bodyIn.cameraLabel) camera.label = bodyIn.cameraLabel.slice(0, 120);
          // Which pipe carries the frames, and why the relay is not it. A fixed vocabulary, so a
          // client reading /status cannot be handed a word it does not know.
          if (['relay', 'device', 'synthetic', 'none'].includes(bodyIn.cameraSource)) camera.source = bodyIn.cameraSource;
          if (bodyIn.relayError === null) camera.relayError = null;
          else if (typeof bodyIn.relayError === 'string' && bodyIn.relayError) camera.relayError = bodyIn.relayError.slice(0, 240);
          // Whose numbers these are: the document this ack came from, looked up in the records
          // `touchClient` writes, never a module-wide maximum. A page from before `clientId` existed
          // has no record, and then its counters are unknown — null, not a predecessor's. (`pane.js`
          // reads only effect/hands/gesture/tracking/error from this payload; the counters are for
          // diagnostics, and /status answers them with `drawClientId` beside them.)
          const ackClient = typeof bodyIn.clientId === 'string' && bodyIn.clientId
            ? clientsById.get(bodyIn.clientId) || null
            : null;
          events.emit('handfx', 'page', {
            effect: typeof bodyIn.effect === 'string' ? bodyIn.effect : null,
            tracking: bodyIn.tracking === true,
            model: ['idle', 'loading', 'ready', 'failed', 'cached'].includes(bodyIn.model) ? bodyIn.model : 'idle',
            hands: Number.isFinite(bodyIn.hands) ? Math.max(0, Math.min(4, bodyIn.hands | 0)) : 0,
            gesture: typeof bodyIn.gesture === 'string' ? bodyIn.gesture.slice(0, 40) : null,
            body: bodyIn.body === true,
            error: typeof bodyIn.error === 'string' ? bodyIn.error.slice(0, 240) : null,
            draws: ackClient ? ackClient.drawCount : null,
            anchors: ackClient ? ackClient.source : null,
            lastDrawAt: ackClient ? ackClient.lastDrawAt : null,
            at: Date.now(),
          });
          send(res, 200, { ok: true, ratio: effectiveRatio() });
        },
      },

      // The page's own diagnostics: an error, a rejection, a failed resource load, or a boot
      // breadcrumb. Additive to /ack and deliberately dumb — it must never become the failure it
      // reports. Accepts one event or a coalesced batch (`{clientId, build, events:[…]}`), keeps the
      // last 50 in memory and answers `{ok:true}` in every case, including a malformed body.
      {
        path: '/page-event',
        method: 'POST',
        handler: (req, res, url, bodyIn) => {
          try {
            const body = bodyIn && typeof bodyIn === 'object' ? bodyIn : {};
            // The worker's clock, not the page's: one tick per 500 ms from the ack thread.
            if (body.kind === 'worker-tick') {
              workerTicks = Number(body.message) || workerTicks + 1;
              workerTickAt = Date.now();
              workerTickGapMs = Number(body.gapMs) || 0;
              workerTickSinceOk = Number(body.sinceOk) || 0;
              if (body.ack && typeof body.ack === 'object') workerAckStats = body.ack;
              return send(res, 200, { ok: true });
            }
            const list = Array.isArray(body.events) ? body.events : [body];
            for (const raw of list) {
              if (!raw || typeof raw !== 'object') continue;
              const ev = {
                kind: typeof raw.kind === 'string' && raw.kind ? raw.kind.slice(0, 40) : 'note',
                phase: typeof raw.phase === 'string' ? raw.phase.slice(0, 40) : '',
                message: typeof raw.message === 'string' ? raw.message.slice(0, 500) : String(raw.message == null ? '' : raw.message).slice(0, 500),
                stack: typeof raw.stack === 'string' ? raw.stack.slice(0, 1000) : '',
                src: typeof raw.src === 'string' ? raw.src.slice(0, 500) : '',
                count: Number.isFinite(raw.count) ? Math.max(1, raw.count | 0) : 1,
                clientId: typeof (body.clientId || raw.clientId) === 'string' ? String(body.clientId || raw.clientId).slice(0, 64) : '',
                build: typeof (body.build || raw.build) === 'string' ? String(body.build || raw.build).slice(0, 64) : '',
                t: Number.isFinite(raw.t) ? raw.t : Date.now(),
                at: Date.now(),
              };
              pageEvents.unshift(ev);
              if (pageEvents.length > 50) pageEvents.length = 50;
              log.info(`handfx page: ${ev.kind} ${ev.phase} ${ev.message}`.slice(0, 400));
            }
          } catch (err) {
            // Swallow: a diagnostic channel that can fail is worse than none. The 200 below is the
            // contract — the page must never retry or care.
          }
          return send(res, 200, { ok: true });
        },
      },

      {
        // The page's picture, as raw RGBA bytes (a frame is not JSON — the route declares
        // `rawBody`, so core hands over the bytes and this module owns the size ceiling).
        // Nothing is kept, logged or written to disk: it is converted to NV12 and written to the
        // camera's pipe, which is why an absent consumer costs nothing but a status word.
        path: '/frame',
        method: 'POST',
        rawBody: true,
        rawLimit: 32 * 1024 * 1024,
        handler: (req, res, url, body) => {
          const kind = url.searchParams.get('kind');
          const format = url.searchParams.get('format') === 'nv12' ? 'nv12' : 'rgba';
          pipe.setMode(settings.get('publish'));
          const g = pipe.status().geometry;
          // Geometry travels in the query string so a page converting to NV12 is provably
          // converting the picture the pipe wants; size alone cannot tell portrait from landscape.
          const w = Number(url.searchParams.get('w'));
          const h = Number(url.searchParams.get('h'));
          if (g && Number.isFinite(w) && Number.isFinite(h) && (w !== g.width || h !== g.height)) {
            return send(res, 409, {
              ok: false,
              error: 'frame size does not match the camera',
              expected: { width: g.width, height: g.height },
              got: { width: w, height: h },
              geometry: g,
            });
          }
          const out = pipe.publish(body, kind === 'raw' || kind === 'effects' ? kind : null, format);
          if (out.ok) {
            return send(res, 200, { ok: true, stage: out.stage, sent: out.sent || 0, converted: out.converted === true });
          }
          // A frame for a mode that is off, or of the wrong size, is the page and the pipe
          // disagreeing — say which, and what the pipe wants, instead of a bare 400.
          if (out.reason === 'size') {
            return send(res, 409, {
              ok: false,
              error: 'frame size does not match the camera',
              expected: out.expected,
              got: out.got,
              geometry: pipe.status().geometry,
            });
          }
          return send(res, 409, { ok: false, error: out.reason || 'not published', mode: pipe.status().mode });
        },
      },

      {
        path: '/model',
        method: 'GET',
        handler: (req, res, url) => {
          // `/model` is the hand model (unchanged); `/model/body` and `/model/pose` are the body
          // page's, same search, same streaming, named in /status so the page can pick one.
          const kind = url && url.searchParams ? url.searchParams.get('kind') : null;
          const file = kind === 'pose' ? findIn(POSE_NAME) : kind === 'segmenter' ? findIn(SEG_NAME) : findModel();
          const fallback = kind === 'pose' ? POSE_URL : kind === 'segmenter' ? SEG_URL : MODEL_URL;
          if (!file) {
            return send(res, 404, { ok: false, error: 'no local model', url: fallback });
          }
          const st = fs.statSync(file);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            // Cached for a day: re-read is cheap, and a new model file swaps on restart anyway.
            'cache-control': 'public, max-age=86400',
            'content-length': st.size,
            // The overlay is cross-origin isolated (COEP require-corp), so every subresource it
            // loads is checked. Same-origin is all this file needs: a CDN fallback is a URL, not a
            // reason to let another origin embed the model.
            'cross-origin-resource-policy': 'same-origin',
            'x-handfx-model-source': 'local',
          });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(file).pipe(res);
        },
      },
    ],

    /**
     * A directory of ~20 MB assets cannot be a route per file: core matches module routes on one
     * exact path. So the vendor directory is declared once — `mountPrefix` is `/api/handfx/vendor/`
     * — and core hands every GET under it to `mountFile` with the path after the prefix. No
     * module knows about handfx; this is the same generic hook any asset-serving module uses.
     */
    mountPrefix: '/vendor/',
    mountFile: (req, res, url, filePath) => {
      if (!serveVendor(res, req, filePath, { immutable: /(^|\/)wasm\//.test(filePath) || filePath.endsWith('.wasm') })) {
        send(res, 404, { ok: false, error: `no vendor asset ${filePath}` });
      }
      return undefined;
    },

    init() {
      log.info(
        `handfx: runtime ${fs.existsSync(path.join(VENDOR, 'vision', 'vision_bundle.mjs')) ? 'vendored' : 'NOT vendored'}, ` +
          `model ${findModel() ? 'local' : 'fetched from ' + MODEL_URL}`,
      );
      // The pipe is not opened here: init runs on a build that routes() then replaces, so a
      // listener owned by it would accept the Frame Server and never send a frame. `status()`
      // syncs the mode on the instance that actually serves.
    },

    dispose() {
      unsubRelay();
      relay.dispose();
      pipe.dispose();
      settings.flush();
    },
  };
  return api;
}

// Export shape. Core's registry does `mod.default || mod`, then reads `.init(ctx)`, `.routes(ctx)`,
// `.channels` and `.dispose()` off that object — it never calls a mount function, so the module API
// cannot be a function and cannot need the context before `init`/`routes` receive it. The exported
// object is therefore the module API for real, and the two members that need the context build the
// rest on first use: `routes(ctx)` builds the routes, `init(ctx)` wires logging and state. Both
// close over the built api, so `channels`/`mountPrefix`/`mountFile` are live members of the same
// object by the time the server asks for them (init and routes both run before the first request).
let api = null;
function self(ctx) {
  if (!api || ctx) api = build(ctx || lastCtx);
  lastCtx = ctx || lastCtx;
  return api;
}
let lastCtx = null;

const mod = {
  get channels() {
    return self().channels;
  },
  get mountPrefix() {
    return self().mountPrefix;
  },
  get mountFile() {
    return self().mountFile;
  },
  init(ctx) {
    return self(ctx).init();
  },
  routes(ctx) {
    return self(ctx).routes;
  },
  dispose() {
    if (api) api.dispose();
  },
};
export default mod;
