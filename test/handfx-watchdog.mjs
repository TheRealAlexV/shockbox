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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
