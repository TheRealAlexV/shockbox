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

/** Every command the bus accepts. `reload` is handled by the page; nothing here is tracked. */
export const CMDS = ['effect.next', 'effect.prev', 'effect.set', 'tracking.toggle', 'mirror.toggle', 'reload'];

/**
 * The effect registry as the server knows it: ids only, never parameters. The page has the
 * implementations; the pane shows this list so the operator can order the module's effect list
 * without opening the page. `gesture` is documentation for the pane, not a contract.
 */
export const EFFECTS = [
  { id: 'fireball', title: 'Fireball', gesture: 'open palm up', from: 'fireball-controller/main.py' },
  { id: 'lightning', title: 'Lightning fingers', gesture: 'both hands, fingertips arched together', from: 'handfx_filter (Hand FX)' },
  { id: 'sparkring', title: 'Spark ring', gesture: 'open palm towards the camera', from: 'handfx_filter (Hand FX)' },
  { id: 'embers', title: 'Ember rise', gesture: 'any hand', from: 'handfx_filter (Hand FX)' },
  { id: 'smoke', title: 'Smoke veil', gesture: 'sideways hand / swipe', from: 'handfx_filter (Hand FX)' },
];

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
  for (const dir of MODEL_DIRS) {
    const f = path.join(dir, MODEL_NAME);
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
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
      runtime: {
        vendored: fs.existsSync(path.join(VENDOR, 'vision', 'vision_bundle.mjs')),
        simdWasm: fs.existsSync(path.join(VENDOR, 'vision', 'simd-wasm', 'vision_wasm_internal.wasm')),
        nosimdWasm: fs.existsSync(path.join(VENDOR, 'vision', 'wasm-nosimd', 'vision_wasm_nosimd_internal.wasm')),
        base: '/api/handfx/vendor',
      },
      page: '/handfx',
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
      {
        path: '/ack',
        method: 'POST',
        handler: async (req, res, url, body) => {
          body = body && typeof body === 'object' ? body : {};
          events.emit('handfx', 'page', {
            effect: typeof body.effect === 'string' ? body.effect : null,
            tracking: body.tracking === true,
            model: ['idle', 'loading', 'ready', 'failed', 'cached'].includes(body.model) ? body.model : 'idle',
            hands: Number.isFinite(body.hands) ? Math.max(0, Math.min(4, body.hands | 0)) : 0,
            gesture: typeof body.gesture === 'string' ? body.gesture.slice(0, 40) : null,
            error: typeof body.error === 'string' ? body.error.slice(0, 240) : null,
            at: Date.now(),
          });
          send(res, 200, { ok: true });
        },
      },

      {
        path: '/model',
        method: 'GET',
        handler: (req, res) => {
          const model = findModel();
          if (!model) {
            return send(res, 404, { ok: false, error: 'no local model', url: MODEL_URL });
          }
          const st = fs.statSync(model);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            // Cached for a day: re-read is cheap, and a new model file swaps on restart anyway.
            'cache-control': 'public, max-age=86400',
            'content-length': st.size,
          });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(model).pipe(res);
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
