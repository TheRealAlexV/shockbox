// The body tracking page: its own small OBS browser source (1×1 or a few hundred pixels).
//
// It runs two MediaPipe tasks on the camera — PoseLandmarker (33 body landmarks) and ImageSegmenter
// (a person mask), each in its own worker (`pages/js/overlay/hand-worker.js`, `init.task`) so no
// inference ever runs on this page's main thread — and hands the mask to the overlay page
// (`pages/overlay.html`) over
// `BroadcastChannel('handfx.body')` as one ImageBitmap plus `{w, h, pose, at}`. No frame is ever
// posted, encoded or fetched: the bitmap is a transferred in-process object the overlay uploads to
// a GL texture and closes. The overlay's own /ack carries a timestamp, never pixels.
//
// Why a separate page at all: a browser gives one camera to one document. The overlay already
// holds the camera for the hands; this page needs its own camera feed for the body, and a second
// Browser Source in OBS can own a second device (or the operator picks the same one on a rig where
// two documents may read it). If the two sources cannot see each other's channel, this page says
// so after 2 s instead of pretending: that is the honest failure mode, not a silent one.
//
// Runtime: the same vendored tasks-vision bundle the overlay uses (vendor/vision 0.10.14, no-SIMD
// build). The two model files are fetched once each, through the module's /api/handfx/model route
// (local when the rig has them) and kept in Cache Storage by the same `fetchModel` helper.
//
// TWO MODES, ONE FILE
// `?embed=1` mounts this page in the ShockFX pane. Embed is a viewer and nothing else: it never
// opens the camera, never posts on `handfx.body` and never calls /ack. Each of those has exactly
// one owner, the OBS body source, and a second owner is a fault rather than a duplicate: a second
// camera open steals the device, two publishers interleave mask streams, and a second heartbeat
// marks the body closed while the live source is still running. The guard is code, not this note:
// see EMBED in `post()`, `publishMask()`, `start()` and the heartbeat in `loop()`.

import { wasmFileset, DETECT_TIMEOUT, INIT_TIMEOUT, HANG_LIMIT } from '../engine/tracker.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('mask');
const statusEl = $('status');

const MODEL_CACHE = 'handfx:body-models-v1';
const POSE_KEY = '/handfx/model/pose_landmarker_lite.task';
const SEG_KEY = '/handfx/model/selfie_segmenter.tflite';
const CHANNEL = 'handfx.body';
// The pane's embed talks to the OBS body source on a second channel, never on CHANNEL: the
// 'handfx.body' publisher stays unique to OBS, and the embed only ever listens there.
const CTL = 'handfx.body.ctl';
// ?embed=1 mounts this page in the admin pane. Embed is a viewer: no camera, no publish, no beat.
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
// Masks are throttled to ~15 Hz: the shaders sample them as soft silhouettes, and a 60 Hz mask
// would cost an upload, a copy and a GLEMA step per camera frame for no visible difference.
const MASK_HZ = 15;
// The mask is EMA'd here before it is posted (0.35 new / 0.65 old) — the same weight the overlay
// uses on upload, applied at the source so one blurred sample travels instead of two blends.
const EMA = 0.35;

const state = {
  running: false,
  pose: 'idle', // idle | loading | ready | failed | missing
  segmenter: 'idle',
  poseModel: null,
  segModel: null,
  error: null,
  sent: 0,
  received: 0,
  fps: 0,
  lastMaskAt: 0,
  lastPostAt: 0,
  ackedByOverlay: false,
};

function setStatus(text, tone = 'idle') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;

// The pane's Start/Stop reaches the body source here, and only here: a command, never a frame.
const ctl = 'BroadcastChannel' in window ? new BroadcastChannel(CTL) : null;

/** Embed → OBS: ask the body source to start or stop. Returns false when the channel is missing. */
function control(cmd) {
  if (!ctl) return false;
  try {
    ctl.postMessage({ cmd, at: performance.now() });
    return true;
  } catch {
    return false;
  }
}

if (ctl && !EMBED) {
  ctl.onmessage = (ev) => {
    const cmd = (ev.data || {}).cmd;
    if (cmd === 'start') start();
    else if (cmd === 'stop') {
      stop();
      post({ type: 'status', open: false });
    }
  };
}

function post(msg, transfer) {
  // The publishing path, closed in embed mode at the one call every send goes through.
  if (EMBED || !channel) return false;
  try {
    channel.postMessage(msg, transfer || []);
    return true;
  } catch {
    return false;
  }
}

async function loadStatus() {
  const res = await fetch('/api/handfx/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/* ---------------------------------------------------------------- models */

/** Fetch one model once, land it in Cache Storage, hand back its bytes. */
async function fetchBodyModel(kind, url, cacheKey, signal) {
  const cache = typeof caches !== 'undefined' ? await caches.open(MODEL_CACHE) : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return { buffer: await hit.arrayBuffer(), cached: true, source: cacheKey };
  }
  const source = `/api/handfx/model?kind=${kind}`;
  let res = await fetch(source, { signal, cache: 'no-cache' });
  if (res.status === 404 && url) res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`model ${kind}: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) throw new Error(`model ${kind} was empty`);
  if (cache) {
    try {
      await cache.put(cacheKey, new Response(buffer, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch {
      /* a full or disabled cache is not a failure */
    }
  }
  return { buffer, cached: false, source };
}

/* ---------------------------------------------------------------- mask canvas */

const maskCtx = canvas.getContext('2d', { willReadFrequently: false });
let emaPx = null; // Float32Array of the running average, one channel

function segmentToMask(mask, w, h) {
  // The worker hands over plain bytes: a category mask (Uint8 label per pixel) or a confidence map
  // (Float32 per pixel), because the MediaPipe buffers die with the result it closes.
  if (!mask || !mask.data) return null;
  const src = mask.kind === 'category' ? new Uint8Array(mask.data) : new Float32Array(mask.data);
  const invert = mask.kind === 'category'; // label 0 = person in the selfie segmenter
  const n = w * h;
  if (!src || src.length < n) return null;
  if (!emaPx || emaPx.length !== n) emaPx = new Float32Array(n);
  // The mask texture is drawn at the camera's aspect and sampled in v_uv; a small working size is
  // enough and keeps the copy cheap.
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let v = src[i];
    if (invert) v = v === 0 ? 255 : 0;
    else v = Math.max(0, Math.min(1, v)) * 255;
    const prev = emaPx[i];
    const next = prev + (v - prev) * EMA;
    emaPx[i] = next;
    const a = next | 0;
    const j = i * 4;
    out[j] = out[j + 1] = out[j + 2] = a;
    out[j + 3] = a;
  }
  return new ImageData(out, w, h);
}

function publishMask(imageData) {
  // Second half of the guard: an embed draws no mask of its own, so nothing in it can post one
  // even if a tracking loop ever started in this document.
  if (EMBED) return;
  const tmp = document.createElement('canvas');
  tmp.width = imageData.width;
  tmp.height = imageData.height;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  // The body page shows its own mask (dimmed) so a 1×1 source can still be checked by eye.
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  maskCtx.drawImage(tmp, 0, 0);
  const pose = state.lastPose;
  if (typeof createImageBitmap !== 'function') return;
  createImageBitmap(tmp)
    .then((bitmap) => {
      const ok = post({ type: 'mask', bitmap, w: bitmap.width, h: bitmap.height, pose, at: performance.now() }, [bitmap]);
      if (!ok) bitmap.close?.();
      state.sent++;
      state.lastMaskAt = performance.now();
    })
    .catch(() => {
      /* one failed bitmap is a lost sample, not a failure */
    });
}

/* ---------------------------------------------------------------- tracking */

// The worker file the overlay put its hands on. One instance per task: the worker holds one graph.
const WORKER_URL = new URL('../overlay/hand-worker.js', import.meta.url);

/**
 * One detector thread per task. Pacing stays here — one frame in flight, a newer frame dropped
 * while busy — and the inference itself runs in ../overlay/hand-worker.js, because
 * `detectForVideo` ends in an unbounded `_waitUntilIdle()` that a lost GPU context never leaves.
 * On a worker that costs only that worker: a deadline with no answer terminates it and a fresh
 * one is built from the model bytes already in memory. Same policy as ../engine/tracker.js, kept
 * small because this page has no overlay to report to.
 */
class Infer {
  constructor(task, { model, options, onResult, onError } = {}) {
    this.task = task;
    this.model = model || null; // ArrayBuffer, kept for rebuilds
    this.options = options || {};
    this.onResult = onResult || (() => {});
    this.onError = onError || (() => {});
    this.worker = null;
    this.busy = false;
    this.seq = 0;
    this.timer = 0;
    this.hangs = 0;
    this.runtime = null;
    this.error = null;
    this._resolve = null;
    this._reject = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._rebuild();
      this._wait(INIT_TIMEOUT, 'handshake');
    });
  }

  stop() {
    this._teardown();
    this.hangs = 0;
    if (this._reject) {
      const reject = this._reject;
      this._resolve = null;
      this._reject = null;
      reject(new Error(`${this.task}: stopped`));
    }
  }

  detect(bitmap, at, size) {
    if (!this.worker) {
      if (typeof bitmap.close === 'function') bitmap.close();
      return;
    }
    this.seq += 1;
    this.busy = true;
    this._wait(DETECT_TIMEOUT, 'detect');
    try {
      this.worker.postMessage({ type: 'detect', bitmap, at, seq: this.seq, size }, [bitmap]);
    } catch {
      // Already detached: drop this frame rather than wedge the sender.
      this.busy = false;
      this._clearWait();
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  _rebuild() {
    this._teardown();
    const worker = new Worker(WORKER_URL);
    this.worker = worker;
    worker.onmessage = (ev) => this._onMessage(ev.data || {});
    worker.onerror = (ev) => this._fail(new Error((ev && ev.message) || `${this.task}: worker error`));
    worker.postMessage({
      type: 'init',
      task: this.task,
      fileset: wasmFileset(),
      options: this.options,
      // A copy: this page keeps the original for the next rebuild.
      modelBuffer: this.model ? this.model.slice(0) : null,
    });
  }

  _teardown() {
    this._clearWait();
    const worker = this.worker;
    this.worker = null;
    this.busy = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }

  _wait(ms, what) {
    this._clearWait();
    this.timer = setTimeout(() => this._onHang(what), ms);
  }

  _clearWait() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
  }

  _onHang(what) {
    this.timer = 0;
    this.hangs += 1;
    this.busy = false;
    this._teardown();
    if (this.hangs >= HANG_LIMIT) {
      this._fail(new Error(`${this.task} stalled: detector stopped responding (${what})`));
      return;
    }
    this._rebuild();
    this._wait(INIT_TIMEOUT, 'rebuild handshake');
  }

  _fail(err) {
    this.error = err.message || String(err);
    this.busy = false;
    this._clearWait();
    this.onError(err);
    if (this._reject) {
      const reject = this._reject;
      this._resolve = null;
      this._reject = null;
      reject(err);
    }
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this._clearWait();
      this.runtime = msg.runtime;
      if (this._resolve) {
        const resolve = this._resolve;
        this._resolve = null;
        this._reject = null;
        resolve(this);
      }
      return;
    }
    if (msg.type === 'error') {
      const err = new Error(msg.error || `${this.task}: worker error`);
      err.name = msg.name || 'Error';
      if (this._reject) {
        this._fail(err);
        return;
      }
      // A detect that threw costs one sample, not the thread.
      this.error = err.message;
      this.busy = false;
      this._clearWait();
      return;
    }
    if (msg.type === 'result') {
      // A handshake alone does not reset the count: a worker that greets and then hangs must
      // still reach the limit instead of terminate-looping.
      this.hangs = 0;
      this.busy = false;
      this._clearWait();
      this.onResult(msg);
    }
  }
}

function onPose(msg) {
  const pts = msg.pose;
  state.lastPose = pts ? pts.map((p) => ({ x: 1 - p.x, y: p.y })) : null;
}

function onSegment(msg) {
  const mask = msg.mask;
  if (!mask) return;
  const out = segmentToMask(mask, mask.width, mask.height);
  if (!out) return;
  state.lastPostAt = performance.now();
  publishMask(out);
}

let poseInfer = null;
let segmentInfer = null;
let raf = 0;
let stream = null;

async function start() {
  // Only an OBS-rendered document takes the device. A stray tab of this URL would hold the camera
  // against the OBS body source on the one virtual camera DirectShow hands out exclusively.
  const fromObs = /OBS\//i.test(navigator.userAgent) || new URLSearchParams(location.search).has('obs');
  if (!EMBED && !fromObs) {
    setStatus('body page: the camera preview and mask controls live in the ShockBox admin pane. This page only opens the camera when OBS renders it.', 'warn');
    return;
  }
  // The camera open itself, closed in embed mode. OBS owns the device; a second open steals it.
  if (EMBED) {
    setStatus('embedded preview: OBS owns the camera. This view only watches it; press Start in the ShockFX pane.', 'warn');
    return;
  }
  if (state.running) return;
  state.error = null;
  stop();
  state.running = true;
  setStatus('body page: opening camera…');
  try {
    if (!window.isSecureContext) throw new Error(`insecure origin ${location.origin}: a camera needs https or 127.0.0.1`);
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    const status = await loadStatus();
    if (!status.runtime || !status.runtime.vendored) throw new Error('MediaPipe runtime is not vendored (modules/handfx/vendor/README.md)');
    const facts = status.bodyModels || {};
    state.pose = 'loading';
    state.segmenter = 'loading';
    setStatus('body page: loading models…');
    const sig = AbortSignal.timeout(45000);
    let poseBuf = null;
    try {
      poseBuf = await fetchBodyModel('pose', facts.pose && facts.pose.url, POSE_KEY, sig);
    } catch (err) {
      state.pose = 'failed';
    }
    if (poseBuf) {
      poseInfer = new Infer('pose', {
        model: poseBuf.buffer,
        options: { minPoseDetectionConfidence: 0.6, minPosePresenceConfidence: 0.6 },
        onResult: onPose,
        onError: (err) => {
          // A stalled or crashed pose thread costs the pose, never the mask.
          state.pose = 'failed';
          state.error = `pose ${err.message}`;
        },
      });
      try {
        await poseInfer.start();
        state.pose = 'ready';
      } catch (err) {
        poseInfer = null;
        state.pose = 'failed';
        state.error = `pose model failed: ${err.message}`;
      }
    } else {
      state.pose = 'missing';
    }
    let segBuf = null;
    try {
      segBuf = await fetchBodyModel('segmenter', facts.segmenter && facts.segmenter.url, SEG_KEY, sig);
    } catch (err) {
      state.segmenter = 'failed';
    }
    if (segBuf) {
      segmentInfer = new Infer('segment', {
        model: segBuf.buffer,
        onResult: onSegment,
        onError: (err) => {
          state.segmenter = 'failed';
          state.error = `segmenter ${err.message}`;
        },
      });
      try {
        await segmentInfer.start();
        state.segmenter = 'ready';
      } catch (err2) {
        segmentInfer = null;
        state.segmenter = 'failed';
        state.error = `segmenter failed: ${err2.message}`;
      }
    } else {
      state.segmenter = 'missing';
    }
    // A missing model is named, never a crash, and body effects simply never draw.
    if (!segmentInfer) {
      state.running = false;
      setStatus(`${describeMissing()} — the overlay's body effects will not draw (hands are unaffected)`, 'warn');
      post({ type: 'status', open: false, reason: 'model missing' });
      return;
    }
    state.running = true;
    loop();
  } catch (err) {
    state.running = false;
    state.error = err.message || String(err);
    setStatus(`body page: ${state.error}`, 'bad');
    post({ type: 'status', open: false, reason: state.error });
  }
}

function describeMissing() {
  const bits = [];
  if (state.pose !== 'ready') bits.push(`pose model ${state.pose}`);
  if (state.segmenter !== 'ready') bits.push(`segmenter ${state.segmenter}`);
  return `model missing: ${bits.join(', ')}`;
}

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  video.srcObject = null;
  state.running = false;
  emaPx = null;
  // The detector threads go with the camera: a stopped source holds no graph and no device.
  if (poseInfer) poseInfer.stop();
  if (segmentInfer) segmentInfer.stop();
  poseInfer = null;
  segmentInfer = null;
  setStatus('body page: stopped', 'idle');
}

let lastVideoTime = -1;
let poseFrame = 0;
function loop() {
  const tick = () => {
    if (!state.running) return;
    const now = performance.now();
    // The beat's only job is the pane's "body page open" fact, and only OBS's body source may
    // report it: an embed that beat would mark the body closed while OBS is still live.
    if (!EMBED && now - (tick._beatAt || 0) > 2000) {
      tick._beatAt = now;
      // The beat's only job is the pane's "body page open" fact; it carries no picture.
      fetch('/api/handfx/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'body', open: true }),
      }).catch(() => {});
    }
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const size = { width: video.videoWidth, height: video.videoHeight };
      // Pose at ~10 Hz (the channel's mask rate is what matters; a body landmark is slow anyway).
      poseFrame++;
      // A bitmap per send: it is transferred to the worker, so the two tasks cannot share one.
      // No inference happens here — a frame that misses its slot is dropped, not queued.
      if (poseInfer && !poseInfer.busy && poseFrame % 2 === 0) {
        createImageBitmap(video)
          .then((bitmap) => (poseInfer ? poseInfer.detect(bitmap, performance.now(), size) : bitmap.close()))
          .catch(() => {
            /* one failed bitmap is a lost sample, not a failure */
          });
      }
      if (segmentInfer && !segmentInfer.busy && now - state.lastPostAt >= 1000 / MASK_HZ) {
        createImageBitmap(video)
          .then((bitmap) => (segmentInfer ? segmentInfer.detect(bitmap, performance.now(), size) : bitmap.close()))
          .catch(() => {
            /* one failed bitmap is a lost sample, not a failure */
          });
      }
    }
    raf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- honest status */

channel && (channel.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'hello' && !EMBED) state.ackedByOverlay = true;
  // The embed's whole picture: the mask the OBS body source publishes. Drawn, never re-published.
  if (EMBED && msg.type === 'mask' && msg.bitmap) {
    const w = msg.w || msg.bitmap.width;
    const h = msg.h || msg.bitmap.height;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(msg.bitmap, 0, 0, w, h);
    state.received += 1;
    state.lastMaskAt = performance.now();
  }
});

setInterval(() => {
  if (EMBED) {
    const since = state.lastMaskAt ? Math.round(performance.now() - state.lastMaskAt) : -1;
    if (!channel) setStatus('embedded preview: this browser has no BroadcastChannel, so a mask cannot arrive here', 'bad');
    else if (since < 0) setStatus('embedded preview: waiting for the OBS body source. Nothing has published a mask yet.', 'warn');
    else if (since > 3000) setStatus(`embedded preview: last mask ${Math.round(since / 1000)}s ago. The OBS body source stopped sending.`, 'warn');
    else setStatus(`embedded preview: receiving masks from OBS (${state.received} so far). This view never opens the camera.`, 'ok');
    return;
  }
  if (!state.running) return;
  const since = state.lastMaskAt ? Math.round(performance.now() - state.lastMaskAt) : -1;
  if (since > 2000) {
    setStatus(
      `body page: camera on, but the overlay page has not replied for 2 s.\n` +
        `Sending masks: ${state.sent} · pose ${state.pose} · segmenter ${state.segmenter}\n` +
        `If the overlay is open, the two OBS browser sources cannot see the '${CHANNEL}' channel here.`,
      'warn',
    );
    return;
  }
  setStatus(`body page: sending masks (${state.sent} sent, last ${since} ms ago) · pose ${state.pose} · segmenter ${state.segmenter}`, 'ok');
}, 1000);

/* ---------------------------------------------------------------- boot + controls */

(function boot() {
  const q = new URLSearchParams(location.search);
  if (EMBED) document.body.dataset.embed = 'true';
  if (q.get('clean') === '1' || navigator.userAgent.match(/OBS\//i)) document.body.dataset.clean = 'true';
  // In embed mode the buttons ask OBS's body source; this document still never starts a camera.
  document.querySelector('[data-act="start"]').addEventListener('click', () => (EMBED ? control('start') : start()));
  document.querySelector('[data-act="stop"]').addEventListener('click', () => {
    if (EMBED) {
      control('stop');
      return;
    }
    stop();
    post({ type: 'status', open: false });
  });
  // A browser source boots without a click: if this document is OBS-rendered or the operator asked
  // (`?autostart=0` turns it off), start on load. A tab that is opened for setup waits for Start,
  // and an embed always waits: the camera it would open belongs to OBS.
  const obs = Boolean(navigator.userAgent.match(/OBS\//i)) || q.has('obs');
  if (!EMBED && obs && q.get('autostart') !== '0') start();
  window.__handfxBody = { state, start, stop, control, channel: Boolean(channel), embed: EMBED };
})();
