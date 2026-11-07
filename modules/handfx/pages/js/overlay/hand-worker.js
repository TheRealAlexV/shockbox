// Hand / pose / segment detection, on its own thread.
//
// Why: `landmarker.detectForVideo()` runs the MediaPipe wasm graph inline on the calling thread and
// ends in `finishProcessing(){ this.i._waitUntilIdle() }` with no timeout anywhere in the path —
// after a synchronous `gl.texImage2D` upload and `readPixels`. If CEF loses the GPU context, that
// fence waits forever. On the page's main thread it took rAF and the 1 s beat down with it: the
// overlay froze hard, with no throw and nothing in the log. On this thread it takes only itself
// down, and the page can terminate it and build another (see `_onHang` in ../engine/tracker.js).
//
// This is a CLASSIC worker on purpose (no `type: 'module'`): the vendored bundle's wasm loader is
// `if ("function" != typeof importScripts) { document.createElement('script') … }`, so the module
// branch needs `importScripts` — and there is no `document` in any worker. A plain script is the
// one form every CEF build the rig runs can start, `watchdog-worker.js` included.
//
// TASK DISCRIMINATOR
// `init.task` picks the graph. 'hand' is the default and is the overlay's proven path, unchanged:
// a HandLandmarker, `options` passed through as they always were, and the same `hands` payload.
// 'pose' builds a PoseLandmarker and answers `pose`; 'segment' builds an ImageSegmenter and answers
// `mask` (one plain, transferable buffer). One detector per worker instance — the state below is
// function-scope, so a page that needs two graphs starts two workers; a single worker multiplexing
// them would serialise pose behind segmentation on one thread.
//
// Protocol (page → worker, one message at a time; the page owns the pacing):
//   {type:'init', task, fileset, options, modelBuffer}
//   {type:'detect', bitmap, at, seq, size}
//   {type:'close'}
// worker → page:
//   {type:'ready', runtime}
//   {type:'result', hands, at, seq}            // task 'hand'
//   {type:'result', pose, at, seq}             // task 'pose'
//   {type:'result', mask, at, seq}             // task 'segment'
//   {type:'error', error, name, seq}
'use strict';

const BUNDLE = '/api/handfx/vendor/vision/vision_bundle.mjs';

let task = 'hand';
let detector = null;
let canvas = null;
let ctx = null;

/**
 * Build the detector, GPU first and CPU after. Same order as the in-page path always used: a
 * machine without WebGL2 throws on the GPU delegate, and the CPU one is still a real detector.
 */
async function create(kind, fileset, options, modelBuffer) {
  const mod = await import(BUNDLE);
  // A fresh view per attempt: the GPU failure path is allowed to have consumed the first one.
  const build = (delegate) => {
    const baseOptions = { modelAssetBuffer: new Uint8Array(modelBuffer), delegate };
    if (kind === 'pose') {
      return mod.PoseLandmarker.createFromOptions(fileset, {
        runningMode: 'VIDEO',
        numPoses: 1,
        ...options,
        baseOptions,
      });
    }
    if (kind === 'segment') {
      return mod.ImageSegmenter.createFromOptions(fileset, {
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: true,
        ...options,
        baseOptions,
      });
    }
    // 'hand' keeps the overlay's proven shape: `options` already carry runningMode and numHands.
    return mod.HandLandmarker.createFromOptions(fileset, { ...options, baseOptions });
  };
  try {
    return { detector: await build('GPU'), runtime: 'nosimd' };
  } catch {
    return { detector: await build('CPU'), runtime: 'nosimd-cpu' };
  }
}

/** The bundle wants a canvas once detection is off the page: a worker has no <video> to hand it. */
function surface(size) {
  const width = Math.max(1, Math.round(Number(size && size.width) || 1));
  const height = Math.max(1, Math.round(Number(size && size.height) || 1));
  if (!canvas) canvas = new OffscreenCanvas(width, height);
  else if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    // Resizing an OffscreenCanvas resets its context; take a fresh one.
    ctx = null;
  }
  if (!ctx) ctx = canvas.getContext('2d');
  return canvas;
}

function handsOf(res) {
  if (!res || !res.landmarks) return [];
  return res.landmarks.map((lm, i) => ({
    landmarks: lm,
    handedness: res.handedness && res.handedness[i] && res.handedness[i][0] ? res.handedness[i][0].categoryName : null,
  }));
}

/** The first pose's landmarks, untouched: mirroring and shaping stay the page's business. */
function poseOf(res) {
  return res && res.landmarks && res.landmarks[0] ? res.landmarks[0] : null;
}

/**
 * A mask leaves the worker as plain, transferable bytes. The MediaPipe buffers die with
 * `result.close()`, so they are copied once here — the copy is also what the transfer sends.
 */
function maskOf(res) {
  if (!res) return null;
  const cat = res.categoryMask;
  const conf = res.confidenceMasks && res.confidenceMasks[0];
  let kind;
  let src;
  if (cat) {
    kind = 'category';
    src = new Uint8Array(cat.getAsUint8Array());
  } else if (conf) {
    kind = 'confidence';
    src = new Float32Array(conf.getAsFloat32Array());
  } else {
    return null;
  }
  const source = cat || conf;
  return { kind, width: source.width, height: source.height, data: src.buffer };
}

self.onmessage = async (ev) => {
  const msg = (ev && ev.data) || {};

  if (msg.type === 'init') {
    task = msg.task === 'pose' || msg.task === 'segment' ? msg.task : 'hand';
    try {
      const made = await create(task, msg.fileset, msg.options || {}, msg.modelBuffer);
      detector = made.detector;
      self.postMessage({ type: 'ready', runtime: made.runtime, task });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: (err && err.message) || String(err),
        name: (err && err.name) || 'Error',
        task,
      });
    }
    return;
  }

  if (msg.type === 'detect') {
    const bitmap = msg.bitmap;
    if (!detector) {
      // Terminated or rejected mid-flight: drop the frame, the page is rebuilding.
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      return;
    }
    try {
      // Draw first, never hand the ImageBitmap straight in: the bundle answers that path with
      // "Conversion to ImageBitmap requires that the MediaPipe Tasks is initialized with an
      // OffscreenCanvas". This mirrors the proven main-thread sequence (../engine/tracker.js).
      const c = surface(msg.size);
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();

      if (task === 'segment') {
        const res = detector.segmentForVideo(c, msg.at);
        const mask = maskOf(res);
        if (res && typeof res.close === 'function') res.close();
        self.postMessage({ type: 'result', mask, at: msg.at, seq: msg.seq }, mask ? [mask.data] : []);
        return;
      }

      const res = detector.detectForVideo(c, msg.at);
      if (task === 'pose') {
        const pose = poseOf(res);
        if (res && typeof res.close === 'function') res.close();
        self.postMessage({ type: 'result', pose, at: msg.at, seq: msg.seq });
        return;
      }
      self.postMessage({ type: 'result', hands: handsOf(res), at: msg.at, seq: msg.seq });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: (err && err.message) || String(err),
        name: (err && err.name) || 'Error',
        seq: msg.seq,
      });
    }
    return;
  }

  if (msg.type === 'close') {
    if (detector) {
      try {
        detector.close();
      } catch {
        /* a closed graph that throws on close is still closed */
      }
      detector = null;
    }
    canvas = null;
    ctx = null;
  }
};
