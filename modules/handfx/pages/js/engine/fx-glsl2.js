// Second wave of GLSL for the ShockFX overlay, same contract as fx-glsl.js: every program is
// GLSL ES 3.00 (`#version 300 es`), WebGL2 only, no extensions, and every fragment writes
// premultiplied light + alpha (`outColor = vec4(col * a, a)`) so the composite pass can just add
// it. Effects are deterministic from `u_time` and `u_seed`, and none may wash the frame flat.
//
// `PRELUDE` is re-exported for callers that want to see what an effect starts from; every effect's
// template already starts with it, so the string a template holds is a complete fragment shader.

export const PRELUDE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_res;      // canvas size in pixels
uniform float u_time;    // seconds
uniform float u_aspect;  // width / height
uniform vec3 u_seed;     // per-effect offset so two effects never share a noise field
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
vec2 hash21(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i).x, hash21(i + vec2(1.0, 0.0)).x, u.x),
             mix(hash21(i + vec2(0.0, 1.0)).x, hash21(i + vec2(1.0, 1.0)).x, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash31(i), b = hash31(i + vec3(1.0, 0.0, 0.0));
  float c = hash31(i + vec3(0.0, 1.0, 0.0)), d = hash31(i + vec3(1.0, 1.0, 0.0));
  float e = hash31(i + vec3(0.0, 0.0, 1.0)), g = hash31(i + vec3(1.0, 0.0, 1.0));
  float h = hash31(i + vec3(0.0, 1.0, 1.0)), k = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float fbm(vec2 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    v += a * vnoise(p);
    p = p * 2.02 + 17.3;
    a *= 0.5;
  }
  return v;
}
float fbm3(vec3 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    v += a * vnoise3(p);
    p *= 2.04;
    a *= 0.5;
  }
  return v;
}
vec2 field() {           // 0..1 uv, x scaled by aspect so circles stay round
  return vec2(v_uv.x * u_aspect, v_uv.y);
}
`;


/* ------------------------------------------------------------------ wires */

/**
 * Bright filaments along a hand skeleton (21 landmarks in field space, x already multiplied by
 * u_aspect). Each bone is a curve: the straight line is pushed sideways by 1-D fbm that runs along
 * the bone AND in time, so the filament wanders instead of snapping frame to frame. A brightness
 * packet runs along every bone at a per-bone speed. Bones touching a landmark at (0,0) - the
 * tracker's "not seen" sentinel - are skipped. The bone table is not written here: `u_bone_a` /
 * `u_bone_b` carry the pairs from the engine's GESTURE_BONES, and `u_count` says how many of them
 * to draw - one list, so the shader can never fall out of step with the skeleton it draws.
 * `u_energy` widens and brightens; `u_fade` is the overall level.
 */
export const WIRES = `${PRELUDE}
uniform vec2 u_p[21];
const int BONE_MAX = 24;   // >= GESTURE_BONES.length; slots past u_count are never read
uniform int u_bone_a[BONE_MAX];
uniform int u_bone_b[BONE_MAX];
uniform int u_count;
uniform float u_energy;
uniform float u_fade;

float filament(float d, float w) {
  float core = smoothstep(w, 0.0, d);
  float halo = smoothstep(w * 8.0, 0.0, d) * 0.22;
  return core * 1.5 + halo;
}

void main() {
  vec2 p = field();
  vec3 acc = vec3(0.0);
  float a = 0.0;
  float amp = 0.006 + 0.010 * u_energy;
  for (int i = 0; i < BONE_MAX; i++) {
    if (i >= u_count) break;
    vec2 A = u_p[u_bone_a[i]];
    vec2 B = u_p[u_bone_b[i]];
    if (dot(A, A) < 1e-8 || dot(B, B) < 1e-8) continue;
    vec2 ab = B - A;
    float len = max(length(ab), 1e-5);
    vec2 dir = ab / len;
    vec2 nrm = vec2(-dir.y, dir.x);
    float t = clamp(dot(p - A, dir), 0.0, len);
    float along = t / len;
    float seed = float(i) * 3.7 + u_seed.x * 11.0 + u_seed.z * 5.0;
    float wob = (fbm(vec2(along * 3.4 + seed, u_time * 0.35 + seed * 0.5), 3) - 0.5) * amp;
    wob += (vnoise(vec2(along * 13.0 + seed, u_time * 1.4)) - 0.5) * amp * 0.35;
    vec2 q = A + dir * t + nrm * wob;
    vec2 dq = p - q;
    dq.x *= u_aspect;   // field x is aspect-scaled, keep the wire round in page space
    float d = length(dq);
    float spd = 0.35 + hash11(seed) * 0.9 + 0.25 * u_energy;
    float ph = fract(u_time * spd + hash11(seed * 2.3));
    float pulse = 0.35 + 1.1 * exp(-pow((along - ph) * 5.0, 2.0));
    float f = filament(d, 0.0040 + 0.0026 * u_energy) * pulse;
    float joint = smoothstep(0.020, 0.0, length(p - A)) * 0.5;
    vec3 col = mix(vec3(0.45, 0.80, 1.0), vec3(0.92, 0.98, 1.0), clamp(f * 0.8, 0.0, 1.0));
    acc += col * (f + joint);
    a += f + joint * 0.5;
  }
  acc = acc / (1.0 + acc * 0.4);
  a = clamp(a, 0.0, 1.0) * u_fade * (0.75 + 0.45 * u_energy);
  outColor = vec4(acc * u_fade * (1.0 + 0.8 * u_energy), a);
}`;

/* ------------------------------------------------------------------ aura */

/**
 * A glow hugging a hand-shaped blob: the radius is modulated by an angular fbm so the silhouette
 * is lobed and organic. The rim is the bright band, ripples drift inward from it, and a faint warm
 * haze sits just outside. The centre is left hollow on purpose, so the outline carries the effect
 * and the frame is never covered by a disc.
 */
export const AURA = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;
void main() {
  vec2 p = field() - u_center;
  float r = length(p) + 1e-5;
  float ang = atan(p.y, p.x);
  float R = u_radius;
  float lobes = fbm3(vec3(cos(ang) * 1.7, sin(ang) * 1.7, u_time * 0.25) + u_seed, 3) - 0.5;
  float shape = R * (0.82 + 0.30 * (0.5 + lobes * 1.6));
  float u = r / shape;
  float rim = exp(-pow((u - 1.0) * 7.0, 2.0));
  float rip = 0.5 + 0.5 * sin((u * 9.0 + u_time * 1.4) * 3.14159 + lobes * 4.0);
  float inner = smoothstep(1.0, 0.55, u) * rip * 0.18;
  float haze = (1.0 - smoothstep(1.0, 2.1, u)) * 0.16 * smoothstep(0.7, 1.1, u);
  float edgeFade = smoothstep(0.0, 0.08, u);
  float a = clamp((rim * 0.85 + inner + haze) * edgeFade * u_energy * u_fade, 0.0, 1.0);
  vec3 col = mix(vec3(0.30, 0.62, 1.0), vec3(0.85, 0.95, 1.0), rim);
  col = mix(col, vec3(1.0, 0.85, 0.55), haze * 0.6);
  outColor = vec4(col * a * 1.25, a);
}`;

/* ------------------------------------------------------------------ frost */

/**
 * Dendrite crystals creeping inward from the frame borders toward u_center. `u_grow` (0..1) is
 * smoothstepped into the *reach* of every needle, so raising it visibly extends the frost; each
 * needle also grows two levels of side branches at fixed angles. A fine-noise frosted veil fills
 * between the needles so the growth reads as ice, not a wireframe.
 */
export const FROST = `${PRELUDE}
uniform vec2 u_center;
uniform float u_grow;
uniform float u_energy;
uniform float u_fade;

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
  return length(p - (a + ab * h));
}

// 1 = nothing, 0 = a cell border: F2 - F1 is small only next to the nearest edge.
float iceCell(vec2 q) {
  vec2 ip = floor(q), fp = fract(q);
  float F1 = 8.0, F2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      float d = length(g + hash21(ip + g + u_seed.zy) - fp);
      if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) { F2 = d; }
    }
  }
  return smoothstep(0.0, 0.16, F2 - F1);
}

// A tip stops growing once it reaches the grow front: concentric rings plus the cell walls.
float front(vec2 p, vec2 root, float reach) {
  float r = length(p - root);
  float ring = smoothstep(0.0, 0.06, abs(r - reach));
  return ring * mix(0.55, 1.0, iceCell(p * 13.0 + u_seed.zx));
}

float needle(vec2 p, vec2 root, vec2 tip, float grow) {
  float d = sdSeg(p, root, tip);
  float w = 0.0105 + 0.0055 * u_energy;
  float core = smoothstep(w, 0.0, d);
  float glow = smoothstep(w * 3.0, 0.0, d) * 0.55;
  float acc = core * 1.3 + glow;
  vec2 dir = normalize(root - tip + 1e-5);
  for (int l = 1; l <= 2; l++) {
    float fl = float(l);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float hh = hash11(fl * 3.0 + fk * 1.7 + floor(hash11(root.x * 31.0) * 50.0));
      float along = mix(0.25, 0.85, fract(hh * 3.1));
      vec2 bp = mix(root, tip, along);
      float ang = (0.55 + 0.35 * hh) * (k == 1 ? 1.0 : -1.0);
      vec2 bd = vec2(dir.x * cos(ang) - dir.y * sin(ang), dir.x * sin(ang) + dir.y * cos(ang));
      vec2 bt = bp + bd * (0.05 + 0.09 * fract(hh * 7.7)) * grow;
      float db = sdSeg(p, bp, bt);
      acc += smoothstep(w * 1.6, 0.0, db) * 0.8;
    }
  }
  return acc;
}

void main() {
  vec2 p = field();
  vec2 c = u_center;
  float reach = 0.06 + smoothstep(0.0, 1.0, u_grow) * 0.92;
  float acc = 0.0;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    float t = (fi + 0.5) / 14.0;
    float s = hash11(fi * 1.9 + u_seed.y * 13.0);
    // The roots ring the centre at one field unit, so every side of the frame has needles and
    // they creep inward; a root pinned to y = -0.15 grew off-frame upward and left the front curl
    // above the picture.
    vec2 root = c + vec2(cos(t * 6.2831 + hash11(fi * 8.7)), sin(t * 6.2831 + hash11(fi * 8.7))) * 0.98;
    vec2 tdir = normalize(c - root + vec2((s - 0.5) * 0.5, 0.0));
    vec2 tip = root + tdir * reach * (0.55 + (hash11(fi * 5.3 + u_seed.x) - 0.5) * 0.7);
    acc += needle(p, root, tip, reach);
    vec2 root2 = c + vec2(cos(t * 6.2831 + hash11(fi * 2.3) + 3.14), sin(t * 6.2831 + hash11(fi * 2.3) + 3.14)) * 1.06;
    vec2 tdir2 = normalize(c - root2 + vec2((s - 0.5) * 0.6, 0.0));
    vec2 tip2 = root2 + tdir2 * reach * (0.5 + hash11(fi * 3.1) * 0.6);
    acc += needle(p, root2, tip2, reach) * 0.8;
  }
  float veil = smoothstep(0.34, 0.85, fbm(p * 9.0 + u_seed.xy + u_time * 0.05, 4)) * 0.34;
  float a = clamp(acc * 0.85 + veil, 0.0, 1.0) * front(p, u_center, reach) * u_energy * u_fade;
  vec3 col = mix(vec3(0.45, 0.72, 1.0), vec3(0.94, 0.98, 1.0), clamp(acc * 0.5, 0.0, 1.0));
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ portal */

/**
 * A torn energy ring: a ragged bright rim (noise-displaced radius), a swirl of streaks inside it,
 * and an outer ring whose radius breathes at its own slower rate. Violet on the rim, cyan in the
 * swirl.
 */
export const PORTAL = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;
void main() {
  vec2 p = field() - u_center;
  float r = length(p) + 1e-5;
  float ang = atan(p.y, p.x);
  float R = u_radius;
  float tear = fbm3(vec3(cos(ang) * 2.0, sin(ang) * 2.0, u_time * 0.6), 3) - 0.5;
  float rimR = R * (1.0 + tear * 0.10);
  // rim: narrow band around the torn radius, further tightened by energy
  float rim = exp(-pow((r - rimR) * (28.0 + 10.0 * u_energy), 2.0));
  // inner swirl: angled streaks, faded toward the centre
  float sw = sin(ang * 7.0 - u_time * 3.2 + r * 22.0 + tear * 6.0);
  float swirl = smoothstep(0.55, 1.0, sw) * smoothstep(rimR, rimR * 0.25, r) * 0.35;
  // lagging outer ring
  float lag = R * (1.32 + 0.03 * sin(u_time * 0.9));
  float outer = exp(-pow((r - lag - tear * 0.03) * 40.0, 2.0)) * 0.4;
  float a = clamp((rim * 0.9 + swirl + outer) * u_energy * u_fade, 0.0, 1.0);
  vec3 col = mix(vec3(0.55, 0.20, 1.0), vec3(0.95, 0.85, 1.0), rim);
  col = mix(col, vec3(0.25, 0.85, 1.0), swirl * 0.8);
  outColor = vec4(col * a * (1.0 + 0.5 * u_energy), a);
}`;

/* ------------------------------------------------------------------ disco */

/**
 * Mirror-ball light: a fan of sharp facet quads sweeping around u_center, each on its own orbit,
 * rotation and hue cycle, plus a few short-lived sparkle glints. The hues are desaturated so the
 * result is moving coloured light, not a rainbow wash, and every facet covers a small area.
 */
export const DISCO = `${PRELUDE}
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;

vec3 hsv(float h) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), k, 0.72);   // desaturated: reads as light, not neon paint
}

// Orbit parameters of facet fi, shared by the shade and the clearance test.
vec2 orbit(float fi, float spin) {
  float ang = hash11(fi * 2.1 + u_seed.x) * 6.2831 + spin + sin(u_time * 0.7 + fi) * 0.5;
  float rad = 0.35 + hash11(fi * 5.7 + u_seed.z) * 0.95;
  return u_center + vec2(cos(ang), sin(ang) * 0.72) * rad;
}

float facet(vec2 p, float fi, float spin, out float hue) {
  vec2 c = orbit(fi, spin);
  float rot = hash11(fi * 2.1 + u_seed.x) * 6.2831 * 1.7 + u_time * 0.3;
  vec2 q = p - c;
  q = vec2(q.x * cos(rot) - q.y * sin(rot), q.x * sin(rot) + q.y * cos(rot));
  // Size is a field-space radius (x is aspect-scaled in field()), so a facet covers the same
  // fraction of the frame on any aspect and every pixel in it is a real area, not a hairline.
  float sz = 0.060 + hash11(fi * 9.3) * 0.050;
  hue = fract(hash11(fi * 1.37 + u_seed.y) + u_time * 0.09 * (hash11(fi) * 2.0 - 1.0));
  return smoothstep(sz, sz * 0.55, length(q * vec2(1.0, 1.9)));
}

// A facet steps aside (dims) when a later facet's orbit lands on top of it: light, not a wash.
float clearance(vec2 p, float fi, float spin) {
  float clear = 1.0;
  for (int j = 0; j < 9; j++) {
    float fj = float(j);
    if (fj <= fi) continue;
    clear = min(clear, smoothstep(0.02, 0.12, length(p - orbit(fj, spin * 1.11 + 1.3))));
  }
  return mix(0.35, 1.0, clear);
}

void main() {
  vec2 p = field();
  vec3 acc = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < 9; i++) {
    float hue;
    float f = facet(p, float(i), u_time * 0.55, hue) * clearance(p, float(i), u_time * 0.55);
    acc += hsv(hue) * f;
    a += f * 0.75;
  }
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float life = fract(u_time * (0.5 + hash11(fi * 4.1) * 0.9) + hash11(fi * 7.7));
    vec2 gp = u_center + (hash21(vec2(fi, u_seed.x)) - 0.5) * vec2(1.5, 1.0);
    float g = smoothstep(0.007, 0.0, length(p - gp)) * pow(1.0 - life, 2.0);
    float hue;
    facet(p, fi + 0.5, 1.7, hue);
    acc += hsv(hue) * g * 2.0;
    a += g;
  }
  acc = acc / (1.0 + acc * 0.5);
  // Coverage is the union of the facets (max), not their sum: overlapping light must not turn a
  // few small facets into a full-frame wash, and a facet's own edge must stay its own edge.
  a = clamp(a, 0.0, 1.0) * (0.6 + 0.4 * u_energy) * u_fade;
  outColor = vec4(acc * u_fade * (0.7 + 0.5 * u_energy), a);
}`;

/* ------------------------------------------------------------------ slime */

/**
 * Viscous goo hanging from u_center: a rounded body with a bright rim and a specular highlight,
 * three sagging drips that stretch and detach on a per-drip cycle, and thin strings that pull from
 * the body down to each falling drip.
 */
export const SLIME = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;

float capsule(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
  return length(p - (a + ab * h));
}

void main() {
  vec2 p = field();
  vec2 c = u_center;
  vec2 d = p - c;
  float R = u_radius;
  float ang = atan(d.y, d.x);
  float wob = fbm3(vec3(cos(ang) * 1.5, sin(ang) * 1.5, u_time * 0.3), 2) - 0.5;
  float body = 1.0 - smoothstep(R * (0.9 + wob * 0.25), R * (1.02 + wob * 0.25), length(d));
  // wet volume: rim and highlight bright, interior darker (premultiplied, so alpha is per-part)
  float rim = smoothstep(R * 0.62, R * 1.0, length(d)) * body;
  vec3 col = vec3(0.10, 0.42, 0.14) * body + vec3(0.30, 0.90, 0.38) * rim;
  float spec = smoothstep(R * 0.26, 0.0, length(d - vec2(-R * 0.32, R * 0.36)));
  col += vec3(0.85, 1.0, 0.9) * spec * 1.6;
  float a = body * 0.55 + rim * 0.4 + spec * 0.8;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float s = hash11(fi * 3.7 + u_seed.y * 7.0);
    float ph = fract(u_time * (0.16 + s * 0.1) + s);
    float x = (s - 0.5) * R * 1.2;
    vec2 top = c + vec2(x, -R * 0.6);
    vec2 bot = top - vec2(x * 0.3, R * (0.5 + ph * 1.6));
    float rad = mix(0.030, 0.010, ph);
    float drip = smoothstep(rad, rad * 0.35, capsule(p, top, bot)) * (1.0 - smoothstep(0.75, 1.0, ph));
    float strand = smoothstep(0.006, 0.0, capsule(p, top, mix(top, bot, ph))) * 0.5;
    float sheen = smoothstep(rad * 0.9, 0.0, length(p - bot + vec2(-rad * 0.3, rad * 0.3))) * 0.7;
    col += vec3(0.18, 0.72, 0.28) * drip + vec3(0.75, 1.0, 0.85) * sheen;
    a += drip * 0.8 + strand * 0.5 + sheen * 0.6;
  }
  a = clamp(a, 0.0, 1.0) * (0.65 + 0.35 * u_energy) * u_fade;
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ inkflow */

/**
 * Curl-noise advected dye. `u_prev` is this effect's previous frame: it is sampled at v_uv displaced
 * backwards along a curl field computed from fbm, then decayed and clamped, so the trace stays
 * bounded over any number of frames. Fresh dye is injected in a soft noisy disc at u_center;
 * `u_fade` sets trail level, `u_energy` the flow speed and dye strength.
 */
export const INKFLOW = `${PRELUDE}
uniform sampler2D u_prev;
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;

// curl of a scalar potential: divergence-free, so the dye swirls without piling up
vec2 curl(vec2 p) {
  float e = 0.01;
  float a = fbm(p + vec2(0.0, e), 3) - fbm(p - vec2(0.0, e), 3);
  float b = fbm(p + vec2(e, 0.0), 3) - fbm(p - vec2(e, 0.0), 3);
  return vec2(a, -b) / (2.0 * e);
}
void main() {
  vec2 uv = v_uv;
  vec2 p = field();
  vec2 v = curl(p * 2.2 + u_seed.xy + vec2(0.0, u_time * 0.15));
  // one frame of advection: a small backward step, so the dye smears rather than teleports
  vec2 flow = v * 0.0014 * (0.5 + u_energy);
  vec4 prev = texture(u_prev, clamp(uv - flow, vec2(0.001), vec2(0.999)));
  vec3 dye = clamp(prev.rgb, 0.0, 1.0) * 0.965;     // bounded, then decayed by u_fade below
  float pa = clamp(prev.a, 0.0, 1.0) * 0.965;
  float inj = (1.0 - smoothstep(0.0, 0.22, length(p - u_center)))
            * (0.6 + 0.4 * vnoise(p * 8.0 + u_time * 0.4));
  vec3 ink = mix(vec3(0.10, 0.65, 0.95), vec3(0.85, 0.35, 0.95),
                 0.5 + 0.5 * sin(u_time * 0.5 + u_center.x));
  dye = clamp(dye + ink * inj * 0.35, 0.0, 1.0);
  pa = clamp(pa + inj * 0.3, 0.0, 1.0);
  float edge = smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x)
             * smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.94, uv.y);
  float a = clamp(pa * edge * u_fade, 0.0, 1.0);
  outColor = vec4(dye * a, a);
}`;

/* ------------------------------------------------------------------ shatter */

/**
 * Voronoi shards: each cell takes a flat facet shade from its id, thin bright borders separate
 * the cells (F2 - F1 is small at an edge), and twelve wedge cracks radiate out of u_center. The
 * facet interiors stay translucent so the layer lights the scene instead of painting over it.
 */
export const SHATTER = `${PRELUDE}
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;
void main() {
  vec2 p = field();
  vec2 q = p * 9.0 + u_seed.xy * 0.7;
  vec2 ip = floor(q), fp = fract(q);
  float F1 = 8.0, F2 = 8.0;
  vec2 bestId = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      float d = length(g + hash21(ip + g + floor(u_seed.zx * 3.0)) - fp);
      if (d < F1) { F2 = F1; F1 = d; bestId = ip + g; } else if (d < F2) { F2 = d; }
    }
  }
  // thin bright borders: F2 - F1 is small near a cell edge
  float border = smoothstep(0.0, 0.055 + 0.03 * u_energy, F2 - F1);
  float id = hash11(dot(bestId, vec2(1.0, 57.0)));
  vec3 col = mix(vec3(0.35, 0.55, 0.75), vec3(0.85, 0.95, 1.0), 0.25 + 0.75 * id);
  float facetLight = 0.10 + 0.18 * id * (0.7 + 0.3 * sin(u_time * 0.8 + id * 9.0));
  // radial cracks out from the centre: divide the circle into twelve wedges
  vec2 d = p - u_center;
  float r = length(d);
  float ang = atan(d.y, d.x) / 6.2831 * 12.0;
  float crackLine = abs(fract(ang + 0.5) - 0.5);
  float crack = smoothstep(0.10, 0.0, crackLine) * smoothstep(0.0, 0.10, r)
              * (1.0 - smoothstep(0.30, 1.10, r));
  // A burst confined to the impact. The old interior alpha (roughly 0.6-1.0 on every facet) was
  // also multiplied by smoothstep(0.02, 0.18, F1), which killed coverage at the seeds and left
  // near-white mush across the frame; the disc is the honest bound on where the shards are.
  float disc = 1.0 - smoothstep(0.28, 0.62, length(p - u_center));
  float a = clamp(facetLight + (1.0 - border) * 0.85 + crack * 1.1, 0.0, 1.0) * u_fade;
  a *= disc;
  col = mix(col * 0.45, col, border);
  col = mix(col, vec3(1.0), crack * 0.8);
  outColor = vec4(col * a, a);
}`;
/* ------------------------------------------------------------------ body fire */

/**
 * Fire inside a body silhouette: `u_body` is the body mask (0..1 alpha, v_uv space) and drives
 * coverage, so the flames are clipped by the body instead of drawn over the frame. Two fbm layers
 * stream upward inside the mask, a hot core sits at u_center, the silhouette edge carries a bright
 * rim, and sparks ride the edge. Outside the mask only a thin heat haze survives.
 */
export const BODYFIRE = `${PRELUDE}
uniform sampler2D u_body;
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;
// u_time comes from PRELUDE; the body effects only add the mask below.

void main() {
  vec2 uv = v_uv;
  float m = texture(u_body, uv).a;
  float px = 2.0 / max(u_res.y, 1.0);
  // silhouette rim: the mask minus a shifted-and-shrunk copy is nonzero only near the boundary
  float mUp = texture(u_body, uv + vec2(0.0, px * 2.0)).a;
  float mOut = texture(u_body, uv + vec2(px * 2.0, 0.0)).a;
  float rim = clamp((m - min(mUp, mOut)) * 3.0, 0.0, 1.0);
  float inside = smoothstep(0.30, 0.55, m);
  vec2 p = field();
  // flames: noise advected upward, sampled in uv so they follow the body, not the aspect
  float n1 = fbm(vec2(uv.x * 14.0, uv.y * 5.0 - u_time * 1.5) + u_seed.xy, 4);
  float n2 = fbm(vec2(uv.x * 26.0 + u_time * 0.2, uv.y * 11.0 - u_time * 2.6) + u_seed.yz, 3);
  float flame = smoothstep(0.42, 0.85, n1 * 0.65 + n2 * 0.45);
  // height falloff: hotter low in the body, flames licking up and dying out
  float up = smoothstep(1.05, 0.25, uv.y) * (0.45 + 0.55 * u_energy);
  float core = 1.0 - smoothstep(0.0, 0.42, length(p - u_center));
  float heat = flame * up * inside;
  // sparks riding the silhouette edge
  float sp = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float life = fract(u_time * (0.35 + hash11(fi * 2.3) * 0.5) + hash11(fi * 7.1));
    vec2 s = vec2(hash11(fi * 5.9), hash11(fi * 3.3) + life * 0.35);
    float d = length((uv - s) * vec2(u_aspect, 1.0));
    sp += smoothstep(0.012, 0.0, d) * (1.0 - life) * rim;
  }
  // outside the mask: only a thin, faint heat shimmer
  float haze = (1.0 - inside) * max(vnoise(uv * 40.0 + u_time * 2.0) - 0.62, 0.0) * 0.18;
  vec3 col = mix(vec3(0.55, 0.06, 0.02), vec3(1.0, 0.42, 0.06), heat);
  col = mix(col, vec3(1.0, 0.92, 0.65), core * inside);
  col += vec3(1.0, 0.72, 0.30) * rim * 0.9 * inside;
  col += vec3(1.0, 0.55, 0.18) * sp;
  float a = clamp(heat * 0.95 + rim * 0.7 * inside + sp + core * inside * 0.35 + haze, 0.0, 1.0);
  a *= u_fade;
  outColor = vec4(col * a * (0.8 + 0.4 * u_energy), a);
}`;

/* ------------------------------------------------------------------ body smoke */

/**
 * Curled smoke lifted off a body silhouette. The mask gradient gives the outward edge normal, so
 * the plumes start at the boundary and curl away from it; two fbm fields counter-scroll for the
 * curl. Above the anchor the plume forms a cone that widens upward (narrow at the waist, spreading
 * with height), so the smoke reads as rising off the body rather than as a line on its outline.
 * Dark and thin: alpha stays low, the colour is near-grey, and the layer is meant for the
 * source-over composite.
 */
export const BODYSMOKE = `${PRELUDE}
uniform sampler2D u_body;
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;

void main() {
  vec2 uv = v_uv;
  float px = 2.0 / max(u_res.y, 1.0);
  float m = texture(u_body, uv).a;
  vec2 g = vec2(texture(u_body, uv + vec2(px * 2.0, 0.0)).a - texture(u_body, uv - vec2(px * 2.0, 0.0)).a,
                texture(u_body, uv + vec2(0.0, px * 2.0)).a - texture(u_body, uv - vec2(0.0, px * 2.0)).a);
  vec2 nrm = g / max(length(g), 1e-4);          // outward edge direction
  // A cone that widens above the anchor: a thin ring on the silhouette itself (the mask's own
  // half-coverage crossing) plus a column of plume that rises out of it and drifts sideways, so a
  // hand-centred shot has smoke over the anchor rather than on a 1-px boundary line. liftAmt
  // is how far above the centre a pixel sits; the plume is advected upward by it, fades out with
  // height and never appears below the anchor.
  float edge = 1.0 - smoothstep(0.0, 0.03, abs(m - 0.5));
  float rise = uv.y - u_center.y;
  float liftAmt = clamp(rise, 0.0, 1.0);
  float qx = uv.x * 9.0 + nrm.x * 0.25;
  float qy = (uv.y - liftAmt * 0.22) * 5.0;
  vec2 q = vec2(qx, qy) + nrm * 0.6;
  float c1 = fbm(q + vec2(-u_time * 0.18, -u_time * 0.55) + u_seed.xz, 4);
  float c2 = fbm(q * 2.1 + vec2(u_time * 0.11, -u_time * 0.3) + u_seed.zy, 3);
  float plume = smoothstep(0.42, 0.78, c1 * 0.7 + c2 * 0.4);
  float spread = 0.16;
  float above = 1.0 - smoothstep(0.02, 0.55, liftAmt);
  // A ring alone is a 1-px line, so the cone has a cross-section that widens with height; the
  // density then thins as the column rises instead of ending flat at the top.
  float cone = smoothstep(spread * (1.0 + liftAmt * 2.2), 0.0, abs(uv.x - u_center.x));
  float aBand = max(edge, cone * smoothstep(0.0, 0.10, liftAmt));
  // Smoke is dark by intent, but "dark" is not "invisible": on a black scene a plume at 0.1 alpha
  // is a shadow of a shadow. The floor keeps the cone band (the body of the plume, where the plume
  // is at least partly open) at a readable 0.30, so the effect cannot flicker out on the frame
  // where the noise happens to be between its two thresholds; the noise still shapes all the detail
  // above that floor.
  float smokeAlpha = aBand * plume * above;
  float a = clamp(smokeAlpha * 8.0 * (0.55 + 0.45 * u_energy), 0.0, 1.0);
  float body = max(smokeAlpha, smoothstep(0.25, 0.55, plume) * aBand * above);
  a = max(a, body * 0.30 * (0.55 + 0.45 * u_energy) * u_fade);
  vec3 col = mix(vec3(0.06, 0.06, 0.07), vec3(0.30, 0.29, 0.32), c2);
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ electowave */

/* ------------------------------------------------------------------ ember rise */

/**
 * Self-contained embers rising from an anchor. The first version of this effect was a *trail*
 * program meant to be fed its own previous frame through a buffer-scroll feedback loop, which this
 * renderer does not have (bufferScroll was cut): fed a single frame it emitted a one-frame grain
 * that measured ~0.1 % coverage. This one is a stateless emission: 64 sparks each walking a
 * deterministic life cycle up from the anchor, with a hot head, a cooling colour and a fade, so a
 * single frame already reads as a column of embers. Its offsets are page units converted to
 * field space (x times the aspect); the spark radius is a field-space radius on both axes.
 */
export const EMBERS2 = `${PRELUDE}
uniform vec2 u_center;
uniform float u_spread;
uniform float u_energy;
uniform float u_fade;

// fbm taken along a point's own trajectory so each spark's path wanders, not the whole field.
float emberField(vec2 p) {
  float acc = 0.0;
  for (int i = 0; i < 64; i++) {
    float fi = float(i);
    float speed = 0.22 + hash11(fi * 1.7 + u_seed.x) * 0.26;
    float life = fract(u_time * speed + hash11(fi * 9.1 + u_seed.y));
    float rise = life * (0.22 + 0.18 * hash11(fi * 4.3 + u_seed.z));
    float wander = (vnoise(vec2(fi * 5.0, life * 3.0 + u_seed.x)) - 0.5) * u_spread * 0.9 * life;
    // Offsets are in page (uv) units and multiplied by the aspect where they become field x, so
    // the column's width is the same fraction of the frame on any aspect. The spark radius is a
    // field-space radius on both axes (no aspect on d.x): field() already scales p.x, so scaling
    // it again here made every spark an ellipse and halved its width.
    float x = ((hash11(fi * 3.3) - 0.5) * u_spread * 0.55 + wander) * u_aspect;
    vec2 c = u_center + vec2(x, rise);
    vec2 d = p - c;
    float size = mix(0.030, 0.008, life) * (0.6 + hash11(fi) * 1.0);
    float spark = smoothstep(size, 0.0, length(d));
    float twinkle = 0.55 + 0.45 * sin(u_time * (5.0 + hash11(fi) * 9.0) + fi * 2.1);
    acc += spark * (1.0 - life * life) * twinkle;
  }
  return acc;
}

void main() {
  vec2 p = field();
  float e = emberField(p);
  // A soft halo at a smaller size so each spark has a glow, not just a hard dot.
  float a = clamp(e * 1.6 * u_energy * u_fade, 0.0, 1.0);
  vec3 col = mix(vec3(1.0, 0.36, 0.06), vec3(1.0, 0.9, 0.6), clamp(a * 1.6, 0.0, 1.0));
  outColor = vec4(col * a, a);
}`;

/**
 * Shockwave that displaces what the overlay already knows: `u_src` is a snapshot of the accumulated
 * overlay in v_uv space. Inside and outside the wavefront the source is sampled along the radial
 * direction, so the ring appears to shove the image outward; r/g/b sample at slightly different
 * wave radii for a fringe, and a ring of filament noise rides the front. Output is premultiplied,
 * so the page adds this on top of the untouched scene.
 */
export const ELECTOWAVE = `${PRELUDE}
uniform sampler2D u_src;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;

void main() {
  vec2 uv = v_uv;
  vec2 d = vec2((uv.x - u_center.x) * u_aspect, uv.y - u_center.y);
  float r = length(d) + 1e-5;
  vec2 dir = d / r;
  float front = u_radius;
  float band = exp(-pow((r - front) / (0.06 + 0.03 * u_energy), 2.0));
  float push = band * (0.05 + 0.05 * u_energy);
  vec2 base = uv - vec2(dir.x / u_aspect, dir.y) * push;
  vec2 ca = vec2(dir.x / u_aspect, dir.y);
  float off = push * 0.55;
  float rr = texture(u_src, clamp(base + ca * off, 0.0, 1.0)).r;
  float gg = texture(u_src, clamp(base, 0.0, 1.0)).g;
  float bb = texture(u_src, clamp(base - ca * off, 0.0, 1.0)).b;
  vec3 disp = vec3(rr, gg, bb);
  // crackle filaments on the front: 1-D noise in the angle, gated to the band
  float cracken = vnoise(vec2(atan(d.y, d.x) * 9.0, u_time * 3.0)) * vnoise(vec2(r * 40.0, u_time * 1.7));
  float crack = band * smoothstep(0.55, 0.95, cracken) * 1.4;
  float ring = band * 0.9;
  vec3 col = disp + vec3(0.35, 0.75, 1.0) * (ring + crack);
  float a = clamp(dot(disp, vec3(0.33)) + ring * 0.8 + crack, 0.0, 1.0);
  a *= u_fade;
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ frozen body */

/**
 * An icy encasement over a silhouette: `u_body` gives coverage, the interior is a lattice of
 * angular ice facets (two-layer voronoi for the shard edges), frost creeps in from the silhouette
 * boundary, and bright inclusion cracks fan out of u_center. Cold palette, specular glints.
 */
export const FROZENBODY = `${PRELUDE}
uniform sampler2D u_body;
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;

// cell walls at this scale: 1 = wall, 0 = facet interior
float iceWalls(vec2 q) {
  vec2 ip = floor(q), fp = fract(q);
  float F1 = 8.0, F2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      float d = length(g + hash21(ip + g + u_seed.xy) - fp);
      if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) { F2 = d; }
    }
  }
  return 1.0 - smoothstep(0.0, 0.10, F2 - F1);
}

void main() {
  vec2 uv = v_uv;
  vec2 p = field();
  float m = texture(u_body, uv).a;
  float px = 2.0 / max(u_res.y, 1.0);
  float mIn = texture(u_body, uv - vec2(px * 3.0, 0.0)).a
            * texture(u_body, uv - vec2(0.0, px * 3.0)).a;
  float depth = clamp(m - mIn, 0.0, 1.0);           // 0 deep inside, 1 on the boundary
  float frost = smoothstep(0.02, 0.35, depth) * (0.5 + 0.5 * u_energy);
  float walls = iceWalls(uv * vec2(26.0, 22.0));
  float shade = hash11(dot(floor(uv * vec2(26.0, 22.0) + u_seed.zx), vec2(1.0, 71.0)));
  // inclusion cracks: angular spokes that break at the cell walls
  float ang = atan(p.y - u_center.y, (p.x - u_center.x) * 1.0);
  float spoke = abs(fract(ang * 4.0 / 6.2831 + 0.5) - 0.5);
  float crack = smoothstep(0.035, 0.0, spoke);
  float inside = smoothstep(0.30, 0.55, m);
  vec3 col = mix(vec3(0.35, 0.60, 0.90), vec3(0.85, 0.95, 1.0), 0.35 + 0.5 * shade);
  col = mix(col, vec3(0.95, 0.99, 1.0), walls * 0.8);
  col = mix(col, vec3(1.0), crack * 0.7);
  float glint = pow(max(0.0, sin(shade * 31.0 + u_time * 1.3)), 22.0) * (1.0 - walls);
  col += vec3(0.8, 0.95, 1.0) * glint;
  float a = clamp((0.18 + 0.22 * shade + frost * 0.5 + walls * 0.35 + crack * 0.8 + glint) * inside, 0.0, 1.0);
  a *= u_fade;
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ cyber */

/**
 * Glitch overlay, banded around u_center: horizontal displacement slices (whose rows come from a
 * hash of the time block, so they jump rather than drift), a scanline grid, per-channel RGB split
 * and blocky corruption blocks. Everything is multiplied by a radial intensity band so the frame
 * outside the hand is left alone.
 */
export const CYBER = `${PRELUDE}
uniform vec2 u_center;
uniform float u_energy;
uniform float u_fade;

void main() {
  vec2 uv = v_uv;
  vec2 p = field();
  float band = exp(-pow(length(p - u_center) / (0.55 + 0.25 * u_energy), 2.0));
  float tick = floor(u_time * 9.0);
  float rows = 48.0;
  float row = floor(uv.y * rows);
  float jump = (hash11(row * 1.7 + tick * 13.0) - 0.5) * 0.08 * (hash11(tick) > 0.55 ? 1.0 : 0.15);
  float onSlice = step(0.75, hash11(row + tick * 3.1));
  vec2 block = floor(uv * vec2(24.0, 14.0) + tick * 0.37);
  vec2 bl = fract(uv * vec2(24.0, 14.0) + tick * 0.37);
  // a corruption block is a hash-chosen cell with a hashed inside: a few blocks, not a new frame
  float cellHit = step(0.90, hash11(block.x * 3.3 + block.y * 7.7 + tick));
  float corrupt = cellHit * step(0.45, hash11(bl.x * 11.0 + bl.y * 5.0 + tick * 1.7));
  // RGB split: the three channels land at the slice offsets' three thirds of the bar
  float split = abs(jump) * 3.0 * onSlice;
  vec3 col = vec3(0.10 + split * 6.0, 0.85, 1.0);
  col = mix(col, vec3(0.45, 1.0, 0.85), step(0.5, hash11(row + tick)));
  col += vec3(0.9, 0.12, 0.45) * step(0.5, fract(uv.y * 90.0 + u_time * 2.0)) * 0.5;
  col = mix(col, vec3(0.95, 0.99, 1.0), corrupt);
  // scanline structure: thin dark rows over the light bars
  float scan = step(0.5, fract(uv.y * 180.0)) * 0.7 + 0.3;
  float a = (onSlice * 0.32 + corrupt * 0.45) * band * scan * (0.6 + 0.4 * u_energy);
  a = clamp(a, 0.0, 1.0) * u_fade;
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ bloom life */

/**
 * Flowers and vines around u_center: two spiralling stems drawn as thin noisy curves, round
 * blossoms along them whose petal rings open with u_time (petal count varies per flower), and a
 * few pollen specks drifting on a slow noise field. Everything scales with u_radius.
 */
export const BLOOMLIFE = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;

// One blossom: a round centre plus a petal ring whose radius is modulated by the petal count.
// One blossom. Anchor radius ~0.07 field units (field y runs 0..1 over the frame height); the
// petals are a ring that breathes inward as the flower opens, so a blossom covers a real patch of
// frame instead of a few pixels. (The first version used r ≈ 0.12 * open with open < 1 and the
// whole bloom measured ~1 % of the frame: five pinpricks.)
vec3 blossom(vec2 p, vec2 c, float r, float open, float seed) {
  vec2 d = p - c;
  float ang = atan(d.y, d.x);
  float petals = 5.0 + floor(hash11(seed) * 3.0);
  float wav = 0.55 + 0.45 * cos(ang * petals + seed * 6.0);
  float rr = max(r * (0.55 + 0.45 * open), 0.004);
  float shape = smoothstep(rr * (0.55 + 0.45 * wav), rr * 0.15, length(d));
  float core = smoothstep(rr * 0.32, 0.0, length(d));
  vec3 col = mix(vec3(0.95, 0.35, 0.55), vec3(1.0, 0.85, 0.35), core * 0.9);
  return col * shape;
}

void main() {
  vec2 p = field();
  vec3 col = vec3(0.0);
  float acc = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ang = hash11(fi * 3.1 + u_seed.x) * 6.2831 + u_time * 0.15;
    float growth = fract(u_time * 0.16 + hash11(fi * 7.3));
    float rad = u_radius * (0.35 + growth * 1.15);
    vec2 c = u_center + vec2(cos(ang), sin(ang) * 0.8) * rad;
    // stem: distance to the centre->flower line, wobbled along its length (the spiral)
    vec2 sdir = c - u_center;
    float sl = max(length(sdir), 1e-4);
    float along = clamp(dot(p - u_center, sdir) / (sl * sl), 0.0, 1.0);
    float off = length(p - u_center - sdir * along) + sin(hash11(fi) * 9.0 + along * 9.0) * 0.012 * sl;
    float stem = smoothstep(0.006, 0.0, abs(off)) * step(along, 0.985);
    col += vec3(0.22, 0.70, 0.36) * stem;
    acc += stem * 0.6;
    // opening cycle: per-flower phase, slow, so blossoms breathe rather than flash
    float open = 0.35 + 0.65 * fract(u_time * 0.18 + hash11(fi * 2.9));
    vec3 b = blossom(p, c, 0.10 + 0.05 * hash11(fi * 5.9), open, fi * 1.7 + 1.0);
    col += b;
    acc += dot(b, vec3(0.33));
  }
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    vec2 q = u_center + (hash21(vec2(fi, u_seed.y)) - 0.5) * vec2(u_radius * 5.0, u_radius * 2.6);
    q += vec2(sin(u_time * 0.4 + fi), cos(u_time * 0.33 + fi * 2.0)) * 0.05;
    float glint = smoothstep(0.006, 0.0, length(p - q)) * (0.5 + 0.5 * sin(u_time * 3.0 + fi));
    col += vec3(1.0, 0.95, 0.6) * glint;
    acc += glint;
  }
  float a = clamp(acc * (0.6 + 0.4 * u_energy), 0.0, 1.0) * u_fade;
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ meteor */

/**
 * One meteor: a hot head at u_from + u_dir * u_arc (u_arc 0..1 along its path), an ablating tail
 * whose length breathes, a smoke spine behind it, sparks shed off the trail and a thin lens streak
 * across the head. All positions are field space.
 */
export const METEOR = `${PRELUDE}
uniform vec2 u_from;
uniform vec2 u_dir;
uniform float u_arc;
uniform float u_energy;
uniform float u_fade;

void main() {
  vec2 p = field();
  vec2 D = normalize(u_dir + 1e-5);
  vec2 N = vec2(-D.y, D.x);
  vec2 head = u_from + D * (u_arc * 2.2);
  float along = dot(p - head, -D);        // >0 behind the head
  float side = abs(dot(p - head, N));
  float reach = 0.35 + 0.25 * u_energy;
  float tailW = mix(0.003, 0.10, clamp(along / reach, 0.0, 1.0));
  float flick = 0.65 + 0.35 * vnoise(vec2(along * 30.0, u_time * 12.0));
  float tail = smoothstep(tailW * (0.6 + 0.8 * flick), 0.0, side) * smoothstep(reach, 0.0, along);
  float core = smoothstep(0.055, 0.0, length(p - head) * (0.8 + 0.2 * flick));
  float halo = smoothstep(0.22, 0.0, length(p - head)) * 0.35;
  // smoke spine: a slow drift of noise behind the head, wider than the fire tail
  float spine = smoothstep(0.11, 0.02, side + (vnoise(vec2(along * 8.0, u_time * 2.0)) - 0.5) * 0.05)
              * smoothstep(reach * 1.6, 0.0, along) * 0.25;
  // sparks: shed and left behind the head
  float sp = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float life = fract(u_time * (0.4 + hash11(fi * 3.7) * 0.6) + hash11(fi * 5.1));
    vec2 s = head - D * (life * 0.55) + N * (hash11(fi * 9.3) - 0.5) * 0.12 * life;
    sp += smoothstep(0.008, 0.0, length(p - s)) * (1.0 - life);
  }
  vec3 col = mix(vec3(0.9, 0.20, 0.05), vec3(1.0, 1.0, 0.95), core);
  col = mix(col, vec3(1.0, 0.80, 0.45), tail * 0.7);
  col = mix(col, vec3(0.35, 0.30, 0.28), spine * 0.7);   // smoke darkens, never washes
  float a = clamp(core * 1.2 + tail * 0.8 + halo + sp * 1.2, 0.0, 1.0);
  float lens = smoothstep(0.004, 0.0, side) * smoothstep(0.5, 0.0, abs(along)) * 0.2;
  col += vec3(1.0, 0.85, 0.6) * lens;
  a = clamp(a + lens + spine * 0.25, 0.0, 1.0) * u_fade;
  outColor = vec4(col * a, a);
}`;

/* ------------------------------------------------------------------ heart */

/**
 * A cute glossy heart projectile at u_center. SDF heart (the classic implicit form), pink body with
 * a soft radial shade, a specular blob top-left, a small shine sparkle that rotates slowly, and a
 * gentle pulse so a stationary projectile still breathes. Pre-multiplied, additive light.
 */
export const HEART = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;

// Inigo Quilez's heart: <0 inside
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot(p - vec2(0.25, 0.75), p - vec2(0.25, 0.75))) - 0.3535;
  return sqrt(min(dot(p - vec2(0.0, 1.0), p - vec2(0.0, 1.0)),
                  dot(p - 0.5 * max(p.x + p.y, 0.0), p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}

void main() {
  vec2 p = field();
  float pulse = 1.0 + 0.06 * sin(u_time * 3.2);
  float R = u_radius * pulse;
  vec2 q = (p - u_center) / max(R, 1e-4);
  q.y = -q.y;                       // SDF heart points up
  float d = sdHeart(q * 1.15);
  float body = smoothstep(0.02, -0.02, d);
  float rim = smoothstep(0.0, -0.08, d) * (1.0 - smoothstep(-0.06, -0.16, d));
  // gloss: bright up-left inside the body, dark toward the bottom-right
  vec2 g = q - vec2(-0.28, 0.30);
  float spec = smoothstep(0.26, 0.0, length(g)) * body;
  float shade = clamp(0.65 + q.y * 0.5 - q.x * 0.25, 0.0, 1.0);
  vec3 col = mix(vec3(1.0, 0.20, 0.42), vec3(1.0, 0.62, 0.78), shade);
  col = mix(col, vec3(1.0, 0.92, 0.96), spec * 0.9);
  col = mix(col, vec3(1.0, 0.85, 0.92), rim * 0.6);
  // shine sparkle: a small four-point star on the body, slowly rotating
  float sa = u_time * 0.7;
  vec2 sp2 = (p - u_center) / max(R, 1e-4) - vec2(0.30, -0.34);
  sp2 = vec2(sp2.x * cos(sa) - sp2.y * sin(sa), sp2.x * sin(sa) + sp2.y * cos(sa));
  float star = smoothstep(0.045, 0.0, length(sp2)) * 0.6;
  star += smoothstep(0.030, 0.0, min(abs(sp2.x), abs(sp2.y))) * (1.0 - smoothstep(0.0, 0.12, length(sp2))) * 0.5;
  float sparkle = star * body;
  col += vec3(1.0) * sparkle;
  float glow = (1.0 - smoothstep(0.0, 1.4, length(q))) * 0.18 * body;
  float a = clamp(body * 0.9 + rim * 0.4 + spec * 0.5 + sparkle, 0.0, 1.0) * u_fade;
  a *= (0.8 + 0.2 * u_energy);
  outColor = vec4(col * a * 1.1 + glow * vec3(1.0, 0.4, 0.6) * u_fade, a + glow * u_fade);
}`;

/* ------------------------------------------------------------------ projectile */

/**
 * Default projectile skin: a hot glowing orb at u_center/u_radius with a motion trail stretched
 * back along u_dir (a capsule of decreasing width, brightness and noise), a bright core and a soft
 * halo. Colours run white core -> amber -> orange.
 */
export const PROJECTILE = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform vec2 u_dir;
uniform float u_energy;
uniform float u_fade;

void main() {
  vec2 p = field();
  vec2 D = normalize(u_dir + vec2(1e-5, 0.0));
  float R = max(u_radius, 1e-4);
  vec2 rel = p - u_center;
  float r = length(rel);
  float behind = dot(rel, -D);
  float side = abs(dot(rel, vec2(-D.y, D.x)));
  // trail: a tapering capsule behind the orb, with noise so it breaks up
  float len = R * (3.0 + 3.0 * u_energy);
  float tw = R * mix(0.75, 0.08, clamp(behind / max(len, 1e-4), 0.0, 1.0));
  float trail = smoothstep(tw * (0.5 + 0.6 * vnoise(vec2(behind * 40.0, u_time * 8.0))), 0.0, side)
              * smoothstep(len, 0.0, behind) * step(0.0, behind);
  float core = smoothstep(R * 0.85, R * 0.25, r);
  float shell = smoothstep(R * 1.25, R * 0.7, r);
  float halo = exp(-pow(r / (R * 3.2), 2.0)) * 0.5;
  vec3 col = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.72, 0.25), shell);
  col = mix(col, vec3(1.0, 0.98, 0.90), core);
  col = mix(col, vec3(1.0, 0.55, 0.12), trail * 0.8);
  float a = clamp(core * 1.3 + shell * 0.7 + halo + trail * 0.9, 0.0, 1.0);
  a *= u_fade * (0.75 + 0.25 * u_energy);
  outColor = vec4(col * a * 1.2, a);
}`;

/* ------------------------------------------------------------------ echo */

/** What the hand/frame edit draws onto: the overlay is the page's own stroke canvas. Echo is the
 *  inkflow program applied to that canvas — the same advected dye, but the dye is whatever the
 *  operator painted, so the strokes bleed and trail instead of an invented colour field. */
export const ECHO = INKFLOW;
