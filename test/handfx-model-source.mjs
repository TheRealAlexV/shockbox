// The model source is not a fact /status owns, and one failed download is not the detector's life.
//   node test/handfx-model-source.mjs
//
// The live defect: during a ~40 s deploy window `/api/handfx/status` returned 500, the boot read
// became `null`, both `modelLocal` and `modelUrl` came out empty, `fetchModel` threw
// "no model source", and the page stayed on the synthetic rig for the life of the document while
// its camera stream kept flowing. Two independent facts are pinned here, both without a DOM:
//
//   · `modelSourceFor(null)` is the local route — the same 200/7.8 MB route this server always
//     serves — while an answered `model.local: true` stays local and an answered URL is honoured.
//   · `_loadModel` retries a failed fetch at most twice and logs each attempt, so a transient 500
//     costs a retry; a source that is truly gone settles on synthetic after exactly three tries.
//
// The shipped `engine/tracker.js` is imported as-is (it has no DOM at module scope); only the
// globals a page would supply (`fetch`, Cache Storage) are provided, and the detector boot is
// stubbed: this gate is about the bytes source, not wasm.

import { Tracker, modelSourceFor } from '../modules/handfx/pages/js/engine/tracker.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('model source from the status document');
const cases = [
  ['failed status read (null)', null, { modelLocal: true, modelUrl: undefined }],
  ['status without a model block', {}, { modelLocal: true, modelUrl: undefined }],
  ['status naming no source at all', { model: {} }, { modelLocal: true, modelUrl: undefined }],
  ['status with an explicit local model', { model: { local: true } }, { modelLocal: true, modelUrl: undefined }],
  ['status with an explicit local model and a stale url', { model: { local: true, url: 'https://cdn.example/m.task' } }, { modelLocal: true, modelUrl: undefined }],
  ['status with a remote url', { model: { local: false, url: 'https://cdn.example/m.task' } }, { modelLocal: false, modelUrl: 'https://cdn.example/m.task' }],
];
for (const [name, status, want] of cases) {
  const got = modelSourceFor(status);
  check(name, got.modelLocal === want.modelLocal && got.modelUrl === want.modelUrl, JSON.stringify(got));
}

// --- the retry, with a real fetch failure and no DOM -------------------------------------------

const realFetch = globalThis.fetch;
const hadCaches = Object.prototype.hasOwnProperty.call(globalThis, 'caches');
const realCaches = globalThis.caches;
// `stop()` cancels the page's animation frame; nothing this gate checks draws a frame.
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);

/** A page's globals: no Cache Storage (so every attempt hits fetch), and a scripted source. */
function armFetch(script) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const step = script(calls, String(url));
    if (step) throw new Error(step);
    return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
  };
  return () => calls;
}

function makeTracker(logs) {
  const tracker = new Tracker({ log: (msg) => logs.push(msg) });
  // The detector boot (wasm, worker) is not what this gate tests; the bytes are.
  tracker._initDetector = async function () {
    this.landmarker = { worker: true, close: () => {} };
  };
  return tracker;
}

try {
  delete globalThis.caches;

  console.log('a source that fails twice and recovers');
  {
    const logs = [];
    const calls = armFetch((n) => (n < 3 ? 'model download failed: HTTP 500 from /api/handfx/model' : null));
    const tracker = makeTracker(logs);
    const snap = await tracker.startRelay({ modelLocal: true, resolution: '720p' });
    check('the session runs instead of latching synthetic', snap.state === 'running', snap.state);
    check('three attempts, no more', calls() === 3, String(calls()));
    check('the bytes came from the local route', tracker.modelSource && tracker.modelSource.from === 'local', JSON.stringify(tracker.modelSource));
    check('both failures were logged', logs.filter((l) => /load failed/.test(l)).length === 2, logs.join(' | '));
    check('the recovery was logged', logs.some((l) => /loaded on attempt 3\/3/.test(l)), logs.join(' | '));
    const before = calls();
    await tracker.startRelay({ modelLocal: true, resolution: '720p' });
    check('a running session is not restarted by a retry', calls() === before, String(calls() - before));
  }

  console.log('a source that is truly gone');
  {
    const logs = [];
    const calls = armFetch(() => 'model download failed: HTTP 500 from /api/handfx/model');
    const tracker = makeTracker(logs);
    const snap = await tracker.startRelay({ modelLocal: true, resolution: '720p' });
    check('the page settles in error, not a loop', snap.state === 'error', snap.state);
    check('the page reports the model failure', /Hand model unavailable/.test(snap.error || ''), String(snap.error));
    check('the error is a MediaError', snap.errorName === 'MediaError', String(snap.errorName));
    check('exactly three attempts', calls() === 3, String(calls()));
    check('two retries were logged, then no fourth attempt', logs.filter((l) => /retrying/.test(l)).length === 2, logs.join(' | '));
  }
} finally {
  globalThis.fetch = realFetch;
  if (hadCaches) globalThis.caches = realCaches;
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
