// Gesture recognition for the ShockFX overlay (module id `handfx`).
//
// Pure functions over MediaPipe's 21 landmarks (unit coords, 0–1, y down, z toward the camera
// negative). No rendering, no camera: handed a hand it returns what the hand is doing, so the
// classifier is testable from a scripted pose (see syntheticHands in tracker.js).
//
// The two shipped gestures are ported from the OBS project:
//   fireball   — fireball-controller/main.py `is_hand_open`: the mean distance of the four
//                fingertips (8,12,16,20) from the palm centre (landmark 9) exceeds a threshold,
//                i.e. an open hand, with the palm facing up for the ball to sit on.
//   lightning  — obs-handfx "ShockFX" lightning: both hands present and raised, index and middle
//                fingertips arched towards each other.
// The rest are the module's own, chosen so a hand can drive a whole effect list.

const TIPS = { index: 8, middle: 12, ring: 16, pinky: 20 };
const PIPS = { index: 6, middle: 10, ring: 14, pinky: 18 };

function d2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
}
function unit(v) {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Palm width in unit space: wrist → middle-finger MCP. The only scale a frame gives us. */
export function scale(lm) {
  return Math.max(1e-4, d2(lm[0], lm[9]));
}

// MediaPipe sometimes reports one physical hand twice. In the 121 s capture 117 of 123 two-hand
// samples had the palms less than 0.05 normalised units apart (median pair: x 0.564 / 0.563,
// dy 0.001), which double-counted extended fingers and faked a palm touch on 11.8 % of samples.
// Two real hands cannot be that close: a palm measures 0.2-0.42 wide here, so genuine palm centres
// stay roughly 0.2 apart at the tightest. 0.06 sits just above the widest duplicate and well below
// any honest pair, so it collapses copies without merging a real second hand.
export const DUPLICATE_HAND_DIST = 0.06;

/** Which fingers are extended, from the angle at each PIP joint (a curled finger folds back). */
export function extendedFingers(lm) {
  const s = scale(lm);
  const out = {};
  for (const [name, tip] of Object.entries(TIPS)) {
    const pip = PIPS[name];
    const u = unit(sub(lm[tip], lm[pip]));
    const v = unit(sub(lm[pip], lm[0]));
    // Extended when the finger continues along the same direction as the segment below it.
    out[name] = dot(u, v) > 0.55 && d2(lm[tip], lm[0]) / s > 1.35;
  }
  return out;
}

export function countExtended(lm) {
  return Object.values(extendedFingers(lm)).filter(Boolean).length;
}

/**
 * The old project's open-hand test, kept numerically identical in spirit: mean fingertip
 * distance from the palm centre, in palm-widths (the old code compared in normalised units and
 * called anything over 0.12 open; a palm width here is ~0.28 normalised, so 0.12 ≈ 0.43 pw).
 */
/** Collapse hands the detector reported twice, comparing palm centres (landmark 9). Keeps the
 *  higher MediaPipe score when the frame carries one, otherwise the first seen. */
export function dedupeHands(hands) {
  const out = [];
  for (const hand of hands || []) {
    const palm = hand.landmarks[9];
    const i = out.findIndex((kept) => {
      const k = kept.landmarks[9];
      return Math.hypot(k.x - palm.x, k.y - palm.y) < DUPLICATE_HAND_DIST;
    });
    if (i === -1) out.push(hand);
    else if ((hand.score || 0) > (out[i].score || 0)) out[i] = hand;
  }
  return out;
}

/**
 * Ceiling for `openness`. A real splayed hand measures ~1.0-1.04, so 2.0 is unreachable by an
 * honest frame and only trips on a degenerate one. The 121 s capture recorded 11.35: a palm width
 * near zero divides a fingertip distance into the tens, and the thresholds stop meaning anything.
 */
export const OPEN_MAX = 2;

/**
 * Floor for the palm-width divisor. Under this the wrist and the middle MCP have collapsed onto
 * each other, so the "scale" is noise rather than a hand — applying it would multiply the measure,
 * not normalise it. 0.02 is a tenth of the narrowest palm measured here (~0.2).
 */
const PALM_MIN = 0.02;

export function openness(lm) {
  const palm = lm[9];
  const s = Math.max(scale(lm), PALM_MIN);
  const tips = [lm[8], lm[12], lm[16], lm[20]];
  const mean = tips.reduce((acc, t) => acc + d2(t, palm), 0) / tips.length / s;
  return Math.min(OPEN_MAX, mean); // ≈0.4 closed fist, ≈1.0 open palm, never above 2
}

/**
 * How squarely the palm faces the lens: 1 = the palm plane is parallel to the image (hand presented
 * to the camera), 0 = the hand is edge-on. The palm plane is pinned by the wrist (0) and the two
 * outer knuckles (index 5, pinky 17); 0→5 × 0→17 is the palm normal, and the view axis is z, so
 * |n.z| / |n| is the cosine of the palm's tilt away from the image plane. Depth values are the
 * only place MediaPipe reports orientation, which is why the old screen-space test could not do
 * this job: it scored a hand tilted at the lens as "sideways" (fingers turned across the frame)
 * and scored an edge-on hand as a perfect palm (fingers straight up the screen).
 */
export function palmNormal(lm) {
  return cross(sub(lm[5], lm[0]), sub(lm[17], lm[0]));
}

export function palmFacing(lm) {
  const n = palmNormal(lm);
  return Math.abs(n.z) / (Math.hypot(n.x, n.y, n.z) || 1);
}

/**
 * The signed depth of the palm normal: +1 toward the camera, −1 away. `palmFacing` is its
 * magnitude, so a capture that published only `palmFacing` could not tell a palm presented to the
 * lens from the back of the same hand. Measured on the real fires: a `Left` hand with its palm at
 * the lens gives `norm.z` **+0.927 … +0.987**, so Left-positive is the convention this keeps.
 */
export function palmFacingSigned(lm) {
  const n = palmNormal(lm);
  return n.z / (Math.hypot(n.x, n.y, n.z) || 1);
}

/**
 * The signed depth the thrust gate must use. 2D landmarks carry no chirality, so MediaPipe's
 * `handedness` label is the only cue: a `Right` hand is mirrored relative to a `Left`, so its
 * sign is flipped to keep the one Left-positive convention. Without this, a palm presented
 * backwards reads positive and passes `facingMin`.
 */
export function facingCorrected(lm, handedness) {
  const z = palmFacingSigned(lm);
  return handedness === 'Right' ? -z : z;
}

/** The palm's area proxy: |0→5 × 0→17|. Moves with the hand's distance from the lens. */
export function palmArea(lm) {
  const n = palmNormal(lm);
  return Math.hypot(n.x, n.y, n.z);
}

/** In-plane component under which a palm has no direction to steer with, only depth. */
export const AIM_FLAT_EPS = 1e-6;

/**
 * Where the palm points, in the renderer's own frame (`toUv`: x * aspect, 1 − y). `x`/`y` are a
 * unit vector across the image, `z` is the depth component: **+1 toward the camera, −1 away**.
 *
 * The sign is measured, not read off a spec. `palmNormal` is (0→5) × (0→17), and for the hand
 * MediaPipe reports that cross product comes out of the *back* of the hand: the synthetic
 * camera-facing palm (`makeHand` in pose.js, the same pose the palmFront sweep calls a palm square
 * to the lens) yields n.z ≈ +0.026 with its palm toward the camera, and its folded fingers lie at
 * negative z. So the aim is `-n`, and a camera-facing palm reports z ≈ +1. Getting this wrong is
 * the one failure that would look like "nothing happened", which is why the sweep in
 * test/handfx-gestures.mjs pins all four sides of it.
 *
 * Pure and importable: `w`/`h` are parameters (a 16:9 frame by default), never read from a global.
 */
export function aimVector(lm, w = 16, h = 9) {
  const n = palmNormal(lm);
  return aimFromPalm({ x: -n.x, y: -n.y, z: -n.z }, w, h);
}

/** The same mapping, from a palm-side normal, so a caller that already built one need not re-cross. */
export function aimFromPalm(p, w = 16, h = 9) {
  if (p.x * p.x + p.y * p.y < AIM_FLAT_EPS) {
    // Square to the lens: nothing to aim across the image with, only straight in or straight out.
    return { x: 0, y: 0, z: p.z < 0 ? 1 : -1 };
  }
  const aspect = w > 0 && h > 0 ? w / h : 1;
  const az = -p.z; // MediaPipe z is negative toward the camera
  // Normalise the whole triple, not the in-plane pair on its own: `x`/`y` are a direction across
  // the image, `z` the depth, so the three must sum to 1 or a caller treating `aim` as a direction
  // is off by |aim| (measured 1.000–1.406, median 1.349, on 266 captured samples). Scaling x and y
  // by their old in-plane length and z separately was what broke it; dividing all three by one
  // length leaves the in-plane direction unchanged and keeps every sign.
  const v = { x: p.x * aspect, y: -p.y, z: az };
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return {
    x: v.x / len,
    y: v.y / len,
    z: Math.max(-1, Math.min(1, v.z / len)),
  };
}

/** Is at least one fingertip above its knuckle and the hand in the frame's upper 3/4? */
export function raised(lm) {
  return lm[12].y < lm[5].y && lm[9].y < 0.92;
}

/**
 * Classify one frame. Returns `{ gesture, hands: [...] }` where gesture is one of:
 *   'none' | 'palmUp' | 'point' | 'palmFront' | 'swipe' | 'fist' | 'bothFingertips' | 'palmTouch' |
 *   'bothPalmsUp' | 'bothRaised'
 * and each hand carries its own reading so the renderer can place effects per hand.
 *
 * @param {{landmarks:Array, handedness?:string}[]} hands
 * @param {{swipe?:{dir:number, speed:number}}} ctx motion state from the caller (frame history)
 */
export function classify(hands, ctx = {}) {
  const readings = (hands || []).slice(0, 2).map((h) => {
    const lm = h.landmarks;
    const ext = extendedFingers(lm);
    const open = openness(lm);
    const count = Object.values(ext).filter(Boolean).length;
    // A hand presented to the lens: three or more fingers extended, the palm actually oriented at
    // the camera (palmFacing, from the landmark depths) rather than merely pointing up the screen,
    // and held in the frame's upper part. Openness is the relaxed-open band (~0.7–0.8), so the
    // threshold sits below it; a fist measures ~0.3 and still fails.
    const palmUp = open > 0.62 && count >= 3 && palmFacing(lm) > 0.4 && lm[9].y < 0.85;
    // The same hand, but held flat to the glass: all four fingers out and the palm squarely at the
    // lens. The facing test is stricter than palmUp's 0.4 because an open palm-up hand reclines
    // naturally (~66° off the image plane still reads as presented), while "palm front" means face
    // on: 0.7 keeps the palm within ~45° of the glass (edge-on measures ~0.2). Openness is only a
    // "fingers are out" floor here: a relaxed hand sits ~0.7–0.8, a fist ~0.3, so 0.55 clears a
    // fist by a wide margin and admits a hand that is extended but not fanned.
    const palmFront = open > 0.55 && count >= 4 && palmFacing(lm) > 0.7 && lm[9].y < 0.85;
    const point = ext.index && !ext.middle && !ext.ring && !ext.pinky;
    const fist = count === 0;
    return { landmarks: lm, handedness: h.handedness || null, ext, open, count, palmUp, palmFront, point, fist, centre: { x: lm[9].x, y: lm[9].y }, scale: scale(lm) };
  });

  if (!readings.length) return { gesture: 'none', hands: [] };
  if (readings.length === 1) {
    const h = readings[0];
    if (ctx.swipe && ctx.swipe.speed > 0.55 && h.open > 0.8) return { gesture: 'swipe', hands: readings };
    if (h.palmUp) return { gesture: 'palmUp', hands: readings };
    if (h.point) return { gesture: 'point', hands: readings };
    if (h.palmFront) return { gesture: 'palmFront', hands: readings };
    if (h.fist) return { gesture: 'fist', hands: readings };
    return { gesture: 'none', hands: readings };
  }

  const [a, b] = readings;
  const between = (i) => d2(a.landmarks[i], b.landmarks[i]);
  const s = Math.max(a.scale, b.scale);
  // A fingertip-arch is read relative to each hand's own size (a phone camera at 480p gives a
  // palm width of ~0.2 unit, a webcam at 720p ~0.1), never in absolute pixels.
  const idx = between(8) / s;
  const mid = between(12) / s;
  const palmGap = between(9) / s;
  const arched =
    idx < 2.6 &&
    mid < 3.6 &&
    palmGap > 1.4 &&
    a.landmarks[8].y < a.landmarks[5].y + 0.02 &&
    b.landmarks[8].y < b.landmarks[5].y + 0.02;
  if (arched) return { gesture: 'bothFingertips', hands: readings };
  // Palms together: the palm centres nearly meet, whatever the fingers do.
  if (palmGap < 1.6) return { gesture: 'palmTouch', hands: readings };
  if (a.palmUp && b.palmUp) return { gesture: 'bothPalmsUp', hands: readings };
  if (raised(a.landmarks) && raised(b.landmarks)) return { gesture: 'bothRaised', hands: readings };
  return { gesture: 'none', hands: readings };
}

/**
 * Motion tracker for the swipe: keeps the last few palm centres and reports the horizontal
 * speed in frame widths per second. Call once per frame with the frame timestamp.
 */
export class Motion {
  constructor(windowMs = 260) {
    this.windowMs = windowMs;
    this.samples = [];
  }
  push(centre, at) {
    if (!centre) {
      this.samples.length = 0;
      return { dir: 0, speed: 0 };
    }
    this.samples.push({ x: centre.x, at });
    while (this.samples.length > 1 && at - this.samples[0].at > this.windowMs) this.samples.shift();
    if (this.samples.length < 2) return { dir: 0, speed: 0 };
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = Math.max(1, last.at - first.at) / 1000;
    const dx = last.x - first.x;
    return { dir: Math.sign(dx), speed: Math.abs(dx) / dt };
  }
}

/**
 * Turn per-frame readings into events the effects act on: a gesture must hold for `holdMs` before
 * it fires (a single flickering frame must not spawn a fireball), and a fire re-arms only after
 * the gesture has been absent for `cooldownMs`. Every decision is reported, so the pane can show
 * exactly why an effect did or did not appear.
 */
export class GestureGate {
  constructor({ holdMs = 140, cooldownMs = 700 } = {}) {
    this.holdMs = holdMs;
    this.cooldownMs = cooldownMs;
    this.current = 'none';
    this.since = 0;
    this.armed = true;
    this.lastFired = null;
    this.lastFiredAt = 0;
  }
  update(gesture, at) {
    if (gesture !== this.current) {
      this.current = gesture;
      this.since = at;
    }
    const held = at - this.since;
    if (gesture === 'none') {
      this.armed = true;
      return { fire: null, held, armed: true };
    }
    const ready = this.armed && held >= this.holdMs;
    if (!ready) return { fire: null, held, armed: this.armed };
    this.armed = false;
    this.lastFired = gesture;
    this.lastFiredAt = at;
    return { fire: gesture, held, armed: false };
  }
  /** Re-arm after the cooldown even if the hand never left (a raised fireball should not need a
   *  full hand-drop to re-trigger a *different* gesture — only the same one waits). */
  tick(at) {
    if (this.armed) return;
    if (this.current === 'none' || at - this.lastFiredAt > this.cooldownMs) this.armed = true;
  }
}

// A launch is a motion, not a pose. Every gesture above is a predicate on one frame, and holding
// one gives a constant palm area, so the area's ratio to its own running average sits at ~1 and
// cannot collide with them: only a push toward the lens inflates it.
export const THRUST_RATE = 1.15; // palm area ÷ its running average
export const THRUST_FRAMES = 3; // rises needed before a launch
/** Frames the rise count looks back over. A 30 fps push is fed roughly three frames per 10 Hz diag
 *  sample, so a single dip (hand occlusion sliver, landmark jitter) sits between the rises the diag
 *  *does* see; requiring them strictly consecutive threw away 8 of 13 fireable pushes in the
 *  capture. A window of 5 admits one dip and still cannot fire on a hold — see `push`. */
export const THRUST_WINDOW = 5;
export const THRUST_COOLDOWN_MS = 500;
export const THRUST_FACING_MIN = 0.3; // the palm has to be presented, not edge-on
/** ~20-frame baseline (≈330 ms at 60 fps): slow enough that a 3-frame push cannot drag the
 *  average up out from under its own rise. A faster one swallows the spike it is meant to see. */
export const THRUST_EMA_ALPHA = 0.05;

/**
 * Thrust detector: one palm area per frame in, one launch decision out. Time is injected, so a
 * test drives it at whatever frame rate it likes. One instance per hand — the EMA never mixes
 * two hands' distances.
 *
 * The rise rule is a sliding window, not a run: a frame is a *rise* when the area is over
 * `THRUST_RATE`× its own average, and a launch needs `THRUST_FRAMES` rises among the last
 * `THRUST_WINDOW` frames. That tolerates one non-rise frame inside a push while still needing
 * three separate frames above the threshold. It cannot fire on a held pose: a constant area sits
 * at ~1.0× its average, so no frame is ever a rise and the count stays at 0 no matter how long the
 * pose is held.
 *
 * `facing` must be the **handedness-corrected signed** depth (`palmFacingSigned`), not
 * `palmFacing`'s absolute value: with the absolute value a palm shown backwards passes the gate.
 */
export class Thrust {
  constructor({
    rate = THRUST_RATE,
    frames = THRUST_FRAMES,
    span = THRUST_WINDOW,
    cooldownMs = THRUST_COOLDOWN_MS,
    facingMin = THRUST_FACING_MIN,
    alpha = THRUST_EMA_ALPHA,
  } = {}) {
    this.rate = rate;
    this.frames = frames;
    this.span = span;
    this.cooldownMs = cooldownMs;
    this.facingMin = facingMin;
    this.alpha = alpha;
    this.ema = 0;
    this.rises = []; // the last `span` frames, true = a rise; the window the count reads
    this.riseCount = 0;
    this.lastGate = null; // which gate refused the last frame, for the diag
    this.lastFireAt = -Infinity;
    this.fires = 0;
  }
  /**
   * `m` = `palmArea(lm)`, `at` = the frame timestamp in ms, `facing` = the signed, handedness-
   * corrected `palmFacingSigned(lm, handedness)`. Returns the decision with the numbers that made
   * it — `rises` (the window count) and `gate` (the first gate that refused, or null when it
   * fired or nothing was pushed) — so a capture explains a non-launch without a re-run.
   */
  push(m, at, facing = 1) {
    if (!(m > 0)) {
      this.rises.length = 0; // a lost hand is not a rise
      this.riseCount = 0;
      this.lastGate = 'rate';
      return { fire: false, rate: 0, ema: this.ema, m: 0, rises: 0, gate: this.lastGate };
    }
    if (!this.ema) {
      this.ema = m; // first sight of the hand: no average to rise above yet
      return { fire: false, rate: 1, ema: this.ema, m, rises: 0, gate: 'rate' };
    }
    const rate = m / this.ema;
    const rising = rate > this.rate;
    this.rises.push(rising);
    if (this.rises.length > this.span) this.rises.shift();
    this.riseCount = this.rises.reduce((n, r) => n + (r ? 1 : 0), 0);
    const count = this.riseCount; // the count that made this decision, before any reset
    this.ema = this.alpha * m + (1 - this.alpha) * this.ema;
    // The first gate that refused, in the order the decision applies them. `fire` means none did.
    let gate = null;
    if (!rising) gate = 'rate';
    else if (count < this.frames) gate = 'window';
    else if (!(facing > this.facingMin)) gate = 'facing';
    else if (at - this.lastFireAt < this.cooldownMs) gate = 'cooldown';
    const fire = gate === null;
    if (fire) {
      this.lastFireAt = at;
      this.rises.length = 0;
      this.riseCount = 0;
      this.fires += 1;
    }
    this.lastGate = fire ? null : gate;
    return { fire, rate, ema: this.ema, m, rises: count, gate: this.lastGate };
  }
  /** Forget the hand: the next frame seeds a fresh average instead of spiking against a stale one. */
  reset() {
    this.ema = 0;
    this.rises.length = 0;
    this.riseCount = 0;
    this.lastGate = null;
    return this;
  }
}
