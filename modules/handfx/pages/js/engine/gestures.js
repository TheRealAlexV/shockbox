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

/** Palm width in unit space: wrist → middle-finger MCP. The only scale a frame gives us. */
export function scale(lm) {
  return Math.max(1e-4, d2(lm[0], lm[9]));
}

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
export function openness(lm) {
  const palm = lm[9];
  const s = scale(lm);
  const tips = [lm[8], lm[12], lm[16], lm[20]];
  const mean = tips.reduce((acc, t) => acc + d2(t, palm), 0) / tips.length / s;
  return mean; // ≈0.4 closed fist, ≈1.0 open palm
}

/** How flat/horizontal the palm is: 1 = fingers pointing up (palm up), 0 = sideways. */
export function uprightness(lm) {
  const v = sub(lm[9], lm[0]);
  const m = Math.hypot(v.x, v.y) || 1;
  return Math.max(0, -v.y / m);
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
    const palmUp = open > 0.85 && count >= 3 && uprightness(lm) > 0.45 && lm[9].y < 0.85;
    const palmFront = open > 0.9 && count >= 4 && Math.abs(lm[8].z || 0) < 0.5 && lm[9].y < 0.85;
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
