// Stub page harness for the overlay's liveness watchdog — no browser, no server.
//
// What it proves, with a fake clock and a probe that refuses connections:
//   · after the server disappears, nothing happens for 5 s (the page keeps drawing), then the
//     watchdog probes: immediately, then with a 0.5 s → 1 s → 2 s … capped backoff
//   · when the server comes back, exactly one recovery runs: the dead relay reader is dropped,
//     the bus is reconnected, the publisher and tracker are re-armed
//   · a server that never comes back costs a bounded number of probes (the hard cap) and stops
//   · a failed connection never leaves the page claiming `cameraSource: relay` / `anchors: camera`
//
//   node test/handfx-watchdog.mjs
// Exits non-zero on the first failed check.

import { createWatchdog } from '../modules/handfx/pages/js/overlay/watchdog.js';
import { cameraWanted, rearmCamera } from '../modules/handfx/pages/js/overlay/rearm.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** What /status would report about the page, and what a recovery rebuilds. */
const page = {
  cameraSource: 'relay',
  anchors: 'camera',
  bus: 'connected',
  relayReader: 'open',
  tracker: 'running',
  publisher: 'live',
  publishStage: 'live',
  recoveries: 0,
};

function down() {
  page.cameraSource = 'none'; // the relay reader ended and the tracker stopped: no stale claim
  page.anchors = 'none';
  page.relayReader = 'ended';
  page.tracker = 'idle';
  page.publisher = 'stalled';
  page.publishStage = 'stalled';
  page.bus = 'offline';
}

/* ---------------------------------------------------------------- server restart */

console.log('scenario 1: server dies at 5 s, comes back at 15 s');

let clock = 0;
let serverUp = true;
const probes = [];
const transitions = [];
const transit = (s) => (s.attempts === transitions.at(-1)?.attempts && s.state === transitions.at(-1)?.state ? false : true);

const wd = createWatchdog({
  now: () => clock,
  probe: async () => {
    probes.push(Math.round(clock));
    if (!serverUp) throw new Error('ECONNREFUSED'); // the server is not listening
    return { publish: { mode: 'raw', stage: 'live' } };
  },
  recover: async (status) => {
    page.recoveries += 1;
    // The tear-down and re-arm the page performs: a new bus, a new relay reader, the tracker and
    // the publisher back on the fresh status document.
    page.bus = 'connected'; // the fresh EventSource is open
    page.relayReader = 'reopened';
    page.tracker = 'running';
    page.publisher = 'live';
    page.publishStage = status.publish.stage;
    page.cameraSource = 'relay';
    page.anchors = 'camera';
    wd.ok(clock); // recoverOverlay ends with a forced /ack
  },
  onState: (s) => {
    if (transit(s)) transitions.push({ t: Math.round(clock), ...s });
  },
});

const TICK = 100;
let lastState = '';
const seen = [];
for (clock = 0; clock <= 60000; clock += TICK) {
  if (clock === 5000) {
    serverUp = false;
    down();
  }
  if (clock === 15000) serverUp = true;
  if (serverUp && page.bus === 'connected' && clock % 500 === 0) wd.ok(clock); // a successful /ack, 2/s
  await wd.tick();
  const s = wd.status();
  if (s.state !== lastState) {
    seen.push({ t: Math.round(clock), state: s.state, attempts: s.attempts, lastOkAgeMs: s.lastOkAgeMs });
    lastState = s.state;
  }
}

const first = probes[0];
const gaps = probes.slice(1).map((t, i) => t - probes[i]);
console.log('  probes at (ms):', probes.join(', '));
check('no probe while the page is healthy', first >= 9500, `first probe at ${first} ms`);
check('first probe is one tick past the 5 s staleness rule', first <= 10200, `first probe at ${first} ms`);
check('gaps never shrink and never exceed the 10 s cap', gaps.every((g, i) => g <= 10000 + TICK && (i === 0 || g >= gaps[i - 1] - TICK)), gaps.join(', '));
check('exactly one recovery, on the first probe after the server returns', page.recoveries === 1, `${page.recoveries} recoveries`);
check('recovery happened promptly after the restart', probes.at(-1) >= 15000 && probes.at(-1) <= 15000 + 10000 + TICK, `last probe at ${probes.at(-1)}`);
check('no probes after recovery', wd.status().state === 'ok' && probes.at(-1) <= 15000 + 10000 + TICK, `last probe at ${probes.at(-1)}`);
check('the page is re-armed: relay reader reopened', page.relayReader === 'reopened');
check('the page is re-armed: bus reconnected', page.bus === 'connected');
check('the page is re-armed: tracker running, publisher live', page.tracker === 'running' && page.publisher === 'live');
check('the page reports cameraSource relay only once it is really back', page.cameraSource === 'relay' && page.anchors === 'camera');
console.log('  status the page would report:', JSON.stringify({
  cameraSource: page.cameraSource, anchors: page.anchors, publish: { stage: page.publishStage },
}));
console.log('  transitions:', JSON.stringify(seen), 'onState:', JSON.stringify(transitions));

/* ---------------------------------------------------------------- server never returns */

console.log('scenario 2: the server never comes back');

const pageDead = { cameraSource: 'relay', anchors: 'camera', bus: 'connected', recoveries: 0 };
clock = 0;
serverUp = true;
const deadProbes = [];
const dead = createWatchdog({
  now: () => clock,
  probe: async () => {
    deadProbes.push(Math.round(clock));
    if (!serverUp) throw new Error('ECONNREFUSED');
    return {};
  },
  recover: async () => {
    pageDead.recoveries += 1;
  },
});
for (clock = 0; clock <= 600000; clock += TICK) {
  if (clock === 5000) {
    serverUp = false;
    pageDead.cameraSource = 'none'; // what the relay error handler does
    pageDead.anchors = 'none';
    pageDead.bus = 'offline';
  }
  if (serverUp && pageDead.bus === 'connected' && clock % 500 === 0) dead.ok(clock);
  await dead.tick();
}
const end = dead.status();
console.log('  probes:', deadProbes.length, 'final status:', JSON.stringify(end));
check('the hard cap is honoured', deadProbes.length === end.maxAttempts, `${deadProbes.length} probes, cap ${end.maxAttempts}`);
check('after the cap the page stops probing (no storm)', deadProbes.at(-1) < 600000 - 60000, `last probe at ${deadProbes.at(-1)}`);
check('a dead server never runs a recovery', pageDead.recoveries === 0 && end.state === 'gave-up');
check('the page does not claim a camera it does not have', pageDead.cameraSource === 'none' && pageDead.anchors === 'none');

/* ---------------------------------------------------------------- recovery re-arms the camera */

// The rig's defect: the server restarted, the relay was already dead (so `camAttempted` was false
// and tracking was stopped), and recovery skipped the camera for ever. These two scenarios drive
// the real `rearmCamera` against a stub server that counts `/camera/stream` requests and the
// `cameraFeed.clients` the page would report on /status.

/** The server's camera feed: one request per relay reader, and the client count it exposes. */
function makeServer() {
  return {
    up: true,
    clients: 0,
    streamRequests: [],
    async stream() {
      this.streamRequests.push(this.streamRequests.length + 1);
      if (!this.up) throw new Error('ECONNREFUSED');
      this.clients = 1; // the relay's reader is attached
      return { ok: true };
    },
    close() {
      this.clients = 0;
    },
  };
}

/** relay.js: `start()` is one `/camera/stream` fetch; a frame is what makes the source a camera. */
function makeRelay(server, state, { deliversFrames = true } = {}) {
  return {
    live: false,
    async start() {
      if (this.live) return true;
      try {
        await server.stream();
      } catch {
        return false;
      }
      this.live = true;
      if (deliversFrames) {
        state.cameraSource = 'relay';
        state.anchors = 'camera';
      }
      return true;
    },
    stop() {
      this.live = false;
      server.close();
    },
  };
}

/** tracker.js: `stop()` clears the synthetic rig with the tracker. */
function makeTracker(state) {
  return {
    stop() {
      state.tracking = false;
      state.synthetic = false;
    },
  };
}

/** autoCamera from main.js, with its bounded retry: 2 attempts, relay first, synthetic last. */
function makeAutoCamera(state, relay, { budget = 2 } = {}) {
  const cam = { attempts: 0 };
  const auto = async () => {
    if (cam.attempts >= budget) return false;
    cam.attempts += 1;
    if (await relay.start()) {
      state.tracking = true;
      state.synthetic = false;
      return true;
    }
    return false; // main.js calls fallBackToSynthetic(); the view keeps the synthetic anchors
  };
  auto.cam = cam;
  return auto;
}

/** The state a dead relay leaves behind: fallBackToSynthetic() ran, the camera is not tracking. */
function afterRelayDeath() {
  return { cameraSource: 'synthetic', anchors: 'synthetic', tracking: false, synthetic: true };
}

console.log('scenario 3: server dies while the relay was live, then returns');

const s3 = makeServer();
const st3 = { ...afterRelayDeath(), settings: { cameraRelay: 'on' } };
const relay3 = makeRelay(s3, st3);
const tracker3 = makeTracker(st3);
const auto3 = makeAutoCamera(st3, relay3);
await relay3.start(); // the page was watching the relay before the restart
check('the relay was live before the restart', s3.clients === 1 && st3.cameraSource === 'relay');
s3.up = false;
relay3.stop(); // the reader hits ECONNREFUSED and ends
st3.cameraSource = 'synthetic'; // fallBackToSynthetic() took the view back
st3.anchors = 'synthetic';
const sent3 = s3.streamRequests.length;
s3.up = true; // the server comes back
const armed3 = await rearmCamera({
  state: st3,
  relay: relay3,
  tracker: tracker3,
  autoCamera: auto3,
  userStopped: false,
  visible: true,
});
check('recovery re-arms the camera the settings ask for', armed3 === true);
check('a fresh /camera/stream request is issued', s3.streamRequests.length === sent3 + 1, `${s3.streamRequests.length - sent3} new`);
check('the retry budget is not spent in a loop', auto3.cam.attempts === 1, `${auto3.cam.attempts} attempts`);
check('/status shows cameraFeed.clients: 1', s3.clients === 1, `clients ${s3.clients}`);
check('the camera claim follows the frames', st3.cameraSource === 'relay' && st3.anchors === 'camera');

console.log('scenario 4: the camera is off in settings, and a stub relay that never delivers');

const s4 = makeServer();
const st4 = { ...afterRelayDeath(), settings: { cameraRelay: 'off' } };
const relay4 = makeRelay(s4, st4);
const auto4 = makeAutoCamera(st4, relay4);
const sent4 = s4.streamRequests.length;
const armed4 = await rearmCamera({
  state: st4,
  relay: relay4,
  tracker: makeTracker(st4),
  autoCamera: auto4,
  userStopped: false,
  visible: true,
});
check('camera off in settings: recovery does not start it', armed4 === false && s4.streamRequests.length === sent4);
check('camera off in settings: no stream client is attached', s4.clients === 0 && st4.cameraSource === 'synthetic');
check('camera wanted is a settings read, not the last attempt', cameraWanted({ cameraRelay: 'on' }) && !cameraWanted({ cameraRelay: 'off' }) && cameraWanted(null));

const s5 = makeServer();
const st5 = { ...afterRelayDeath(), settings: { cameraRelay: 'on' } };
const relay5 = makeRelay(s5, st5, { deliversFrames: false }); // request accepted, no frame ever
const armed5 = await rearmCamera({
  state: st5,
  relay: relay5,
  tracker: makeTracker(st5),
  autoCamera: makeAutoCamera(st5, relay5),
  userStopped: false,
  visible: true,
});
check('a relay that never delivers keeps the page on synthetic', armed5 === false || st5.cameraSource !== 'relay', `cameraSource ${st5.cameraSource}`);
check('a stopped page is not re-armed', (await rearmCamera({ state: st5, relay: relay5, tracker: makeTracker(st5), autoCamera: makeAutoCamera(st5, relay5), userStopped: true, visible: true })) === false);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
