// Hand-shape helpers: a canonical palm that can be placed, rotated, mirrored and curled, so the
// classifier's two-hand poses and the offline synthetic hand are built from one description.

const TIPS = { index: 8, middle: 12, ring: 16, pinky: 20 };
const PIPS = { index: 6, middle: 10, ring: 14, pinky: 18 };

export function unit(v) {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

/**
 * Fold one finger towards the palm. `t` = 0 leaves it extended, 1 folds the tip back onto the
 * knuckle; the joint chain is bent in proportion so a fingertip-distance test reads it as closed.
 */
export function curlFinger(lm, name, t) {
  if (!t || TIPS[name] === undefined) return lm;
  const mcp = lm[PIPS[name] - 1];
  const pip = lm[PIPS[name]];
  const dip = lm[TIPS[name] - 1];
  const wrist = lm[0];
  // "back" of the hand: from the knuckle towards the wrist, lifted away from the camera, which is
  // where a folded finger lies.
  const fold = unit({ x: wrist.x - mcp.x, y: wrist.y - mcp.y, z: -1 });
  const len = dist(mcp, lm[TIPS[name]]) || 1e-3;
  const reach = len * (1 - 0.85 * t);
  const at = (from, k) => ({ x: lerp(from.x, mcp.x + fold.x * reach * k, t), y: lerp(from.y, mcp.y + fold.y * reach * k, t) });
  const pip2 = at(pip, 0.45);
  const dip2 = at(dip, 0.75);
  lm[pip] = { ...pip2, z: lerp(pip.z || 0, -0.02, t) };
  lm[dip] = { ...dip2, z: lerp(dip.z || 0, -0.03, t) };
  lm[TIPS[name]] = { x: lerp(lm[TIPS[name]].x, mcp.x + fold.x * reach, t), y: lerp(lm[TIPS[name]].y, mcp.y + fold.y * reach, t), z: lerp(lm[TIPS[name]].z || 0, -0.04, t) };
  return lm;
}

/**
 * The canonical open palm in MediaPipe's 21-landmark order: wrist at (0,0), fingertips at
 * y ≈ −1, thumb towards −x (the left hand as MediaPipe reports it in mirrored video).
 */
export const OPEN_PALM = [
  [0, 0, 0],
  [-0.18, -0.06, -0.02], [-0.26, -0.16, -0.03], [-0.31, -0.26, -0.04], [-0.35, -0.35, -0.05],
  [-0.15, -0.42, -0.01], [-0.17, -0.62, -0.01], [-0.18, -0.76, -0.01], [-0.19, -0.9, -0.01],
  [-0.02, -0.46, 0], [-0.02, -0.69, 0], [-0.02, -0.85, 0], [-0.02, -1.0, 0],
  [0.11, -0.44, 0], [0.13, -0.64, 0], [0.14, -0.78, 0], [0.15, -0.9, 0],
  [0.22, -0.38, 0.01], [0.26, -0.54, 0.01], [0.28, -0.66, 0.01], [0.29, -0.77, 0.01],
];

/**
 * Place the palm at (cx, cy), `s` = palm width in unit space, rotated `rot` radians, mirrored for
 * a right hand, with `curl` = { finger: 0..1 } folded.
 */
export function makeHand({ cx = 0.5, cy = 0.6, s = 0.5, rot = 0, right = false, curl = {} } = {}) {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const lm = OPEN_PALM.map(([x0, y0, z]) => {
    const x = right ? -x0 : x0;
    return { x: cx + (x * cos - y0 * sin) * s, y: cy + (x * sin + y0 * cos) * s, z };
  });
  for (const [name, t] of Object.entries(curl)) curlFinger(lm, name, t);
  return lm;
}
