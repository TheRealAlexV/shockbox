// The overlay's detector thread — its state machine, driven with a fake worker and a fake clock.
//
// No browser, no camera, no wasm. What it proves:
//   · a frame becomes one postMessage with the bitmap transferred, and one `onFrame` per result
//     carrying the original `at`
//   · single slot, newest wins: while a detect is in flight a new frame closes the queued one
//     instead of posting a second time, and nothing is sent while `_busy`
//   · a deadline with no answer terminates the thread, rebuilds it from the cached model bytes and
//     drops the pose once; the second deadline rebuilds again; the third ends in `state: 'error'`
//   · `_hangCount` is reset only by a `ready` *and* a result, never by a `ready` alone, so a worker
//     that handshakes and then hangs reaches the limit instead of terminate-looping
//
//   node test/handfx-detect-worker.mjs
// Exits non-zero on the first failed check.

import {
  Tracker,
  DETECT_TIMEOUT,
  INIT_TIMEOUT,
  HANG_LIMIT,
} from '../modules/handfx/pages/js/engine/tracker.js';

// The tracker's teardown calls the animation-frame API. Node has no frames, and nothing here runs a
// loop, so a pair of no-ops is the whole stub.
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A clock the test owns: timers fire only when it is advanced. */
function fakeClock() {
  const timers = new Map();
  let id = 0;
  let t = 0;
  return {
    now: () => t,
    setTimeout(fn, ms) {
      id += 1;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    pending: () => timers.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let due = null;
        for (const [key, timer] of timers) {
          if (timer.at <= end && (!due || timer.at < due[1].at)) due = [key, timer];
        }
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

/** An ImageBitmap stand-in: only `close()` matters to the page side. */
function fakeBitmap() {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

/** A canvas stand-in for the underlay copy `pushFrame` still performs. */
function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  };
}

/**
 * A Worker stand-in. It records what the page sent and answers only when the test says so, so a
 * "hang" is simply a message the test never replies to.
 */
class FakeWorker {
  constructor() {
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(msg, transfer) {
    this.posted.push({ msg, transfer: transfer || [] });
  }

  terminate() {
    this.terminated = true;
  }

  of(type) {
    return this.posted.filter((p) => p.msg.type === type).map((p) => p.msg);
  }

  detects() {
    return this.of('detect');
  }

  transferOf(type) {
    const hit = this.posted.filter((p) => p.msg.type === type);
    return hit.length ? hit[hit.length - 1].transfer : [];
  }

  replyReady(runtime = 'nosimd') {
    this.onmessage({ data: { type: 'ready', runtime } });
  }

  /** Answer the last detect on this worker; the page pairs results by seq. */
  replyResult(hands = []) {
    const sent = this.detects();
    const last = sent[sent.length - 1];
    this.onmessage({
      data: { type: 'result', hands, at: last ? last.at : null, seq: last ? last.seq : null },
    });
  }
}

function rig(task) {
  const frames = [];
  const states = [];
  const workers = [];
  const clock = fakeClock();
  const tracker = new Tracker({
    onFrame: (frame) => frames.push(frame),
    onState: (snap) => states.push(snap),
    worker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    clock,
    task,
  });
  // The state `startRelay` would have put it in, without the camera or the model download.
  tracker.state = 'running';
  tracker.feed = 'relay';
  tracker.source = 'camera';
  tracker.size = { width: 640, height: 480 };
  tracker._frameCanvas = fakeCanvas();
  tracker._modelBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
  tracker._options = { numHands: 2, runningMode: 'VIDEO' };
  tracker._fileset = { wasmLoaderPath: '/wasm/loader.js' };
  return { tracker, frames, states, workers, clock, last: () => workers[workers.length - 1] };
}

/** Boot the detector and answer the handshake, the way the real worker does. */
async function boot(r) {
  const waiting = r.tracker._initDetector();
  r.last().replyReady('nosimd');
  await waiting;
}

const HAND = [{ landmarks: [{ x: 0.5, y: 0.5, z: 0 }], handedness: 'Right' }];

// ── 1. the init handshake ──────────────────────────────────────────────────────────────────────
{
  console.log('init');
  const r = rig();
  await boot(r);
  check('one worker, one init message', r.workers.length === 1 && r.last().of('init').length === 1);
  const init = r.last().of('init')[0];
  check('init carries the fileset and the options', init.fileset && init.options && init.options.runningMode === 'VIDEO');
  check('init carries a model buffer with bytes', init.modelBuffer instanceof ArrayBuffer && init.modelBuffer.byteLength === 4);
  check('the byte copy is not the page\'s buffer', init.modelBuffer !== r.tracker._modelBuffer);
  check('runtime reported', r.tracker.runtime === 'nosimd');
  check('landmarker handle exists', Boolean(r.tracker.landmarker));
}

// ── 2. one frame in flight, newest wins, one onFrame per result ───────────────────────────────
{
  console.log('single slot');
  const r = rig();
  await boot(r);
  const w = r.last();
  const b1 = fakeBitmap();
  const b2 = fakeBitmap();
  const b3 = fakeBitmap();

  r.tracker.pushFrame(b1, 1000);
  check('first frame is sent at once', w.detects().length === 1 && w.detects()[0].at === 1000);
  check('the bitmap is transferred, not copied', w.transferOf('detect')[0] === b1);
  check('size travels with the frame', w.detects()[0].size.width === 640 && w.detects()[0].size.height === 480);

  r.tracker.pushFrame(b2, 1010);
  r.tracker.pushFrame(b3, 1020);
  check('nothing is sent while a frame is in flight', w.detects().length === 1);
  check('the replaced queued frame is closed', b2.closed === true);
  check('the frame in flight is not closed by the page', b1.closed === false);
  check('the newest queued frame is held, not closed', b3.closed === false);

  w.replyResult(HAND);
  check('the queued frame goes out when the result lands', w.detects().length === 2 && w.detects()[1].at === 1020);
  check('the skipped frame never reaches the worker', w.detects().every((d) => d.at !== 1010));
  check('newest frame is transferred', w.transferOf('detect')[0] === b3);
  check('one onFrame for the one result', r.frames.length === 1);
  check('the frame carries the original at', r.frames[0] && r.frames[0].at === 1000);
  check('the frame carries hands from the worker', r.frames[0] && r.frames[0].hands.length === 1);
  check('width/height come from the frame that was sent', r.frames[0] && r.frames[0].width === 640 && r.frames[0].height === 480);
  check('source stays "camera"', r.frames[0] && r.frames[0].source === 'camera');

  w.replyResult(HAND);
  check('second result is the second onFrame', r.frames.length === 2 && r.frames[1].at === 1020);

  // A frame pushed while nothing is in flight goes straight out.
  const b4 = fakeBitmap();
  r.tracker.pushFrame(b4, 1030);
  check('idle sender posts immediately', w.detects().length === 3 && w.detects()[2].at === 1030);

  // A result from a stale sequence is ignored (a terminated thread cannot land one, a stopped
  // session can: the page bumps the sequence in stop()).
  const before = r.frames.length;
  r.tracker._seq += 1;
  w.replyResult(HAND);
  check('a stale result is dropped', r.frames.length === before);
}

// ── 3. deadline → rebuild → third hang → error ───────────────────────────────────────────────
{
  console.log('hang policy');
  const r = rig();
  await boot(r);
  const first = r.last();
  r.tracker.pushFrame(fakeBitmap(), 5000);

  r.clock.advance(DETECT_TIMEOUT);
  check('deadline terminates the thread', first.terminated === true);
  check('a fresh worker is built', r.workers.length === 2);
  check('the rebuild is initialised from the cached bytes', r.last().of('init').length === 1 && r.last().of('init')[0].modelBuffer.byteLength === 4);
  check('hang counted', r.tracker._hangCount === 1);
  check('the stale pose is dropped once', r.frames.length === 1 && r.frames[0].hands.length === 0 && r.frames[0].source === 'camera');
  check('rebuild is not yet ready', r.tracker._workerReady === false);

  // A frame pushed during the rebuild waits instead of posting into a thread that is not ready.
  r.tracker.pushFrame(fakeBitmap(), 5010);
  check('nothing is sent before the rebuilt worker is ready', r.last().detects().length === 0);

  // Ready alone is not proof of life: no result yet, so the count stands.
  r.last().replyReady();
  check('ready alone does not reset the hang count', r.tracker._hangCount === 1);
  check('the waiting frame is sent once ready', r.last().detects().length === 1);

  r.clock.advance(DETECT_TIMEOUT);
  check('second deadline, second rebuild', r.workers.length === 3 && r.tracker._hangCount === 2);
  check('no second empty frame', r.frames.length === 1);

  // Third strike: ready, a frame that is never answered.
  r.last().replyReady();
  const doomed = fakeBitmap();
  r.tracker.pushFrame(doomed, 6000);
  r.clock.advance(DETECT_TIMEOUT);
  check('third deadline reaches HANG_LIMIT', HANG_LIMIT === 3 && r.tracker._hangCount === 3);
  check('tracking is called failed', r.tracker.state === 'error');
  check('the error names the stall', /detector stopped responding/.test(r.tracker.error || ''));
  check('the last thread is terminated', r.workers[r.workers.length - 1].terminated === true);
  check('no worker is left behind', r.tracker._worker === null);
  check('at most one frame was ever posted per attempt', r.last().detects().length <= 1);
  const errState = r.states.filter((s) => s.state === 'error');
  check('the page hears about it through onState', errState.length === 1);
  check('a late result after the failure changes nothing', (() => {
    const n = r.frames.length;
    r.last().replyResult(HAND);
    return r.frames.length === n && r.tracker.state === 'error';
  })());
}

// ── 4. the reset needs a ready and a result ──────────────────────────────────────────────────
{
  console.log('reset');
  const r = rig();
  await boot(r);
  r.tracker.pushFrame(fakeBitmap(), 7000);
  r.clock.advance(DETECT_TIMEOUT);
  check('first hang', r.tracker._hangCount === 1);

  r.last().replyReady();
  check('ready keeps the count', r.tracker._hangCount === 1);
  const ok = fakeBitmap();
  r.tracker.pushFrame(ok, 7010);
  r.last().replyResult(HAND);
  check('ready + result clears the count', r.tracker._hangCount === 0);
  check('the result is delivered', r.frames.some((f) => f.at === 7010 && f.hands.length === 1));

  // And the policy is not latching: the next deadline starts from one again.
  r.tracker.pushFrame(fakeBitmap(), 7020);
  r.clock.advance(DETECT_TIMEOUT);
  check('a later hang counts from one again', r.tracker._hangCount === 1 && r.tracker.state === 'running');
}

// ── 5. stop() releases the queued frame and drops a late result ─────────────────────────────
{
  console.log('stop');
  const r = rig();
  await boot(r);
  const w = r.last();
  r.tracker.pushFrame(fakeBitmap(), 8000);
  const queued = fakeBitmap();
  r.tracker.pushFrame(queued, 8010);
  const before = r.frames.length;
  r.tracker.stop();
  check('the queued frame is released', queued.closed === true);
  check('the timer is cleared', r.clock.pending() === 0);
  w.replyResult(HAND);
  check('a result after stop is dropped', r.frames.length === before + 1); // stop itself emits one empty frame
  check('the worker is kept for the next session', r.tracker._worker === w && w.terminated === false);
}

// ── 6. task discriminator ──────────────────────────────────────────────────────────────────────
// Only the handshake is provable without a browser: the real graph needs wasm and a canvas, so
// `pose` and `segment` below prove the init carries the task and the worker's ready is accepted,
// not that inference runs.
{
  console.log('task');
  const hand = rig();
  await boot(hand);
  check('the overlay default is the hand task', hand.last().of('init')[0].task === 'hand');

  for (const task of ['pose', 'segment']) {
    const r = rig(task);
    await boot(r);
    const init = r.last().of('init')[0];
    check(`${task}: init carries the task`, init.task === task);
    check(`${task}: the ready handshake is accepted`, r.tracker.state === 'running' && r.tracker.runtime === 'nosimd');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
