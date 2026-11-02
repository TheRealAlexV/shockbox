// Camera + hand tracking for the handfx overlay. Runs in the page; the server never sees a frame.
//
// One MediaPipe `HandLandmarker` in VIDEO mode, driven by requestAnimationFrame off the camera
// track. Because a browser gives one camera to one tab, a second tab (the pane's preview) cannot
// open the device — it follows this page's state over SSE instead and shows "camera held by the
// overlay" honestly.
//
// Runtime choice: the no-SIMD build is vendored whole and always works offline (see ../README.md
// for the three measurements). `vision_runtime: 'simd'` is accepted from settings and is passed to
// the SDK as its prefer flag, but the module reports the runtime it actually booted, never the one
// that was asked for.

/** The camera device is held by one document at a time; the pane's preview reads this page. */
export class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

const DEVICES = {
  '480p': { width: 640, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

import { makeHand, OPEN_PALM } from './pose.js';

const MODEL_CACHE = 'handfx:models-v1';
const MODEL_KEY_LOCAL = '/handfx/model/hand_landmarker.task?from=local';
const MODEL_KEY_CDN = '/handfx/model/hand_landmarker.task?from=cdn';

/** The wasm fileset the SDK is handed. Directory names match the module's vendor aliases. */
export function wasmFileset(base = '/api/handfx/vendor') {
  return {
    wasmLoaderPath: `${base}/vision-runtime-nosimd/wasm/vision_wasm_nosimd_internal.js`,
    wasmBinaryPath: `${base}/vision-runtime-nosimd/wasm/vision_wasm_nosimd_internal.wasm`,
    assetLoaderPath: undefined,
    assetBinaryPath: undefined,
  };
}

/**
 * Fetch the model once, keep the bytes in Cache Storage, serve them to the SDK from there. A
 * cache hit costs no network; a miss downloads from the module (a local file when the rig has
 * one) or the official model URL when it does not.
 *
 * Two cache keys, not one: the bytes in Cache Storage were indistinguishable by origin, so a copy
 * downloaded from the CDN in an earlier run was served to a page whose server now has the file on
 * disk, and nothing in the network panel or the resource timing could tell which had been used.
 * The key names its source, so a page that wants the local model never gets a CDN copy and the
 * browser evidence is readable.
 */
export async function fetchModel({ local, url, signal } = {}) {
  const source = local ? '/api/handfx/model' : url;
  if (!source) throw new Error('no model source');
  const key = local ? MODEL_KEY_LOCAL : MODEL_KEY_CDN;
  const cache = typeof caches !== 'undefined' ? await caches.open(MODEL_CACHE) : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { buffer: await hit.arrayBuffer(), cached: true, source, from: local ? 'local' : 'cdn' };
  }
  const res = await fetch(source, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status} from ${source}`);
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) throw new Error(`model download was empty: ${source}`);
  if (cache) {
    try {
      await cache.put(key, new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch {
      /* a full or disabled cache is not a failure: the bytes in hand are what matter */
    }
  }
  return { buffer, cached: false, source, from: local ? 'local' : 'cdn' };
}

/** Detection/tracking confidence from the pane's sensitivity (0.4–2), clamped sane. */
export function confidenceFor(sensitivity) {
  const s = Math.max(0.4, Math.min(2, Number(sensitivity) || 1));
  const min = 0.75 - (s - 1) * 0.25;
  return { minDetection: clamp(min, 0.2, 0.9), minTracking: clamp(min - 0.05, 0.2, 0.9) };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export class Tracker {
  constructor({ onFrame, onState } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onState = onState || (() => {});
    this.state = 'idle'; // idle | starting | running | error
    this.error = null;
    this.model = 'idle'; // idle | loading | ready | failed
    this.runtime = null; // 'nosimd' | 'simd'
    this.stream = null;
    this.video = null;
    this.landmarker = null;
    this.raf = 0;
    this.lastVideoTime = -1;
    this.lastFrameAt = 0;
    this.frames = 0;
    this.fps = 0;
    this.deviceLabel = '';
    // Where the camera acquisition failed (`enumerate` | `getUserMedia` | `track`) and the error's
    // own name, so the overlay can report what actually happened instead of a lone sentence.
    this.failStage = null;
    this.errorName = null;
    this.source = 'camera'; // camera | synthetic
    this.synthetic = null;
    // Where the model bytes came from (`local` = the module's own file, `cdn` = the model URL).
    this.modelSource = null;
    this._t0 = 0;
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      model: this.model,
      modelSource: this.modelSource,
      runtime: this.runtime,
      deviceLabel: this.deviceLabel,
      failStage: this.failStage,
      errorName: this.errorName,
      source: this.source,
      fps: this.fps,
      frames: this.frames,
    };
  }

  _setState(patch) {
    Object.assign(this, patch);
    this.onState(this.snapshot());
  }

  /** Open the camera. Must be called from a user gesture (the overlay's own start button, or a
   *  bus command that arrived while the page was already allowed). */
  async start(opts = {}) {
    if (this.state === 'running' || this.state === 'starting') return this.snapshot();
    this._setState({ state: 'starting', error: null });
    try {
      // Honest staging for the overlay's diagnostics: each failure below names the step it died at.
      this.failStage = 'enumerate';
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        const why = window.isSecureContext
          ? 'this browser exposes no camera API (navigator.mediaDevices missing)'
          : `an insecure origin (${location.origin}) — cameras need https or localhost/127.0.0.1`;
        throw new MediaError('no-media-devices', `No camera access: ${why}`);
      }
      if (!window.isSecureContext) {
        throw new MediaError(
          'insecure-context',
          `Camera blocked: ${location.origin} is not a secure context. Open http://127.0.0.1:PORT or http://localhost:PORT.`,
        );
      }
      const res = DEVICES[opts.resolution] || DEVICES['720p'];
      const video = { width: { ideal: res.width }, height: { ideal: res.height }, frameRate: { ideal: 30, max: 60 } };
      if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
      this.failStage = 'getUserMedia';
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      this.failStage = 'track';
      const stream = this.stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new MediaError('no-video-track', 'The camera stream carried no video track.');
      this.deviceLabel = track.label || 'camera';
      // A track that ends after a successful start (device unplugged, another app took it) is a
      // `track` failure, not a silent stop.
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return; // a later start owns the view now
        this.failStage = 'track';
        this._setState({
          state: 'error',
          errorName: 'TrackEnded',
          error: 'The camera track ended (device unplugged, or another app took the camera).',
        });
      });
      this._setState({ deviceLabel: this.deviceLabel, source: 'camera' });

      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      this.video.srcObject = this.stream;
      await this.video.play();

      if (!this.landmarker) await this._loadModel(opts);
      this.failStage = null;
      this.errorName = null;
      this._setState({ state: 'running', failStage: null, errorName: null });
      this._loop();
      return this.snapshot();
    } catch (err) {
      this.stop({ keepError: true });
      this._setState({
        state: 'error',
        error: describeError(err),
        errorName: (err && err.name) || 'Error',
        failStage: this.failStage || 'getUserMedia',
      });
      return this.snapshot();
    }
  }

  async _loadModel(opts) {
    if (this.model === 'ready') return;
    this._setState({ model: 'loading' });
    try {
      const mod = await import('/api/handfx/vendor/vision/vision_bundle.mjs');
      let model;
      try {
        model = await fetchModel({ local: opts.modelLocal, url: opts.modelUrl, signal: AbortSignal.timeout(45000) });
      } catch (err) {
        this._setState({ model: 'failed' });
        throw new MediaError('model', `Hand model unavailable: ${err.message}`);
      }
      const conf = confidenceFor(opts.sensitivity);
      let landmarker;
      try {
        landmarker = await mod.HandLandmarker.createFromOptions(wasmFileset(), {
          baseOptions: { modelAssetBuffer: new Uint8Array(model.buffer), delegate: 'GPU' },
          numHands: 2,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: conf.minDetection,
          minHandPresenceConfidence: conf.minDetection,
          minTrackingConfidence: conf.minTracking,
        });
        this._setState({ runtime: 'nosimd' });
      } catch (err) {
        // GPU delegate on a machine without WebGL2: retry on the CPU before calling it failed.
        try {
          landmarker = await mod.HandLandmarker.createFromOptions(wasmFileset(), {
            baseOptions: { modelAssetBuffer: new Uint8Array(model.buffer), delegate: 'CPU' },
            numHands: 2,
            runningMode: 'VIDEO',
            minHandDetectionConfidence: conf.minDetection,
            minHandPresenceConfidence: conf.minDetection,
            minTrackingConfidence: conf.minTracking,
          });
          this._setState({ runtime: 'nosimd-cpu' });
        } catch (err2) {
          this._setState({ model: 'failed' });
          throw new MediaError('model', `Hand model failed to load (${model.cached ? 'cached' : 'downloaded'} ${Math.round(model.buffer.byteLength / 1e6)} MB): ${err2.message}`);
        }
      }
      this.landmarker = landmarker;
      // Which copy was used is not visible from the picture: a CDN download and the module's own
      // file both end here as "ready". Keep it so the pane and the browser gate can ask.
      this.modelSource = { from: model.from, source: model.source, cached: model.cached, bytes: model.buffer.byteLength };
      this._setState({ model: 'ready' });
    } catch (err) {
      if (!(err instanceof MediaError)) this._setState({ model: 'failed' });
      throw err;
    }
  }

  _loop() {
    const tick = () => {
      if (this.state !== 'running' || !this.video) return;
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth && v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        try {
          const res = this.landmarker.detectForVideo(v, performance.now());
          const hands = res && res.landmarks ? res.landmarks.map((lm, i) => ({
            landmarks: lm,
            handedness: res.handedness && res.handedness[i] ? res.handedness[i][0].categoryName : null,
          })) : [];
          countFrame(this);
          this.onFrame({ hands, width: v.videoWidth, height: v.videoHeight, source: 'camera', at: performance.now() });
        } catch (err) {
          // A throw from the SDK is a real failure, not "no hands": say so once.
          this._setState({ state: 'error', error: `tracking threw: ${err.message}` });
          return;
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  stop({ keepError = false } = {}) {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (!keepError) {
      this._setState({ state: 'idle', error: null, fps: 0 });
      this.onFrame({ hands: [], width: 0, height: 0, source: this.source, at: performance.now() });
    }
  }

  /**
   * Replay a scripted hand motion with no camera at all — the frame is generated here and goes
   * through the same onFrame path the camera uses, so effects and gestures can be exercised on a
   * machine with no camera. The overlay marks the source `synthetic`, and nothing claims it is
   * tracking.
   */
  startSynthetic() {
    this.stop();
    this.source = 'synthetic';
    this._setState({ state: 'running', source: 'synthetic', error: null, deviceLabel: '', model: 'ready' });
    this._t0 = performance.now();
    const tick = () => {
      if (this.state !== 'running' || this.source !== 'synthetic') return;
      const t = (performance.now() - this._t0) / 1000;
      const hands = syntheticHands(t);
      countFrame(this);
      this.onFrame({ hands, width: 640, height: 480, source: 'synthetic', at: performance.now() });
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  dispose() {
    this.stop();
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        /* ignore */
      }
      this.landmarker = null;
    }
  }
}

function countFrame(self) {
  self.frames++;
  const now = performance.now();
  if (now - self.lastFrameAt > 1000) {
    self.fps = Math.round((self.frames / (now - self.lastFrameAt)) * 1000);
    self.frames = 0;
    self.lastFrameAt = now;
  }
}

function describeError(err) {
  const name = err && err.name;
  if (err instanceof MediaError) return err.message;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Allow camera for this origin and press start again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera matched the chosen device/resolution. Pick another camera or resolution.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is held by another app or tab (OBS, a browser tab). Close it and press start again.';
  return err && err.message ? err.message : String(err);
}

/* ---------------------------------------------------------------- synthetic hand */

// The canonical palm (pose.js) placed over time — the same geometry the classifier is tested on.
const TIPS = [4, 8, 12, 16, 20];

export function palmCentre(lm) {
  // Landmark 9 is the middle-finger MCP, the most stable palm point on a moving hand.
  const p = lm[9];
  return { x: p.x, y: p.y, z: p.z || 0 };
}

/** Palm width in unit space (wrist→middle MCP distance). */
export function handScale(lm) {
  return Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
}

/**
 * A 24 s loop at 640×480 that shows every gesture the effects react to:
 *   0–6   open palm up, drifting and breathing        → fireball
 *   6–12  both hands, index+middle arched together    → lightning
 *   12–18 open palm towards the camera                → spark ring
 *   18–24 one hand sliding across                     → smoke + embers
 * Unmirrored: mirroring is the renderer's job, exactly as with a camera.
 */
export function syntheticHands(t) {
  const phase = t % 24;
  if (phase < 6) {
    const k = Math.sin((phase / 6) * Math.PI);
    const lm = makeHand({ cx: 0.5 + Math.sin(t * 0.9) * 0.05, cy: 0.72, s: 0.42 + k * 0.18, rot: 0 });
    return [{ landmarks: lm, handedness: 'Left' }];
  }
  if (phase < 12) {
    const k = (phase - 6) / 6;
    // Fingertips angled at each other, tops of the hands level: blue balls at the fingertips.
    const g = 0.11 - Math.sin(k * Math.PI) * 0.035;
    // Both hands at the same height (the old project's "hands held level"), index and middle
    // extended, ring and pinky folded, fingertips pointed at each other.
    const curl = { ring: 0.95, pinky: 0.95 };
    const left = makeHand({ cx: 0.5 - g - 0.02, cy: 0.64, s: 0.24, rot: 2.9, curl });
    const right = makeHand({ cx: 0.5 + g, cy: 0.64, s: 0.24, rot: -2.9, right: true, curl });
    // Apex: index tips at the same height, above both knuckles (the arch's top).
    const apex = Math.min(left[5].y, right[5].y) - 0.08;
    for (const lm of [left, right]) lm[8].y = apex;
    // The hands stand further apart than the fingertips do, which is what makes them an arch.
    for (const [lm, sign] of [[left, -1], [right, 1]]) for (const p of lm) p.x += sign * g * 0.55;
    return [
      { landmarks: left, handedness: 'Left' },
      { landmarks: right, handedness: 'Right' },
    ];
  }
  if (phase < 18) {
    const k = (phase - 12) / 6;
    // Palm towards the camera: the whole hand reads shorter as it turns and nears.
    const lm = makeHand({ cx: 0.5, cy: 0.62, s: 0.3 + k * 0.1, rot: Math.PI });
    const palm = lm[9];
    for (const p of lm) {
      p.y = palm.y + (p.y - palm.y) * 0.5;
      p.z = -0.12;
    }
    return [{ landmarks: lm, handedness: 'Right' }];
  }
  const k = (phase - 18) / 6;
  // Sideways hand sliding across: fingers point up, palm turned edge-on to the camera.
  const lm = makeHand({ cx: 0.15 + k * 0.7, cy: 0.72 + Math.sin(k * Math.PI * 2) * 0.04, s: 0.42, rot: 0 });
  for (const p of lm) p.z = -0.08;
  return [{ landmarks: lm, handedness: 'Left' }];
}

export { TIPS, OPEN_PALM };
