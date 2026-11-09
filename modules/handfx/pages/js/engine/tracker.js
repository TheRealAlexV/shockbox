// Camera + hand tracking for the ShockFX overlay (module id `handfx`). Runs in the page; the server never sees a frame.
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

/** How long a detect may stay unanswered before the detector thread is presumed dead. */
export const DETECT_TIMEOUT = 3000;
/** The same patience for a rebuilt worker's handshake: a wasm compile is slower than a frame. */
export const INIT_TIMEOUT = 10000;
/** Consecutive deadlines, with no ready+result between them, before tracking is called failed. */
export const HANG_LIMIT = 3;

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
  constructor({ onFrame, onState, worker, clock, task } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onState = onState || (() => {});
    // The worker's graph. The overlay drives hands; a page that needs another graph starts its own
    // worker with that task rather than changing this one's shape.
    this.task = task || 'hand';
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
    // Stamped on every frame, unlike `lastFrameAt`, which only moves when the fps window rolls.
    this._lastFrameSeenAt = 0;
    this.frames = 0;
    this.fps = 0;
    // The last *completed* detection result, written by `_onMessage` and read by `snapshot()`. Kept
    // here so the snapshot is a pure read before `start()`, with no worker, and in `error` too.
    this._lastHands = 0;
    this._lastLandmarks = 0;
    this._lastDetectAt = null;
    // Worker results that found a hand versus found none. `handsOf` collapses "no hands" and
    // "nothing came back" to the same `[]`, so only these separate the two cases.
    this._detects = 0;
    this._empties = 0;
    this.deviceLabel = '';
    // Where the camera acquisition failed (`enumerate` | `getUserMedia` | `track`) and the error's
    // own name, so the overlay can report what actually happened instead of a lone sentence.
    this.failStage = null;
    this.errorName = null;
    this.source = 'camera'; // camera | synthetic
    // How the frames arrive: `device` is a getUserMedia track, `relay` decoded MJPEG from the
    // server. `source` stays 'camera' either way — these are camera anchors, not a replay.
    this.feed = null; // device | relay | null
    // The geometry the relay path draws into; the device path takes it from the track.
    this.size = DEVICES['720p'];
    this._frameCanvas = null;
    this.synthetic = null;
    // Where the model bytes came from (`local` = the module's own file, `cdn` = the model URL).
    this.modelSource = null;
    this._t0 = 0;

    // Detection runs in a classic worker (overlay/hand-worker.js), not on this thread: the wasm
    // graph's final fence waits forever on a lost GPU context, and nothing on the main thread can
    // pre-empt it. The page keeps one frame in flight and one queued — newest wins.
    this._worker = null;
    this._workerReady = false;
    this._bootWait = null; // {resolve, reject} for the init handshake in progress
    this._pending = null; // {bitmap, at, width, height} — single slot, newest wins
    this._inflight = null; // the frame the worker is chewing on
    this._busy = false;
    this._sentAt = 0;
    this._hangTimer = 0;
    this._hangCount = 0; // consecutive deadlines with no ready+result in between
    this._seq = 0;
    this._modelBuffer = null; // the fetched bytes, kept so a rebuilt worker need not refetch
    this._options = null; // createFromOptions options, replayed on every rebuild
    this._fileset = null;

    // Test seams: a fake worker and a fake clock let the hang policy be proven without a browser.
    this._newWorker = worker || (() => new Worker(new URL('../overlay/hand-worker.js', import.meta.url)));
    this._now = (clock && clock.now) || (() => performance.now());
    this._setTimer = clock && clock.setTimeout ? (fn, ms) => clock.setTimeout(fn, ms) : (fn, ms) => setTimeout(fn, ms);
    this._clearTimer = clock && clock.clearTimeout ? (id) => clock.clearTimeout(id) : (id) => clearTimeout(id);
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
      feed: this.feed,
      fps: this.fps,
      frames: this.frames,
      // The last completed detection result, not the last frame submitted: `at` is stamped where
      // the worker's answer lands, so a stalled worker shows a frozen `lastDetectAt` and a growing
      // `lastFrameAgeMs`. Every field has a default, so this is safe before `start()`.
      hands: Number.isFinite(this._lastHands) ? this._lastHands : 0,
      landmarks: Number.isFinite(this._lastLandmarks) ? this._lastLandmarks : 0,
      lastDetectAt: Number.isFinite(this._lastDetectAt) ? this._lastDetectAt : null,
      // `lastFrameAt` is a `performance.now()` mark (see `countFrame`), so its age is measured on the
      // same clock; `Date.now()` here would be the epoch offset, not an age. `_lastFrameSeenAt`
      // moves on every frame; `lastFrameAt` only when the fps window rolls.
      lastFrameAgeMs: this._lastFrameSeenAt ? Math.max(0, Math.round(performance.now() - this._lastFrameSeenAt)) : null,
      hangCount: Number.isFinite(this._hangCount) ? this._hangCount : 0,
      // Cumulative worker results with at least one hand, versus with none.
      detects: Number.isFinite(this._detects) ? this._detects : 0,
      empties: Number.isFinite(this._empties) ? this._empties : 0,
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
      this.failStage = 'getUserMedia';
      this.stream = await this._openCamera(opts);
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
      this._setState({ deviceLabel: this.deviceLabel, source: 'camera', feed: 'device' });

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

  /**
   * The camera request, in the only order a browser allows it. Before the page holds a grant,
   * `enumerateDevices()` hands out devices with an empty `deviceId` and an empty label; passing
   * that id back as `deviceId: { exact: '' }` is an OverconstrainedError no camera can satisfy.
   * So the first request names nothing at all (`{ video: true }`), and the operator's device and
   * resolution are asked for afterwards — the id only when an enumerate *after* the grant offers
   * it, the resolution only as `ideal`. A refused preference keeps the plain stream: a camera
   * that is already open is never given up for a nicer size.
   */
  async _openCamera(opts = {}) {
    const md = navigator.mediaDevices;
    const plain = await md.getUserMedia({ video: true, audio: false });
    let devices = [];
    try {
      devices = await md.enumerateDevices();
    } catch {
      devices = [];
    }
    const wanted = String(opts.deviceId || '').trim();
    const named = Boolean(wanted) && devices.some((d) => d.kind === 'videoinput' && d.deviceId === wanted);
    const res = DEVICES[opts.resolution] || DEVICES['720p'];
    const track = plain.getVideoTracks()[0];
    const got = (track && typeof track.getSettings === 'function' && track.getSettings()) || {};
    if (!named && Number(got.height || 0) >= res.height) return plain;
    const video = { width: { ideal: res.width }, height: { ideal: res.height }, frameRate: { ideal: 30 } };
    if (named) video.deviceId = { exact: wanted };
    try {
      const better = await md.getUserMedia({ video, audio: false });
      for (const t of plain.getTracks()) t.stop();
      return better;
    } catch {
      return plain; // the operator's preference is not worth a dead picture
    }
  }

  async _loadModel(opts) {
    // The loaded SDK is the truth, not the `model` label: the synthetic rig labels itself 'ready'
    // without one, and a camera started after it then crashed in detectForVideo.
    if (this.landmarker) return;
    this._setState({ model: 'loading' });
    try {
      let model;
      try {
        model = await fetchModel({ local: opts.modelLocal, url: opts.modelUrl, signal: AbortSignal.timeout(45000) });
      } catch (err) {
        this._setState({ model: 'failed' });
        throw new MediaError('model', `Hand model unavailable: ${err.message}`);
      }
      const conf = confidenceFor(opts.sensitivity);
      // The bytes stay here: a worker that hangs is terminated and rebuilt, and downloading the
      // model again to recover from a frozen GPU context would turn a hiccup into an outage.
      this._modelBuffer = model.buffer;
      this._fileset = wasmFileset();
      this._options = {
        numHands: 2,
        runningMode: 'VIDEO',
        minHandDetectionConfidence: conf.minDetection,
        minHandPresenceConfidence: conf.minDetection,
        minTrackingConfidence: conf.minTracking,
      };
      await this._initDetector();
      // Which copy was used is not visible from the picture: a CDN download and the module's own
      // file both end here as "ready". Keep it so the pane and the browser gate can ask.
      this.modelSource = { from: model.from, source: model.source, cached: model.cached, bytes: model.buffer.byteLength };
      this._setState({ model: 'ready' });
    } catch (err) {
      if (!(err instanceof MediaError)) this._setState({ model: 'failed' });
      throw err;
    }
  }

  /**
   * Start the detector worker and wait for its handshake. Split out of `_loadModel` because a
   * rebuild after a hang already has the bytes and the options and must not refetch.
   */
  async _initDetector() {
    if (!this._modelBuffer) throw new MediaError('model', 'Hand model unavailable: no bytes to hand the detector');
    const runtime = await this._bootWorker();
    // The handle the rest of the class gates on (`pushFrame`, `startRelay`, `dispose`): truthy once
    // a detector exists; its `close()` shuts the worker down.
    this.landmarker = { worker: true, close: () => this._stopWorker() };
    this._setState({ runtime });
  }

  /**
   * The relayed camera: the same landmarker and the same `onFrame` contract as `start()`, driven
   * by decoded MJPEG frames instead of a <video>. No getUserMedia and no track to lose.
   */
  async startRelay(opts = {}) {
    if (this.state === 'running' || this.state === 'starting') return this.snapshot();
    this._setState({ state: 'starting', error: null });
    this.failStage = 'track';
    try {
      if (!this.landmarker) await this._loadModel(opts);
      this.size = DEVICES[opts.resolution] || DEVICES['720p'];
      this.failStage = null;
      this.errorName = null;
      this._setState({ state: 'running', source: 'camera', feed: 'relay', failStage: null, errorName: null });
      return this.snapshot();
    } catch (err) {
      this.stop({ keepError: true });
      this._setState({
        state: 'error',
        error: describeError(err),
        errorName: (err && err.name) || 'Error',
        failStage: this.failStage || 'track',
      });
      return this.snapshot();
    }
  }

  /** The surface the publisher may composite: the camera element, or the relay's frame canvas. */
  frameSurface() {
    return this.feed === 'relay' ? this._frameCanvas : this.video;
  }

  /**
   * One relayed frame. Drawn at the tracker's own geometry and detected through the same entry
   * point the camera loop uses, so a relayed frame is a camera frame to everything downstream.
   */
  pushFrame(bitmap, at = performance.now()) {
    if (this.state !== 'running' || !this.landmarker) return false;
    // A synthetic rig (`startSynthetic` clears `feed` via `stop()`) is the only other live feed.
    // The relay socket is already open, so nothing calls `startRelay` again after a recovery
    // cycle: the next relayed bitmap has to take tracking back itself or it is dropped forever.
    if (this.feed !== 'relay' && this.source !== 'synthetic') return false;
    const reclaim = this.feed !== 'relay';
    const { width, height } = this.size;
    let c = this._frameCanvas;
    if (!c) c = this._frameCanvas = document.createElement('canvas');
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    const g = c.getContext('2d');
    if (!g) return false;
    // The underlay paints this canvas (main.js), so the drawn copy keeps happening here even
    // though detection now reads the bitmap on the other thread.
    g.drawImage(bitmap, 0, 0, width, height);
    const accepted = this._submit(bitmap, at, width, height);
    // Reclaim only once the worker has taken the frame: cancelling the synthetic rig on a frame
    // the dead worker refused would leave the page with no feed at all.
    if (accepted && reclaim) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.synthetic = null;
      this._t0 = 0;
      console.log('handfx tracker: relay reclaimed tracking from synthetic');
      this._setState({ source: 'camera', feed: 'relay' });
    }
    return accepted;
  }

  /**
   * Hand one frame to the detector thread. One in flight, one queued, newest wins: a detector that
   * runs slower than the camera must not build a backlog of stale poses.
   */
  _submit(bitmap, at, width, height) {
    if (!this._worker && !this._startWorker()) return false;
    // A queued frame nobody has sent yet is ours to release; the one in flight was transferred.
    if (this._pending && typeof this._pending.bitmap.close === 'function') this._pending.bitmap.close();
    this._pending = { bitmap, at, width, height };
    this._flush();
    return true;
  }

  _flush() {
    if (!this._worker || !this._workerReady || this._busy || !this._pending) return;
    const frame = this._pending;
    this._pending = null;
    this._busy = true;
    this._inflight = frame;
    this._seq += 1;
    this._arm(DETECT_TIMEOUT);
    try {
      // Transferred, not copied: a 720p bitmap is megabytes and this runs 30 times a second. The
      // page's other holder is relay.js, whose `close()` on a detached bitmap is a no-op.
      this._worker.postMessage(
        { type: 'detect', bitmap: frame.bitmap, at: frame.at, seq: this._seq, size: { width: frame.width, height: frame.height } },
        [frame.bitmap],
      );
    } catch {
      // Already detached (a consumer closed it): drop this frame rather than wedge the sender.
      this._clearTimer(this._hangTimer);
      this._hangTimer = 0;
      this._busy = false;
      this._inflight = null;
      if (typeof frame.bitmap.close === 'function') frame.bitmap.close();
      this._flush();
    }
  }

  _arm(ms) {
    this._clearTimer(this._hangTimer);
    this._sentAt = this._now();
    this._hangTimer = this._setTimer(() => this._onHang(), ms);
  }

  /**
   * A deadline with no answer: the detector thread is gone, or its GPU fence is never coming back.
   * Nothing on the page can pre-empt that call, so the only cure is terminate() and a fresh thread.
   */
  _onHang() {
    this._hangTimer = 0;
    this._hangCount += 1;
    const dead = this._inflight;
    this._inflight = null;
    this._busy = false;
    this._stopWorker();

    if (this._hangCount >= HANG_LIMIT) {
      if (this._pending) {
        if (typeof this._pending.bitmap.close === 'function') this._pending.bitmap.close();
        this._pending = null;
      }
      this._setState({ state: 'error', error: 'tracking stalled: detector stopped responding' });
      return;
    }

    this._startWorker();
    // A rebuild that never becomes ready has to reach the limit too, or the page keeps a dead
    // thread and never says so. Only armed when the handshake has not already come back.
    if (!this._workerReady) this._arm(INIT_TIMEOUT);
    // The pose it was showing is a guess now: say "no hands" once so effects drop instead of
    // freezing a stale hand in place.
    if (this._hangCount === 1) {
      this.onFrame({
        hands: [],
        width: (dead && dead.width) || 0,
        height: (dead && dead.height) || 0,
        source: 'camera',
        at: this._now(),
      });
    }
    this._flush();
  }

  _startWorker() {
    this._workerReady = false;
    let worker;
    try {
      worker = this._newWorker();
    } catch (err) {
      const wait = this._bootWait;
      this._bootWait = null;
      if (wait) wait.reject(err);
      return null;
    }
    worker.onmessage = (ev) => this._onMessage(ev);
    worker.onerror = (ev) => this._onWorkerError(ev);
    this._worker = worker;
    worker.postMessage({
      type: 'init',
      task: this.task,
      fileset: this._fileset,
      options: this._options,
      // A copy: the page keeps the original for the next rebuild.
      modelBuffer: this._modelBuffer ? this._modelBuffer.slice(0) : null,
    });
    return worker;
  }

  _bootWorker() {
    const ready = new Promise((resolve, reject) => {
      this._bootWait = { resolve, reject };
    });
    this._startWorker();
    return ready;
  }

  _stopWorker() {
    this._workerReady = false;
    if (!this._worker) return;
    try {
      this._worker.postMessage({ type: 'close' });
    } catch {
      /* the thread is already gone */
    }
    try {
      this._worker.terminate();
    } catch {
      /* same */
    }
    this._worker = null;
  }

  _onMessage(ev) {
    const msg = (ev && ev.data) || {};

    if (msg.type === 'ready') {
      this._workerReady = true;
      const wait = this._bootWait;
      this._bootWait = null;
      if (wait) wait.resolve(msg.runtime || null);
      this._flush();
      return;
    }

    if (msg.type === 'error') {
      const wait = this._bootWait;
      this._bootWait = null;
      if (wait) {
        wait.reject(new MediaError('model', `Hand model failed to load: ${msg.error}`));
        return;
      }
      this._stopWorker();
      this._setState({ state: 'error', error: `tracking threw: ${msg.error}` });
      return;
    }

    if (msg.type !== 'result') return;
    // A result from a worker that was terminated or a session that stopped: nobody wants it.
    if (msg.seq !== this._seq) return;
    // After the third deadline the page has said tracking failed: a frame that lands now would
    // revive exactly the claim it just dropped.
    if (this.state !== 'running') return;
    this._clearTimer(this._hangTimer);
    this._hangTimer = 0;
    this._busy = false;
    // Reset only here, never on `ready` alone: a worker that handshakes and then hangs forever must
    // reach the limit instead of terminate-looping behind a page that still claims to track.
    this._hangCount = 0;
    // The detection result is the only place these advance. Recorded before the frame is handed on
    // so `snapshot()` never has to parse the frame itself.
    this._lastHands = Array.isArray(msg.hands) ? msg.hands.length : 0;
    if (this._lastHands > 0) this._detects += 1;
    else this._empties += 1;
    this._lastLandmarks = Array.isArray(msg.hands)
      ? msg.hands.reduce((n, h) => n + (h && Array.isArray(h.landmarks) ? h.landmarks.length : 0), 0)
      : 0;
    this._lastDetectAt = Date.now();
    const frame = this._inflight;
    this._inflight = null;
    countFrame(this);
    this.onFrame({
      hands: msg.hands || [],
      width: (frame && frame.width) || 0,
      height: (frame && frame.height) || 0,
      source: 'camera',
      at: msg.at != null ? msg.at : frame ? frame.at : this._now(),
    });
    this._flush();
  }

  _onWorkerError(ev) {
    // An uncaught throw in the worker. During the handshake it is a load failure; after it, the
    // detector is gone and the page must stop claiming a camera it cannot read.
    const wait = this._bootWait;
    this._bootWait = null;
    const error = new MediaError('model', `detector worker failed: ${(ev && ev.message) || 'worker error'}`);
    if (wait) {
      wait.reject(error);
      return;
    }
    this._setState({ state: 'error', error: error.message });
  }

  _loop() {
    const tick = () => {
      if (this.state !== 'running' || !this.video) return;
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth && v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        // The worker takes a bitmap, not a <video>: decode off the loop so a slow read never holds
        // the rAF tick. A frame still in flight means its successor is newer anyway.
        if (!this._busy && !this._pending) {
          const at = this._now();
          const width = v.videoWidth;
          const height = v.videoHeight;
          createImageBitmap(v)
            .then((bmp) => {
              if (!this._submit(bmp, at, width, height)) bmp.close();
            })
            .catch(() => {
              /* a frame that will not decode is a dropped frame, not an error */
            });
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
    this.feed = null;
    // Whatever the detector was chewing on belongs to the session that just ended: bump the
    // sequence so a late result is dropped instead of reviving a claim the page has given up, and
    // release the frame that never got sent. The worker itself stays up: the next start reuses it.
    this._clearTimer(this._hangTimer);
    this._hangTimer = 0;
    this._busy = false;
    this._inflight = null;
    this._seq += 1;
    if (this._pending) {
      if (typeof this._pending.bitmap.close === 'function') this._pending.bitmap.close();
      this._pending = null;
    }
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
      try {
        const t = (performance.now() - this._t0) / 1000;
        const hands = syntheticHands(t, { twoHands: this.syntheticTwoHands === true });
        countFrame(this);
        this.onFrame({ hands, width: 640, height: 480, source: 'synthetic', at: performance.now() });
      } finally {
        // A consumer that throws (the page's onFrame) must not end the rig: the picture and the
        // page's status line both ride on these frames.
        if (this.state === 'running' && this.source === 'synthetic') this.raf = requestAnimationFrame(tick);
      }
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
  self._lastFrameSeenAt = now;
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
export function syntheticHands(t, { twoHands = false } = {}) {
  if (twoHands) return twoHandedHands(t);
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

/**
 * Two hands for the whole run, for the effects whose gesture needs a second hand (lightning,
 * disco, embers, bloomlife, slime). A 12 s cycle: the arched pair, then both palms raised. The
 * overlay asks for this while the current effect's gesture is a two-hand one, so the rig never
 * shows one floating hand next to a gesture that cannot be made with one.
 */
function twoHandedHands(t) {
  const cycle = t % 12;
  const sway = Math.sin(t * 0.45) * 0.03;
  if (cycle < 6) {
    const breath = (Math.sin(t * 1.1) + 1) / 2;
    const g = 0.11 - breath * 0.035;
    const curl = { ring: 0.95, pinky: 0.95 };
    const left = makeHand({ cx: 0.48 - g + sway, cy: 0.66, s: 0.24, rot: 2.9, curl });
    const right = makeHand({ cx: 0.52 + g + sway, cy: 0.66, s: 0.24, rot: -2.9, right: true, curl });
    const apex = Math.min(left[5].y, right[5].y) - 0.08;
    for (const lm of [left, right]) lm[8].y = apex;
    for (const [lm, sign] of [[left, -1], [right, 1]]) for (const p of lm) p.x += sign * g * 0.55;
    return [
      { landmarks: left, handedness: 'Left' },
      { landmarks: right, handedness: 'Right' },
    ];
  }
  const lift = Math.sin(((cycle - 6) / 6) * Math.PI) * 0.06;
  const left = makeHand({ cx: 0.35 + sway, cy: 0.62 - lift, s: 0.26, rot: 0.22 });
  const right = makeHand({ cx: 0.65 + sway, cy: 0.62 - lift, s: 0.26, rot: -0.22, right: true });
  return [
    { landmarks: left, handedness: 'Left' },
    { landmarks: right, handedness: 'Right' },
  ];
}

export { TIPS, OPEN_PALM };
