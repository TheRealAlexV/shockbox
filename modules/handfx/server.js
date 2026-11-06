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
 */
function bundleBuild() {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else h.update(path.relative(HERE, file)).update('\0').update(fs.readFileSync(file));
    }
  };
  try {
    walk(path.join(HERE, 'pages'));
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
 * Every command the bus accepts. `reload` and the effect cursor are handled by the page;
 * `projectile.fire` and `edit.clear` are one-shots the page acts on. Nothing here is tracked.
 */
export const CMDS = [
  'effect.next',
  'effect.prev',
  'effect.set',
  'tracking.toggle',
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
  // The overlay's draw truth, reported on /ack: how many frames it rendered, where the anchors came
  // from, and when the last frame landed. Counters and a name, never a frame. `loopTicks`/
  // `lastLoopAt` are the paint clock beside /ack: they freeze when Chrome stops compositing the
  // document, while `lastAckAt` keeps moving, which is what separates "not drawing" from "gone".
  const draw = {
    draws: 0, anchors: 'none', lastDrawAt: 0, lastAckAt: 0, build: '',
    loopTicks: 0, lastLoopAt: 0, hidden: null, visibility: '',
  };
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
    }),
  });
  const unsubRelay = settings.subscribe((changed) => {
    if (changed.some((k) => k.startsWith('cameraRelay') || k === 'ffmpegPath')) relay.sync();
  });

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
    // a client still connected is restarted onto the new settings.
    relay.sync();
    const s = settings.all();
    const model = findModel();
    // Freshness: an ack (or draw stamp) older than 5 s is not this page's current answer. The
    // overlay's beat is its own timer (`main.js` heartbeat), so `stale` now means the page itself
    // stopped reporting — a gone page — and not a document Chrome declined to paint. That case is
    // `renderLoop: 'stopped'` below. `none` stays `none` (no page ever reported — e.g. only the
    // preview iframe is open), never `stale`.
    const now = Date.now();
    const beat = Math.max(draw.lastAckAt, draw.lastDrawAt);
    const stale = beat > 0 && now - beat > PAGE_STALE_MS;
    const staleForMs = stale ? now - beat : 0;
    // The paint clock, read as its own state. `ackFresh` is the difference that matters: an acking
    // page whose loop is silent is alive and not painting (an occluded OBS source — Chrome sends a
    // document it does not composite no `requestAnimationFrame` at all), which is a real fault on
    // air and must not read as `stale`. `unknown` is the honest answer when no page ever reported,
    // or when the page stopped reporting altogether: then nothing is known about its loop.
    const loopIdleMs = draw.lastLoopAt > 0 ? Math.max(0, now - draw.lastLoopAt) : null;
    const ackFresh = draw.lastAckAt > 0 && now - draw.lastAckAt <= PAGE_STALE_MS;
    const renderLoop = !ackFresh || draw.lastLoopAt === 0 ? 'unknown' : loopIdleMs > LOOP_STALE_MS ? 'stopped' : 'running';
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
      // The page's last-acked source, and whether it is still current. `stale` is not a source:
      // it says the page has stopped reporting, so `effectiveSource` cannot be trusted either.
      effectiveSource: stale ? 'stale' : draw.anchors, // camera | synthetic | none | stale
      lastAckedSource: draw.anchors,
      stale,
      staleForMs,
      // What the page is running vs what this server serves. `null` before the first ack.
      build: BUILD,
      clientBuild: draw.build || null,
      buildMatches: draw.build ? draw.build === BUILD : null,
      // Whether the overlay is drawing at all, and on what: `none` means the page is open but no
      // loop has rendered (or no page is open), which is the state that looks like a dead source.
      draws: draw.draws,
      anchors: draw.anchors,
      lastDrawAt: draw.lastDrawAt,
      // The page's own beat: fresh here with `draws` frozen is a page that cannot paint. `renderLoop`
      // is that reading done properly — `running` | `stopped` | `unknown` — with `loopIdleMs` and
      // `hidden` saying how long and whether Chrome has marked the document as not composited.
      lastAckAt: draw.lastAckAt,
      renderLoop,
      loopIdleMs,
      loopTicks: draw.loopTicks,
      lastLoopAt: draw.lastLoopAt,
      hidden: draw.hidden,
      visibility: draw.visibility || null,
      // The overlay's camera answer: why it did not open (object or null) and what it did open.
      cameraError: camera.error,
      cameraLabel: camera.label,
      cameraSource: camera.source,
      relayError: camera.relayError,
      // The virtual camera's truth: off | waiting (no consumer, or connected and silent) | live
      // (a consumer is reading frames), plus the counters and the geometry both sides agreed on.
      publish: { ...pipe.status(), timing: publishTiming.at ? publishTiming : null },
      cameraFeed: relay.status(),
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
      { path: '/build', method: 'GET', handler: (req, res) => send(res, 200, { build: BUILD }) },
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
        handler: (req, res) => {
          relay.sync();
          if (!relay.enabled()) return send(res, 503, { ok: false, error: 'camera relay is off' });
          res.writeHead(200, {
            'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'cache-control': 'no-store',
          });
          relay.addClient(res);
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
          // OBS source look healthy (Math.max across clients below).
          if (bodyIn.preview === true) return send(res, 200, { ok: true, preview: true });
          if (bodyIn.source === 'body') {
            // The body page's beat: it is open and its camera is running. Timestamp only.
            body.pageOpen = bodyIn.open === true;
            if (body.pageOpen) body.lastPoseAt = Date.now();
            return send(res, 200, { ok: true });
          }
          if (Number.isFinite(bodyIn.maskAt) && bodyIn.maskAt > body.lastMaskAt) body.lastMaskAt = Math.min(Date.now(), bodyIn.maskAt);
          // The page's draw truth: monotonic counter, the anchor source, the last draw stamp.
          if (Number.isFinite(bodyIn.draws)) draw.draws = Math.max(draw.draws, Math.max(0, bodyIn.draws | 0));
          if (['camera', 'synthetic', 'none'].includes(bodyIn.anchors)) draw.anchors = bodyIn.anchors;
          if (Number.isFinite(bodyIn.lastDrawAt) && bodyIn.lastDrawAt > draw.lastDrawAt) {
            draw.lastDrawAt = Math.min(Date.now(), bodyIn.lastDrawAt);
          }
          // The paint clock: monotonic ticks and their last wall-clock stamp. A page reports these
          // whether or not it is painting, which is the whole point — a frozen pair here next to a
          // fresh `lastAckAt` is a document Chrome is not compositing, not a dead page.
          if (Number.isFinite(bodyIn.loopTicks)) draw.loopTicks = Math.max(draw.loopTicks, Math.max(0, bodyIn.loopTicks | 0));
          if (Number.isFinite(bodyIn.lastLoopAt) && bodyIn.lastLoopAt > draw.lastLoopAt) {
            draw.lastLoopAt = Math.min(Date.now(), bodyIn.lastLoopAt);
          }
          if (typeof bodyIn.hidden === 'boolean') draw.hidden = bodyIn.hidden;
          if (typeof bodyIn.visibility === 'string' && bodyIn.visibility.length <= 16) draw.visibility = bodyIn.visibility;
          // The bundle this document was loaded from (`?v=`), so a page left running across a
          // deploy is visible as a mismatch instead of looking healthy. Bounded: it is status.
          if (typeof bodyIn.build === 'string' && bodyIn.build) draw.build = bodyIn.build.slice(0, 64);
          // When the page last spoke at all. It is the page's own timer (`main.js` heartbeat), not
          // its render loop, so this stamp keeps moving in a document Chrome refuses to composite;
          // `draws`/`loopTicks` are what stay frozen there.
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
          events.emit('handfx', 'page', {
            effect: typeof bodyIn.effect === 'string' ? bodyIn.effect : null,
            tracking: bodyIn.tracking === true,
            model: ['idle', 'loading', 'ready', 'failed', 'cached'].includes(bodyIn.model) ? bodyIn.model : 'idle',
            hands: Number.isFinite(bodyIn.hands) ? Math.max(0, Math.min(4, bodyIn.hands | 0)) : 0,
            gesture: typeof bodyIn.gesture === 'string' ? bodyIn.gesture.slice(0, 40) : null,
            body: bodyIn.body === true,
            error: typeof bodyIn.error === 'string' ? bodyIn.error.slice(0, 240) : null,
            draws: draw.draws,
            anchors: draw.anchors,
            lastDrawAt: draw.lastDrawAt,
            at: Date.now(),
          });
          send(res, 200, { ok: true, ratio: effectiveRatio() });
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
