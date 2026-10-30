// The body tracking page: its own small OBS browser source (1×1 or a few hundred pixels).
//
// It runs two MediaPipe tasks on the camera — PoseLandmarker (33 body landmarks) and ImageSegmenter
// (a person mask) — and hands the mask to the overlay page (`pages/overlay.html`) over
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

import { wasmFileset } from '../engine/tracker.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const canvas = $('mask');
const statusEl = $('status');

const MODEL_CACHE = 'handfx:body-models-v1';
const POSE_KEY = '/handfx/model/pose_landmarker_lite.task';
const SEG_KEY = '/handfx/model/selfie_segmenter.tflite';
const CHANNEL = 'handfx.body';
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

function post(msg, transfer) {
  if (!channel) return false;
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

function segmentToMask(result, w, h) {
  // ImageSegmenter gives a category mask (Uint8 label per pixel) or a float confidence map. The
  // selfie segmenter's label 0 is the person; its float output calls the person the high value.
  const cat = result && result.categoryMask;
  const conf = result && result.confidenceMasks && result.confidenceMasks[0];
  let src;
  let invert = false;
  if (cat) {
    src = cat.getAsUint8Array();
    invert = true; // label 0 = person in the selfie segmenter
  } else if (conf) {
    src = conf.getAsFloat32Array();
  } else {
    return null;
  }
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

let landmarker = null;
let segmenter = null;
let raf = 0;
let stream = null;

async function start() {
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
    const mod = await import('/api/handfx/vendor/vision/vision_bundle.mjs');
    const sig = AbortSignal.timeout(45000);
    let poseBuf = null;
    try {
      poseBuf = await fetchBodyModel('pose', facts.pose && facts.pose.url, POSE_KEY, sig);
    } catch (err) {
      state.pose = 'failed';
    }
    if (poseBuf) {
      try {
        landmarker = await mod.PoseLandmarker.createFromOptions(wasmFileset(), {
          baseOptions: { modelAssetBuffer: new Uint8Array(poseBuf.buffer), delegate: 'GPU' },
          numPoses: 1,
          runningMode: 'VIDEO',
          minPoseDetectionConfidence: 0.6,
          minPosePresenceConfidence: 0.6,
        });
        state.pose = 'ready';
      } catch (err) {
        try {
          landmarker = await mod.PoseLandmarker.createFromOptions(wasmFileset(), {
            baseOptions: { modelAssetBuffer: new Uint8Array(poseBuf.buffer), delegate: 'CPU' },
            numPoses: 1,
            runningMode: 'VIDEO',
          });
          state.pose = 'ready';
        } catch (err2) {
          state.pose = 'failed';
          state.error = `pose model failed: ${err2.message}`;
        }
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
      try {
        segmenter = await mod.ImageSegmenter.createFromOptions(wasmFileset(), {
          baseOptions: { modelAssetBuffer: new Uint8Array(segBuf.buffer), delegate: 'CPU' },
          runningMode: 'VIDEO',
          outputCategoryMask: true,
          outputConfidenceMasks: true,
        });
        state.segmenter = 'ready';
      } catch (err2) {
        state.segmenter = 'failed';
        state.error = `segmenter failed: ${err2.message}`;
      }
    } else {
      state.segmenter = 'missing';
    }
    // A missing model is named, never a crash, and body effects simply never draw.
    if (!segmenter) {
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
  setStatus('body page: stopped', 'idle');
}

let lastVideoTime = -1;
let poseFrame = 0;
function loop() {
  const tick = () => {
    if (!state.running) return;
    const now = performance.now();
    if (now - (tick._beatAt || 0) > 2000) {
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
      const w = video.videoWidth;
      const h = video.videoHeight;
      // Pose at ~10 Hz (the channel's mask rate is what matters; a body landmark is slow anyway).
      poseFrame++;
      if (landmarker && poseFrame % 2 === 0) {
        try {
          const out = landmarker.detectForVideo(video, now);
          const pts = out && out.landmarks && out.landmarks[0];
          state.lastPose = pts ? pts.map((p) => ({ x: 1 - p.x, y: p.y })) : null;
        } catch {
          state.lastPose = null;
        }
      }
      if (now - state.lastPostAt >= 1000 / MASK_HZ) {
        try {
          const res = segmenter.segmentForVideo(video, now);
          const mask = segmentToMask(res, w, h);
          if (mask) {
            state.lastPostAt = now;
            publishMask(mask);
          }
        } catch (err) {
          state.error = `segmentation threw: ${err.message}`;
        }
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
  if (msg.type === 'hello') state.ackedByOverlay = true;
});

setInterval(() => {
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
  if (q.get('clean') === '1' || navigator.userAgent.match(/OBS\//i)) document.body.dataset.clean = 'true';
  document.querySelector('[data-act="start"]').addEventListener('click', () => start());
  document.querySelector('[data-act="stop"]').addEventListener('click', () => {
    stop();
    post({ type: 'status', open: false });
  });
  // A browser source boots without a click: if this document is OBS-rendered or the operator asked
  // (`?autostart=0` turns it off), start on load. A tab that is opened for setup waits for Start.
  const obs = Boolean(navigator.userAgent.match(/OBS\//i)) || q.has('obs');
  if (obs && q.get('autostart') !== '0') start();
  window.__handfxBody = { state, start, stop, channel: Boolean(channel) };
})();
