// The two hardenings that keep a ShockFX document alive, tested with no browser and no server.
//
// Run: node test/handfx-beat-reload.mjs
//
// What is pinned:
//   1. a live client whose beat goes stale is reloaded exactly once
//   2. a second sweep inside the gap reloads nothing; past the gap it reloads again
//   3. the attempt count is bounded — a document that never beats again is left alone
//   4. a beat that arrives resets the count, so a recovered document gets its full budget back
//   5. a fresh client, a hidden one, a preview and another role are never reloaded
//   6. a 503 from the camera relay is a waiting state, not `error`, and leaves the page's own
//      loops free to keep drawing and acking (driven against a stub page, see below)
//
// 6 is the regression that mattered: `stream answered 503` was thrown as a fault, the page went
// to `error`, and a normal "no camera frame yet" boot looked like a broken rig.

import assert from 'node:assert/strict';
import { createBeatHealer, BEAT_HEAL_DEFAULTS } from '../modules/handfx/beat-reload.mjs';

const NOW = 10_000_000;
const ROLE = '/shockfx';
const role = ROLE;

const row = (id, extra = {}) => ({ id, role, beatAt: NOW - 1000, ...extra });

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

/* ------------------------------------------------------------------ 1-5: the reload policy */

const healer = (over = {}) => {
  const fired = [];
  const h = createBeatHealer({
    reload: (id, reason) => fired.push({ id, reason }),
    ...over,
  });
  return { h, fired };
};

check('1. a stale beat reloads once, and names the reason', () => {
  const { h, fired } = healer();
  const out = h.sweep([row('a', { beatAt: NOW - 20_000 })], NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(fired.map((f) => f.id), ['a']);
  assert.match(fired[0].reason, /silent 20s \(attempt 1\/3\)/);
});

check('1b. a fresh beat reloads nothing', () => {
  const { h, fired } = healer();
  assert.deepEqual(h.sweep([row('a', { beatAt: NOW - 1000 })], NOW), []);
  assert.equal(fired.length, 0);
});

// The blocker: the beat is a main-thread `<img>` on a 1 s timer, the ack comes from the worker on
// its own 500 ms timer. A model load or a GL compile silences the beat while the page is alive and
// on air, so the *newer* of the two is the liveness signal — the beat alone would reload a live page.
check('1c. stale beat + fresh ack (main thread stalled, worker acking) -> no reload', () => {
  const { h, fired } = healer();
  const out = h.sweep([row('a', { beatAt: NOW - 40_000, lastAckAt: NOW - 500 })], NOW);
  assert.deepEqual(out, []);
  assert.equal(fired.length, 0);
});

// The other direction, and the reason the rule is `max` rather than "ack only": a dead ack path with
// the page still beating is a *mute* page (the server already calls it `page-mute`), not a dead one.
// Reloading it would throw away a live document to fix a report — the same mistake as the beat-only
// rule, mirrored. Only both signals going quiet is death.
check('1d. stale ack + fresh beat (ack path dead, page beating) -> no reload', () => {
  const { h, fired } = healer();
  const out = h.sweep([row('a', { beatAt: NOW - 500, lastAckAt: NOW - 40_000 })], NOW);
  assert.deepEqual(out, []);
  assert.equal(fired.length, 0);
});

check('1e. both signals quiet -> reload', () => {
  const { h, fired } = healer();
  const out = h.sweep([row('a', { beatAt: NOW - 40_000, lastAckAt: NOW - 40_000 })], NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(fired.map((f) => f.id), ['a']);
});

check('2. the gap is honoured: one reload, silence inside it, another after it', () => {
  const { h, fired } = healer({ gapMs: 30_000 });
  const stale = () => [row('a', { beatAt: NOW - 60_000 })];
  h.sweep(stale(), NOW);
  assert.equal(fired.length, 1);
  // 5 s later — a real sweep runs on a 5 s timer — must not reload again.
  h.sweep(stale(), NOW + 5_000);
  h.sweep(stale(), NOW + 29_000);
  assert.equal(fired.length, 1);
  h.sweep(stale(), NOW + 30_001);
  assert.equal(fired.length, 2);
  assert.match(fired[1].reason, /attempt 2\/3/);
});

check('3. attempts are bounded: three, then quiet', () => {
  const { h, fired } = healer({ gapMs: 1000 });
  const stale = [row('a', { beatAt: NOW - 60_000 })];
  for (let i = 0; i < 12; i += 1) h.sweep(stale, NOW + i * 1000);
  assert.equal(fired.length, 3);
  assert.match(fired[2].reason, /attempt 3\/3/);
});

check('4. a beat resets the count, so a recovered document gets its budget back', () => {
  const { h, fired } = healer({ gapMs: 1000 });
  for (let i = 0; i < 12; i += 1) h.sweep([row('a', { beatAt: NOW - 60_000 })], NOW + i * 1000);
  assert.equal(fired.length, 3);
  // The document came back for one beat, then died again.
  h.sweep([row('a', { beatAt: NOW + 12_000 })], NOW + 12_000);
  h.sweep([row('a', { beatAt: NOW + 12_000 })], NOW + 40_000);
  assert.equal(fired.length, 4);
  assert.match(fired[3].reason, /attempt 1\/3/);
});

check('5. fresh, hidden, preview and other roles are never reloaded', () => {
  const { h, fired } = healer();
  const out = h.sweep(
    [
      row('fresh', { beatAt: NOW - 500 }),
      row('hidden', { beatAt: NOW - 60_000, hidden: true }),
      row('hidden-vis', { beatAt: NOW - 60_000, visibility: 'hidden' }),
      row('preview', { beatAt: NOW - 60_000, preview: true }),
      row('wall', { beatAt: NOW - 60_000, role: '/wall' }),
      row('no-beat', { beatAt: 0 }),
    ],
    NOW,
  );
  assert.deepEqual(out, []);
  assert.equal(fired.length, 0);
});

check('5b. defaults are longer than the boot compile and bounded', () => {
  assert.ok(BEAT_HEAL_DEFAULTS.staleMs >= 15_000, String(BEAT_HEAL_DEFAULTS.staleMs));
  assert.ok(BEAT_HEAL_DEFAULTS.gapMs >= BEAT_HEAL_DEFAULTS.staleMs, String(BEAT_HEAL_DEFAULTS.gapMs));
  assert.equal(BEAT_HEAL_DEFAULTS.max, 3);
});

// The beat GET carries no role (`main.js` `beat()`), so a beat-only row — a preview, a pane, a second
// document — is unclassifiable. Before the guard, `if (role && c.role && …)` let it through and a
// stale-but-live preview could be reloaded. Unknown is now not a match.
check('5c. eligible on every other count but no role -> no reload', () => {
  const { h, fired } = healer();
  const out = h.sweep([{ id: 'beat-only', beatAt: NOW - 60_000, lastAckAt: NOW - 60_000 }], NOW);
  assert.deepEqual(out, []);
  assert.equal(fired.length, 0);
});

check('5d. explicit on-air role with both signals quiet still reloads', () => {
  const { h, fired } = healer();
  const out = h.sweep([{ id: 'on-air', role: ROLE, beatAt: NOW - 60_000, lastAckAt: NOW - 60_000 }], NOW);
  assert.equal(out.length, 1);
  assert.deepEqual(fired.map((f) => f.id), ['on-air']);
});

/* ------------------------------------------ 6: a 503 relay leaves the page's own loops running */

// A stub page: the two clocks `main.js` runs (the render loop's draw counter and the worker's ack
// heartbeat) plus a `getUserMedia` that rejects the way the rig's does. Nothing here is the page's
// code — what it proves is the contract the page relies on: a relay 503 resolves `start()` false
// without an `error` state, so the caller's fallback runs and neither clock is ever cancelled.
await checkAsync('6. rejected getUserMedia + 503 relay: no error state, draws and acks keep advancing', async () => {
  const listeners = new Map();
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  globalThis.window = { addEventListener: (type, fn) => listeners.set(`win:${type}`, fn) };

  const states = [];
  const events = [];
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    // The server's own 503 shape: `send(res, 503, { ok: false, error })`. `camera relay is off` and
    // `no camera frame yet` must stay distinguishable in `relay.reason()`.
    return new Response(JSON.stringify({ ok: false, error: 'camera relay is off' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };

  const { createRelay } = await import('../modules/handfx/pages/js/overlay/relay.js');
  const relay = createRelay({
    url: 'http://stub.invalid/api/handfx/camera/stream',
    timeout: 150,
    onFrame: () => {},
    onState: (s) => states.push(s.state),
    onEvent: (transition, detail) => events.push(`${transition}: ${detail}`),
  });

  // The rig's failure: every device is held, so this always rejects.
  const gumRejects = () => Promise.reject(Object.assign(new Error('Could not start video source'), { name: 'NotReadableError' }));

  const clock = { draws: 0, acks: 0 };
  const drawTimer = setInterval(() => (clock.draws += 1), 10);
  const ackTimer = setInterval(() => (clock.acks += 1), 10);
  const started = Date.now();
  try {
    await assert.rejects(gumRejects(), /Could not start video source/);
    const live = await relay.start();
    assert.equal(live, false, 'a 503 must not read as a live stream');
    assert.equal(fetches, 1);
  } finally {
    await new Promise((r) => setTimeout(r, 60));
    clearInterval(drawTimer);
    clearInterval(ackTimer);
    relay.stop({ forget: true, why: 'test' });
  }

  assert.ok(clock.draws > 0, 'the render clock stopped on a 503');
  assert.ok(clock.acks > 0, 'the ack clock stopped on a 503');
  assert.ok(Date.now() - started < 2_000, 'the 503 path must return immediately, not on the 10 s acquire timeout');
  // A waiting state, never `error`: an error tore the working synthetic view down.
  assert.ok(!states.includes('error'), `unexpected error state: ${states.join(',')}`);
  assert.ok(states.includes('idle'), `expected a quiet idle state: ${states.join(',')}`);
  assert.match(relay.reason() || '', /503/, `reason: ${relay.reason()}`);
  // The body's own reason survives, so "relay off" never reads as "no frame yet".
  assert.match(relay.reason() || '', /camera relay is off/, `reason: ${relay.reason()}`);
  const retry = events.find((e) => e.startsWith('retry-scheduled'));
  assert.ok(retry, `no backoff scheduled: ${events.join(' | ')}`);
});

const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
