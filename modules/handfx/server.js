// Hand FX module — the server half.
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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  { id: 'lightning', title: 'Lightning fingers', gesture: 'both hands, fingertips arched together', from: 'handfx_filter (Hand FX)' },
  { id: 'sparkring', title: 'Spark ring', gesture: 'open palm towards the camera', from: 'handfx_filter (Hand FX)' },
  { id: 'embers', title: 'Ember rise', gesture: 'any hand', from: 'handfx_filter (Hand FX)' },
  { id: 'smoke', title: 'Smoke veil', gesture: 'sideways hand / swipe', from: 'handfx_filter (Hand FX)' },
  { id: 'aura', title: 'Aura outline', gesture: 'any hand', from: 'handfx_filter (Hand FX)' },
  { id: 'wires', title: 'Wire skeleton', gesture: 'any hand (follows the skeleton)', from: 'handfx_filter (Hand FX)' },
  { id: 'frost', title: 'Frost creep', gesture: 'open palm towards the camera', from: 'handfx_filter (Hand FX)' },
  { id: 'portal', title: 'Portal ring', gesture: 'open palm towards the camera', from: 'handfx_filter (Hand FX)' },
  { id: 'disco', title: 'Disco ball', gesture: 'both hands raised', from: 'handfx_filter (Hand FX)' },
  { id: 'slime', title: 'Slime drip', gesture: 'palms together', from: 'handfx_filter (Hand FX)' },
  { id: 'inkflow', title: 'Ink flow', gesture: 'swipe', from: 'handfx_filter (Hand FX)' },
  { id: 'shatter', title: 'Shatter shards', gesture: 'fist', from: 'handfx_filter (Hand FX)' },
  { id: 'cyber', title: 'Cyber glitch', gesture: 'fist', from: 'handfx_filter (Hand FX)' },
  { id: 'bloomlife', title: 'Bloom life', gesture: 'both palms up', from: 'handfx_filter (Hand FX)' },
  { id: 'echo', title: 'Echo trails', gesture: 'any hand', from: 'handfx_filter (Hand FX)' },
  { id: 'bodyonfire', title: 'Body on fire', gesture: 'body page sees a body', from: 'handfx body page (PoseLandmarker)' },
  { id: 'bodysmoke', title: 'Body smoke', gesture: 'body page sees a body', from: 'handfx body page (PoseLandmarker)' },
  { id: 'frozenbody', title: 'Frozen body', gesture: 'body page sees a body', from: 'handfx body page (PoseLandmarker)' },
  { id: 'edit', title: 'Hand edit', gesture: 'fist (draws where the fingertips point)', from: 'handfx_filter (Hand FX)' },
  { id: 'electroshock', title: 'Electro shockwave', gesture: 'open palm towards the camera', from: 'handfx_filter (Hand FX)' },
  { id: 'meteor', title: 'Meteor', gesture: 'both hands raised', from: 'handfx_filter (Hand FX)' },
  { id: 'shoot', title: 'Shoot', gesture: 'point (index only)', from: 'handfx_filter (Hand FX)' },
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
  // Body-tracking status: updated only by the overlay's /ack (a timestamp, never a frame) and by
  // the body page's own /ack. Read back on /status so the pane can say whether a mask is arriving.
  const body = { lastMaskAt: 0, pageOpen: false, lastPoseAt: 0 };

  function publish(cmd, args) {
    const rec = events.publish('handfx', cmd, { ...args, at: Date.now(), id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` });
    lastCmd = { cmd, args, seq: rec?.seq ?? null, at: Date.now() };
    return rec;
  }

  function status() {
    const s = settings.all();
    const model = findModel();
    return {
      cmds: CMDS,
      effects: EFFECTS,
      model: { local: Boolean(model), name: MODEL_NAME, url: MODEL_URL },
      bodyModels: bodyModels(),
      body: { lastMaskAt: body.lastMaskAt, pageOpen: body.pageOpen && Date.now() - body.lastPoseAt < 5000, lastPoseAt: body.lastPoseAt },
      runtime: {
        vendored: fs.existsSync(path.join(VENDOR, 'vision', 'vision_bundle.mjs')),
        simdWasm: fs.existsSync(path.join(VENDOR, 'vision', 'simd-wasm', 'vision_wasm_internal.wasm')),
        nosimdWasm: fs.existsSync(path.join(VENDOR, 'vision', 'wasm-nosimd', 'vision_wasm_nosimd_internal.wasm')),
        base: '/api/handfx/vendor',
      },
      page: '/handfx',
      bodyPage: '/handfx/body',
      // The page is isolated by the headers its manifest entry declares (COOP/COEP); the pane
      // reads this to say plainly whether a browser tab of /handfx will be a secure, isolated
      // document — it is the operator's camera permission that depends on it.
      isolation: { crossOriginOpenerPolicy: 'same-origin', crossOriginEmbedderPolicy: 'require-corp' },
      settings: settings.describe(),
      lastCmd,
    };
  }

  const api = {
    channels: ['handfx'],

    routes: [
      // Everything the pane and the page need in one read: the settings document, the effect
      // registry, the bus contract and whether the vendored runtime is on disk.
      { path: '/status', method: 'GET', handler: (req, res) => send(res, 200, status()) },
      // The bare list a client may expect from the page's own registry — `Object.keys(EFFECTS)`,
      // strings in renderer order. `/status` carries the same ids with their titles and gestures;
      // this one exists so "the effects" is never a shape a client has to unpack to get right.
      {
        path: '/effects',
        method: 'GET',
        handler: (req, res) => send(res, 200, EFFECTS.map((e) => e.id)),
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
            const changed = settings.patch(patch);
            return send(res, 200, { ok: true, changed, settings: settings.describe() });
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
            return send(res, 200, { ok: true, changed, enabled: settings.get('enabled'), settings: settings.describe() });
          }
          if (cmd === 'mirror.toggle') {
            const changed = settings.patch({ mirror: !settings.get('mirror') });
            publish(cmd, { ...args, mirror: settings.get('mirror') });
            return send(res, 200, { ok: true, changed, mirror: settings.get('mirror'), settings: settings.describe() });
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
              return send(res, 200, { ok: true, changed, settings: settings.describe() });
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
          if (bodyIn.source === 'body') {
            // The body page's beat: it is open and its camera is running. Timestamp only.
            body.pageOpen = bodyIn.open === true;
            if (body.pageOpen) body.lastPoseAt = Date.now();
            return send(res, 200, { ok: true });
          }
          if (Number.isFinite(bodyIn.maskAt) && bodyIn.maskAt > body.lastMaskAt) body.lastMaskAt = Math.min(Date.now(), bodyIn.maskAt);
          events.emit('handfx', 'page', {
            effect: typeof bodyIn.effect === 'string' ? bodyIn.effect : null,
            tracking: bodyIn.tracking === true,
            model: ['idle', 'loading', 'ready', 'failed', 'cached'].includes(bodyIn.model) ? bodyIn.model : 'idle',
            hands: Number.isFinite(bodyIn.hands) ? Math.max(0, Math.min(4, bodyIn.hands | 0)) : 0,
            gesture: typeof bodyIn.gesture === 'string' ? bodyIn.gesture.slice(0, 40) : null,
            body: bodyIn.body === true,
            error: typeof bodyIn.error === 'string' ? bodyIn.error.slice(0, 240) : null,
            at: Date.now(),
          });
          send(res, 200, { ok: true });
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
    },

    dispose() {
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
