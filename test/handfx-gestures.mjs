// Gesture classifier, posed by hand: no camera, no DOM, no browser.
//
// The three sweeps below are the ones the rig failed at, expressed as the landmark geometry a
// webcam actually produces:
//   · a relaxed open palm held at the lens   → palmUp (it is the effect's gesture)
//   · a fist                                 → not palmUp
//   · an edge-on hand                        → not palmUp
//   · a hand with two fingers out            → not palmUp (count < 3)
//
// `--old` runs the same four cases against the retired `uprightness` predicate, which is the red
// proof: run it first, watch it fail, then run the file plainly for the green one.
//
// The same shape repeated for `palmFront` (a palm held flat to the lens, all four fingers out):
//   · a relaxed open hand facing the lens  → palmFront
//   · a splayed flat hand                  → palmFront
//   · the same hand with the fingers relaxed rather than fanned → palmFront
//   · an edge-on hand                      → not palmFront
//   · a fist                               → not palmFront
// `--old-palmfront` swaps in the retired `0.9`-openness / absolute-z expression: it fails the
// camera-facing rows, which is what makes this sweep worth running.

import assert from 'node:assert/strict';
import {
  aimVector,
  classify,
  dedupeHands,
  extendedFingers,
  facingCorrected,
  OPEN_MAX,
  openness,
  palmArea,
  palmFacing,
  palmFacingSigned,
  scale,
  Thrust,
  THRUST_COOLDOWN_MS,
  THRUST_FACING_MIN,
  THRUST_FRAMES,
  THRUST_RATE,
  THRUST_WINDOW,
} from '../modules/handfx/pages/js/engine/gestures.js';
import { makeHand } from '../modules/handfx/pages/js/engine/pose.js';

const OLD = process.argv.includes('--old');
const OLD_FRONT = process.argv.includes('--old-palmfront');

// Reliable geometry: a palm-width of 0.42 unit at (0.5, 0.72), fingers slightly curled, which is
// the measured relaxed-open band (openness 0.755 — the file's own comment says 0.7–0.8).
const RELAXED = { cx: 0.5, cy: 0.72, s: 0.42, curl: { index: 0.2, middle: 0.25, ring: 0.3, pinky: 0.35 } };

/** The retired test, verbatim: screen-space finger direction plus the old 0.85 openness floor. */
function oldPalmUp(lm) {
  const v = { x: lm[9].x - lm[0].x, y: lm[9].y - lm[0].y };
  const uprightness = Math.max(0, -v.y / (Math.hypot(v.x, v.y) || 1));
  const open = openness(lm);
  const count = Object.values(extendedFingers(lm)).filter(Boolean).length;
  return open > 0.85 && count >= 3 && uprightness > 0.45 && lm[9].y < 0.85;
}

/** The retired palmFront, verbatim: the unreachable 0.9 openness floor plus an absolute wrist-relative z. */
function oldPalmFront(lm) {
  const open = openness(lm);
  const count = Object.values(extendedFingers(lm)).filter(Boolean).length;
  return open > 0.9 && count >= 4 && Math.abs(lm[8].z || 0) < 0.5 && lm[9].y < 0.85;
}

/** Turn the hand about the image y axis: palm plane takes the view axis, palm goes edge-on. */
function edgeOn(lm, deg) {
  const p = (deg * Math.PI) / 180;
  return lm.map((q) => ({
    x: (q.x - 0.5) * Math.cos(p) + (q.z || 0) * Math.sin(p) + 0.5,
    y: q.y,
    z: -((q.x - 0.5) * Math.sin(p)) + (q.z || 0) * Math.cos(p),
  }));
}

const cases = {
  // Palm at the lens, fingers extended but cocked across the frame — what an operator's hand
  // looks like on a desk webcam. 0.3 of screen-up is all that screen-space reading can see.
  cameraFacing: () => makeHand({ ...RELAXED, rot: 1.3 }),
  fist: () => makeHand({ ...RELAXED, curl: { index: 1, middle: 1, ring: 1, pinky: 1 } }),
  edgeOn: () => edgeOn(makeHand({ cx: 0.5, cy: 0.72, s: 0.42 }), 85),
  twoFingers: () => makeHand({ ...RELAXED, curl: { ring: 1, pinky: 1 } }),
};

const palmUp = OLD ? oldPalmUp : (lm) => classify([{ landmarks: lm, handedness: 'Left' }]).hands[0].palmUp;
const label = OLD ? 'OLD predicate' : 'NEW predicate';

const expect = { cameraFacing: true, fist: false, edgeOn: false, twoFingers: false };

// Every row prints before anything asserts, so a red run shows the whole picture.
const rows = [];
for (const [name, build] of Object.entries(cases)) {
  const lm = build();
  const open = openness(lm);
  const count = Object.values(extendedFingers(lm)).filter(Boolean).length;
  const facing = palmFacing(lm);
  const got = palmUp(lm);
  rows.push({ name, got });
  console.log(
    `${name.padEnd(13)} open ${open.toFixed(3)} count ${count} facing ${facing.toFixed(3)}  →  ${label} ${got} (want ${expect[name]})`,
  );
}
for (const row of rows) assert.equal(row.got, expect[row.name], `${label}: ${row.name}`);

// The full classifier, not just the flag: the camera-facing palm must be the returned gesture,
// and none of the negatives may masquerade as it.
if (!OLD) {
  assert.equal(classify([{ landmarks: cases.cameraFacing(), handedness: 'Left' }]).gesture, 'palmUp');
  for (const name of ['fist', 'edgeOn', 'twoFingers']) {
    assert.notEqual(classify([{ landmarks: cases[name](), handedness: 'Left' }]).gesture, 'palmUp', name);
  }
}

console.log(`${label}: all ${Object.keys(cases).length} cases pass (${OLD ? 'this is the red proof — it should NOT pass' : 'green'})`);

// ---------------------------------------------------------------------------------------------
// palmFront: the same palm, but held flat to the lens. Its own rows, predicate and flag.
const frontCases = {
  // A splayed flat hand: openness 1.043, four fingers out, palm square to the lens.
  flatFacing: () => makeHand({ cx: 0.5, cy: 0.72, s: 0.42 }),
  // The same hand turned across the frame, palm still at the glass. A real relaxed hand measures
  // 0.755 here, and this is the row the retired 0.9 openness floor throws away.
  cameraFacing: () => makeHand({ ...RELAXED, rot: 1.3 }),
  // Fingers extended but hanging relaxed instead of fanned: 0.706, still four fingers out.
  lowerOpenness: () => makeHand({ ...RELAXED, curl: { index: 0.25, middle: 0.3, ring: 0.35, pinky: 0.4 } }),
  // Turned 85° about the image y axis: palm plane along the view axis, facing 0.212.
  edgeOn: () => edgeOn(makeHand({ cx: 0.5, cy: 0.72, s: 0.42 }), 85),
  fist: () => makeHand({ ...RELAXED, curl: { index: 1, middle: 1, ring: 1, pinky: 1 } }),
};

const frontExpect = { flatFacing: true, cameraFacing: true, lowerOpenness: true, edgeOn: false, fist: false };

const palmFront = OLD_FRONT
  ? oldPalmFront
  : (lm) => classify([{ landmarks: lm, handedness: 'Left' }]).hands[0].palmFront;
const frontLabel = OLD_FRONT ? 'OLD palmFront' : 'NEW palmFront';

const frontRows = [];
for (const [name, build] of Object.entries(frontCases)) {
  const lm = build();
  const open = openness(lm);
  const count = Object.values(extendedFingers(lm)).filter(Boolean).length;
  const facing = palmFacing(lm);
  const got = palmFront(lm);
  frontRows.push({ name, got });
  console.log(
    `${name.padEnd(13)} open ${open.toFixed(3)} count ${count} facing ${facing.toFixed(3)}  →  ${frontLabel} ${got} (want ${frontExpect[name]})`,
  );
}
for (const row of frontRows) assert.equal(row.got, frontExpect[row.name], `${frontLabel}: ${row.name}`);

// And the classifier never returns palmFront for a closed or edge-on hand.
if (!OLD_FRONT) {
  for (const name of ['edgeOn', 'fist']) {
    assert.notEqual(classify([{ landmarks: frontCases[name](), handedness: 'Left' }]).gesture, 'palmFront', name);
  }
}

console.log(`${frontLabel}: all ${Object.keys(frontCases).length} cases pass (${OLD_FRONT ? 'this is the red proof — it should NOT pass' : 'green'})`);

// ---------------------------------------------------------------------------------------------
// Numerical safety: a degenerate frame must not outvote a threshold.
// `openness` is a fingertip distance divided by a palm width, and a palm width near zero divides
// into the tens. The 121 s capture recorded 11.35 (fist rows alongside open 5.4). The clamp is
// what makes the thresholds mean something again.
const degenerate = makeHand(RELAXED);
degenerate[9] = { ...degenerate[0], x: degenerate[0].x + 1e-6, y: degenerate[0].y };
const degenerateOpen = openness(degenerate);
console.log(`degenerate  palm width ${scale(degenerate).toFixed(6)}  →  openness ${degenerateOpen} (want ≤ ${OPEN_MAX})`);
assert.ok(degenerateOpen <= OPEN_MAX, `openness ${degenerateOpen} must not exceed ${OPEN_MAX}`);
assert.equal(degenerateOpen, OPEN_MAX, 'a collapsed palm width must clamp, not divide');

// The healthy hand still reports its real value, well under the clamp.
const healthyOpen = openness(makeHand(RELAXED));
console.log(`healthy     palm width ${scale(makeHand(RELAXED)).toFixed(3)}       →  openness ${healthyOpen.toFixed(3)}`);
assert.ok(healthyOpen > 0.6 && healthyOpen < OPEN_MAX, `relaxed hand should read ≈0.75, got ${healthyOpen}`);

// ---------------------------------------------------------------------------------------------
// One physical hand, detected twice. In the capture 117 of 123 two-hand samples had the palms
// 0.001-0.05 apart (median pair x 0.564 / 0.563). Collapsed to one, keeping the better score.
const alone = makeHand(RELAXED);
const clone = alone.map((p) => ({ ...p, x: p.x + 0.001, y: p.y + 0.001 }));
const pair = dedupeHands([
  { landmarks: alone, handedness: 'Left', score: 0.71 },
  { landmarks: clone, handedness: 'Right', score: 0.93 },
]);
console.log(`duplicate   palms 0.0014 apart  →  ${pair.length} hand(s), score ${pair[0].score} (want 1, 0.93)`);
assert.equal(pair.length, 1, 'a hand reported twice must collapse to one');
assert.equal(pair[0].score, 0.93, 'the higher-scoring detection wins');

// A real second hand a palm width away is not a duplicate — the dedupe must not eat it.
const elsewhere = makeHand({ ...RELAXED, cx: RELAXED.cx + 0.3 });
const two = dedupeHands([{ landmarks: alone }, { landmarks: elsewhere }]);
console.log(`real pair   palms 0.30 apart    →  ${two.length} hand(s) (want 2)`);
assert.equal(two.length, 2, 'two genuinely separate hands must both survive');

console.log('numerical safety: clamp and dedupe cases pass');

// ---------------------------------------------------------------------------------------------
// aimVector: the depth sign is the one thing that can silently ruin a projectile — a shot that
// leaves the hand backwards looks exactly like a shot that never fired. So all four sides of it
// are pinned here, and the formula in gestures.js follows these rows, not the other way round.
//
// The rows are built from the same synthetic palm the sweeps above call "facing the lens"
// (makeHand, no curl) and the same y-rotation helper (`edgeOn`) the palmFront sweep uses.
const FACING = makeHand({ cx: 0.5, cy: 0.72, s: 0.42 });

// 180° about the image y axis: the identical pose with the palm turned to face away.
const turnedAway = edgeOn(FACING, 180);
// 90°: the palm plane contains the view axis — edge-on, no depth component left.
const edge = edgeOn(FACING, 90);
// Square to the lens with no tilt at all: every landmark on z = 0, so the normal is pure depth.
const square = makeHand({ cx: 0.5, cy: 0.72, s: 0.42 }).map((p) => ({ ...p, z: 0 }));

const fmt = (a) => `x ${a.x.toFixed(3)} y ${a.y.toFixed(3)} z ${a.z.toFixed(3)}`;
const len3 = (a) => Math.hypot(a.x, a.y, a.z);

const aFacing = aimVector(FACING, 16, 9);
console.log(`aim facing   ${fmt(aFacing)}   (want z ≈ +1: toward the camera)`);
assert.ok(aFacing.z > 0.9, `a palm facing the camera must give positive z, got ${aFacing.z}`);
assert.ok(Math.abs(len3(aFacing) - 1) < 1e-6, `aim must be a unit vector, got |${len3(aFacing).toFixed(6)}|`);

const aAway = aimVector(turnedAway, 16, 9);
console.log(`aim away     ${fmt(aAway)}   (want z ≈ −1: away from the camera)`);
assert.ok(aAway.z < -0.9, `the same palm turned away must give negative z, got ${aAway.z}`);
assert.ok(Math.abs(aAway.z + aFacing.z) < 1e-9, 'turning the palm 180° must mirror z exactly');
assert.ok(Math.abs(len3(aAway) - 1) < 1e-6, `aim must be a unit vector, got |${len3(aAway).toFixed(6)}|`);

const aEdge = aimVector(edge, 16, 9);
console.log(`aim edge-on  ${fmt(aEdge)}   (want z ≈ 0, x,y well defined)`);
// The residual is the canonical hand's own slight tilt (thumb 0.05 nearer than the pinky), not the
// mapping: 0.13 of depth for a hand that is 90° to the lens.
assert.ok(Math.abs(aEdge.z) < 0.2, `an edge-on palm must give z ≈ 0, got ${aEdge.z}`);
assert.ok(Math.abs(len3(aEdge) - 1) < 1e-6, `aim must be a unit vector, got |${len3(aEdge).toFixed(6)}|`);
assert.ok(Math.hypot(aEdge.x, aEdge.y) > 0.9, 'an edge-on palm must still give a direction');

const aSquare = aimVector(square, 16, 9);
console.log(`aim square   ${fmt(aSquare)}   (want x ≈ y ≈ 0, |z| = 1)`);
assert.ok(Math.abs(aSquare.x) < 1e-9 && Math.abs(aSquare.y) < 1e-9, 'a palm square to the lens has no in-plane aim');
assert.equal(Math.abs(aSquare.z), 1, 'a palm square to the lens aims straight down the axis');
assert.ok(aSquare.z > 0, 'and a camera-facing square palm aims at the camera');

// The triple is a direction, not an in-plane pair plus a depth scalar: |norm| = 1 for every pose,
// because a caller that rotates a projectile by it is 35 % off at the measured median of 1.349.
for (const [name, lm] of Object.entries({ FACING, turnedAway, edge, square })) {
  const a = aimVector(lm, 16, 9);
  const n = len3(a);
  console.log(`aim unit     ${name.padEnd(10)} |norm| ${n.toFixed(9)}`);
  assert.ok(Math.abs(n - 1) < 1e-6, `${name}: |aimVector| must be 1, got ${n}`);
}

// The aspect is a parameter, not a global: the same normal reads differently on a square frame.
const wide = aimVector(edge, 16, 9);
const sq = aimVector(edge, 9, 9);
assert.notEqual(wide.x, sq.x, 'x must be scaled by the frame aspect it was given');
assert.equal(aimVector(FACING).z, aimVector(FACING, 16, 9).z, 'the default must be the 16:9 frame');

console.log('aim: camera-facing positive, away negative, edge ≈0, square axial');

// ---------------------------------------------------------------------------------------------
// Thrust: a launch is a motion. Every gesture above is a pose, and holding a pose keeps the palm
// area constant, so the ratio to its own average sits at 1 and cannot collide with them.
const STEP = 16.7; // 60 fps in ms

// Settle a baseline, then report the frames: `FIRE` or the rate that was not enough.
const run = (t, m, facing, from, frames) =>
  Array.from({ length: frames }, (_, i) => t.push(m, from + i * STEP, facing));

const steady = new Thrust();
let steadyFires = 0;
for (let i = 0; i < 40; i++) steadyFires += steady.push(0.02, i * STEP, 0.9).fire ? 1 : 0;
console.log(`thrust steady   40 frames constant area → ${steadyFires} fire(s) (want 0)`);
assert.equal(steadyFires, 0, 'a held pose is not a launch');

// A 1.2× push for three frames: exactly one launch, on the third rising frame.
const spike = new Thrust();
for (let i = 0; i < 10; i++) spike.push(0.02, i * STEP, 0.9);
const rise = run(spike, 0.024, 0.9, 10 * STEP, 8);
console.log(`thrust 1.2× rise ${rise.map((o) => (o.fire ? 'FIRE' : o.rate.toFixed(3))).join(' ')}`);
assert.equal(rise.filter((o) => o.fire).length, 1, 'a 3-frame 1.2× spike must fire exactly once');
assert.equal(rise.findIndex((o) => o.fire), THRUST_FRAMES - 1, `the fire lands on rising frame ${THRUST_FRAMES}`);
assert.ok(THRUST_RATE > 1 && THRUST_RATE < 1.2, 'the threshold must sit under a 1.2× push');

// The cooldown: a second push straight after the first is swallowed, and it re-arms after 500 ms.
const cool = new Thrust();
for (let i = 0; i < 10; i++) cool.push(1, i * STEP, 0.9);
const first = run(cool, 1.2, 0.9, 10 * STEP, 3);
assert.equal(first.filter((o) => o.fire).length, 1, 'the first push fires');
const inside = run(cool, 1.6, 0.9, 10 * STEP + 3 * STEP, 4);
console.log(`thrust in cooldown ${inside.map((o) => (o.fire ? 'FIRE' : o.rate.toFixed(3))).join(' ')} → 0 fire (want 0)`);
assert.equal(inside.filter((o) => o.fire).length, 0, 'a push inside the cooldown must not fire');
const after = run(cool, 1.6, 0.9, 10 * STEP + THRUST_COOLDOWN_MS + 200, 3);
console.log(`thrust after cooldown ${after.map((o) => (o.fire ? 'FIRE' : o.rate.toFixed(3))).join(' ')} → 1 fire (want 1)`);
assert.equal(after.filter((o) => o.fire).length, 1, 'the detector must re-arm after the cooldown');

// An edge-on hand cannot launch: the palm is not presented, so there is no aim to fire along.
const side = new Thrust();
for (let i = 0; i < 10; i++) side.push(1, i * STEP, 0.9);
const sideways = run(side, 1.2, THRUST_FACING_MIN - 0.2, 10 * STEP, 4);
console.log(`thrust facing ${(THRUST_FACING_MIN - 0.2).toFixed(1)}  ${sideways.map((o) => (o.fire ? 'FIRE' : o.rate.toFixed(3))).join(' ')} → 0 fire (want 0)`);
assert.equal(sideways.filter((o) => o.fire).length, 0, 'a palm below the facing floor must not fire');

// A signed gate, not a magnitude: the same depth with the opposite sign is the back of the hand.
const back = new Thrust();
for (let i = 0; i < 10; i++) back.push(1, i * STEP, 0.9);
const backwards = run(back, 1.2, -0.95, 10 * STEP, 4);
console.log(`thrust backwards z −0.95 ${backwards.map((o) => (o.fire ? 'FIRE' : o.rate.toFixed(3))).join(' ')} → 0 fire (want 0)`);
assert.equal(backwards.filter((o) => o.fire).length, 0, 'a palm presented backwards must not fire');

// ---------------------------------------------------------------------------------------------
// The dip proof. The real capture's clearest miss is seq 1175-1181: measured at 10 Hz the push
// reads 1.925 → 2.290 → 2.236 → 1.868 → 1.506 with facing 0.97 and a clear cooldown. The detector
// is fed at 30 fps, so between each pair of those samples sits a frame the diag never saw — the
// dips that reset a strict "3 consecutive" counter. Replaying exactly that 30 fps stream:
//   current rule — 3 rises among the last 5 frames → fires once
//   retired rule — 3 strictly consecutive rises → never fires (this is the red proof)
// `--old-thrust` swaps in the retired rule and asserts the same "exactly one" expectation, so it
// fails on the miss the capture reported.
const OLD_THRUST = process.argv.includes('--old-thrust');

/** The retired rule, verbatim: `hits` counts consecutive rises and any dip resets it. */
class OldThrust {
  constructor() {
    this.ema = 0;
    this.hits = 0;
    this.lastFireAt = -Infinity;
    this.fires = 0;
  }
  push(m, at, facing = 1) {
    if (!this.ema) {
      this.ema = m;
      return { fire: false, rate: 1 };
    }
    const rate = m / this.ema;
    const rising = rate > THRUST_RATE;
    this.hits = rising ? this.hits + 1 : 0;
    this.ema = 0.05 * m + 0.95 * this.ema;
    const fire = rising && facing > THRUST_FACING_MIN && this.hits >= 3 && at - this.lastFireAt >= THRUST_COOLDOWN_MS;
    if (fire) {
      this.lastFireAt = at;
      this.hits = 0;
      this.fires += 1;
    }
    return { fire, rate };
  }
}

// Feed target *rates*, not areas: m = rate × the detector's own average, so each frame lands on
// the rate the capture measured. A dip of 0.92 is the sub-threshold frame between two samples.
const measured = [1.925, 2.290, 2.236, 1.868, 1.506];
const stream = [];
for (const r of measured) {
  stream.push(r);
  stream.push(0.92); // the 30 fps frame the 10 Hz diag could not see
}

function replay(Det) {
  const t = new Det();
  for (let i = 0; i < 10; i++) t.push(0.02, i * STEP, 0.97); // settle the baseline
  return stream.map((rate, i) => {
    const o = t.push(rate * t.ema, 10 * STEP + i * STEP, 0.97);
    return { ...o, target: rate };
  });
}

const rule = OLD_THRUST ? 'OLD consecutive' : 'NEW window';
const played = replay(OLD_THRUST ? OldThrust : Thrust);
console.log(
  `thrust dip ${rule.padEnd(15)} ${played
    .map((o) => (o.fire ? 'FIRE' : o.target.toFixed(3)))
    .join(' ')}`,
);
assert.equal(
  played.filter((o) => o.fire).length,
  1,
  OLD_THRUST
    ? 'RED PROOF: the retired consecutive rule drops the measured push (it should NOT pass)'
    : 'the measured push must fire exactly once',
);
// A frame over the rate floor that did not fire must say why: this is what the next capture reads.
if (!OLD_THRUST) {
  for (const o of played) {
    if (o.rate >= THRUST_RATE && !o.fire) {
      assert.ok(o.gate, `rate ${o.rate.toFixed(3)} did not fire and named no gate`);
      assert.ok(['rate', 'window', 'facing', 'cooldown'].includes(o.gate), `unknown gate ${o.gate}`);
    }
  }
  assert.ok(THRUST_WINDOW >= THRUST_FRAMES, 'the window must be able to hold the required rises');
}

// The window must still refuse a steady hold: a constant area is never a rise, so no window of
// any length can fill. The `steady` case above already pins the count; this pins the reason.
const hold = new Thrust();
for (let i = 0; i < 10; i++) hold.push(0.02, i * STEP, 0.97);
const held = run(hold, 0.02, 0.97, 10 * STEP, 20);
console.log(`thrust hold    20 more constant frames → ${held.filter((o) => o.fire).length} fire(s), gates ${[...new Set(held.map((o) => o.gate))].join(',')} (want 0, rate)`);
assert.equal(held.filter((o) => o.fire).length, 0, 'a steady hold must stay silent under the window rule');
assert.ok(held.every((o) => o.gate === 'rate'), 'a constant area must be refused by the rate gate, not the window');

// The area proxy is the palm's own cross product, so it scales with the hand's distance.
const near = palmArea(FACING);
const far = palmArea(makeHand({ cx: 0.5, cy: 0.72, s: 0.21 }));
console.log(`thrust area     palm ${(near / far).toFixed(2)}× wider → area proxy ${(near / far).toFixed(2)}× larger`);
assert.ok(near > far * 3.9, 'area must follow the palm, so distance reads as a size change');

console.log('thrust: steady silent, 3-frame push fires, cooldown holds, facing gates');

