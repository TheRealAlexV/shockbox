// GLSL for the handfx overlay. Every program is GLSL ES 3.00 (`#version 300 es`): WebGL2 only,
// no extensions. Fragments are drawn on a full-resolution opaque layer and added/mixed later, so
// an effect only ever has to paint light and alpha.

export const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Shared GLSL: hashing, value noise, fbm, and a cheap 3-D curl-free swirl noise. */
export const NOISE = `
uniform vec3 u_seed;      // per-effect offset so two effects never share a noise field
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
  return mix(mix(hash21(i).x, hash21(i + vec2(1, 0)).x, u.x),
             mix(hash21(i + vec2(0, 1)).x, hash21(i + vec2(1, 1)).x, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash31(i), b = hash31(i + vec3(1,0,0)), c = hash31(i + vec3(0,1,0)), d = hash31(i + vec3(1,1,0));
  float e = hash31(i + vec3(0,0,1)), g = hash31(i + vec3(1,0,1)), h = hash31(i + vec3(0,1,1)), k = hash31(i + vec3(1,1,1));
  return mix(mix(mix(a,b,u.x), mix(c,d,u.x), u.y), mix(mix(e,g,u.x), mix(h,k,u.x), u.y), u.z);
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
`;

/** Shared prelude for every effect: coordinate space in normalised field units, aspect-corrected. */
export const PRELUDE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_res;      // canvas size in pixels
uniform float u_time;    // seconds
uniform float u_aspect;  // width / height
${NOISE}
vec2 field() {           // 0..1 uv, x scaled by aspect so circles stay round
  return vec2(v_uv.x * u_aspect, v_uv.y);
}
vec2 mirrorUV(vec2 uv) { // a mirrored view, for placing hands and particles in page space
  return uv;
}
`;

/* ------------------------------------------------------------------ fireball */

/**
 * A ball of fire: a hot core that wobbles, a boiling shell of two fbm layers streamed upward, and
 * a soft halo. `u_energy` is the effect intensity (0..~2); `u_fade` 0..1 covers spawning/dying.
 */
export const FIREBALL = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;
void main() {
  vec2 p = vec2((v_uv.x - u_center.x) * u_aspect, v_uv.y - u_center.y);
  p.x *= u_aspect;
  float r = length(p);
  float R = u_radius;
  vec2 n = normalize(p + 1e-5);
  // boiling shell: radial noise driven upward, so the ball reads as fire, not a ball
  float wob = fbm3(vec3(n * 2.4 + u_seed.xy, u_time * 1.6), 4) - 0.5;
  // The ball's size is set by the palm, but never so large that a hand at the frame edge pushes
  // it off-screen: the cap is the operator's intensity, the floor is legibility.
  float shellR = R * (1.0 + wob * 0.35);
  float shell = 1.0 - smoothstep(shellR * 0.55, shellR * 1.18, r);
  float flow = fbm(vec2(atan(p.y, p.x) * 1.2, r / R * 2.2 - u_time * 3.4) + u_seed.xz, 5);
  float core = 1.0 - smoothstep(0.0, R * 0.42, r);
  float halo = 1.0 - smoothstep(R * 0.8, R * 2.6, r);
  vec3 hot = vec3(1.0, 0.94, 0.78);
  vec3 mid = vec3(1.0, 0.55, 0.12);
  vec3 edge = vec3(0.62, 0.09, 0.02);
  vec3 col = mix(edge, mid, smoothstep(0.0, 0.55, shell * (0.55 + flow * 0.9)));
  col = mix(col, hot, core);
  float a = clamp(shell * (0.55 + flow * 0.8) + halo * 0.22 * (0.5 + flow), 0.0, 1.0);
  a *= u_fade;
  float sparkle = pow(max(wob + 0.35, 0.0), 3.0) * smoothstep(shellR * 0.5, shellR * 1.0, r);
  col += vec3(1.0, 0.85, 0.5) * sparkle * 1.4 * u_energy;
  outColor = vec4(col * (0.75 + 0.45 * u_energy) * a, a);
}`;

/* ------------------------------------------------------------------ lightning */

/**
 * N bolts between fingertip pairs: signed-distance to a polyline, brightened by a fbm core, plus
 * a halo. Up to 4 bolts fit one draw (vec4 uniforms), which matches two hands' index and middle
 * fingertips.
 */
export const LIGHTNING = `${PRELUDE}
uniform vec4 u_a[4];       // bolt start, xy in field space
uniform vec4 u_b[4];       // bolt end
uniform vec4 u_meta[4];    // x = radius, y = energy, z = seed, w = alive
uniform int u_count;

float sdSeg(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 ab = b - a;
  t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
  return length(p - (a + ab * t));
}

// A jagged path: the straight line pushed sideways by noise, recomputed per fragment (cheap, and
// stable in time because the noise is a function of position, not of frame).
float bolt(vec2 p, vec2 a, vec2 b, float seed, float energy) {
  float t;
  float d = sdSeg(p, a, b, t);
  vec2 dir = normalize(b - a + 1e-5);
  vec2 nrm = vec2(-dir.y, dir.x);
  float along = dot(p - a, dir);
  float jag = (vnoise(vec2(along * 26.0 + seed * 7.0, u_time * 3.0)) - 0.5) * 0.035 * (0.4 + energy);
  jag += (vnoise3(vec3(along * 70.0, u_time * 9.0, seed)) - 0.5) * 0.012 * energy;
  float d2 = abs(dot(p - a, nrm) - jag);
  float core = smoothstep(0.006 + 0.004 * energy, 0.0, d2);
  float glow = smoothstep(0.06 + 0.05 * energy, 0.0, d2);
  float flick = 0.65 + 0.35 * vnoise(vec2(u_time * 22.0, seed * 3.0));
  return core * 1.6 + glow * 0.55 * flick;
}

void main() {
  vec2 p = field();
  vec3 acc = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= u_count) break;
    if (u_meta[i].w < 0.01) continue;
    float f = bolt(p, u_a[i].xy, u_b[i].xy, u_meta[i].z, u_meta[i].y);
    vec3 col = mix(vec3(0.55, 0.75, 1.0), vec3(0.9, 0.96, 1.0), f);
    acc += col * f * u_meta[i].y * u_meta[i].w;
    a += f * u_meta[i].w;
  }
  acc = acc / (1.0 + acc * 0.35); // soft roll-off so crossing bolts do not clip to white
  outColor = vec4(acc, clamp(a, 0.0, 1.0));
}`;

/* ------------------------------------------------------------------ spark ring */

/**
 * A ring of sparks around a palm held towards the camera: particles orbit on a noisy ellipse and
 * streak outwards, over a faint charged ring.
 */
export const SPARKRING = `${PRELUDE}
uniform vec2 u_center;
uniform float u_radius;
uniform float u_energy;
uniform float u_fade;

float sparks(vec2 p, float R, float spin, float seed) {
  float acc = 0.0;
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    float ang = fi * 0.349 + spin + hash11(fi + seed) * 0.9;
    float rr = R * (0.75 + hash11(fi * 3.1 + seed) * 0.6) + sin(u_time * 2.0 + fi) * R * 0.08;
    vec2 c = vec2(cos(ang), sin(ang)) * rr;
    float life = fract(u_time * 0.9 + hash11(fi * 7.7 + seed));
    float size = mix(0.006, 0.0015, life);
    float d = length(p - c - vec2(cos(ang), sin(ang)) * life * R * 0.9);
    acc += smoothstep(size, 0.0, d) * (1.0 - life);
  }
  return acc;
}

void main() {
  vec2 p = (v_uv - u_center);
  p.x *= u_aspect;
  float r = length(p);
  float spin = u_time * 1.6;
  float S = sparks(p, u_radius, spin, u_seed.x * 31.0);
  float S2 = sparks(p * 1.35 + vec2(0.3, -0.2), u_radius, -spin * 0.7, u_seed.y * 17.0);
  float ring = smoothstep(0.012, 0.0, abs(r - u_radius * (1.0 + sin(u_time * 3.0) * 0.01))) * 0.35;
  float glow = (1.0 - smoothstep(u_radius * 0.9, u_radius * 1.6, r)) * 0.18;
  vec3 col = mix(vec3(1.0, 0.72, 0.25), vec3(1.0, 0.95, 0.8), S);
  float a = clamp((S + S2 * 0.8 + ring + glow) * u_energy * u_fade, 0.0, 1.0);
  outColor = vec4(col * a * 1.6, a);
}`;

/* ------------------------------------------------------------------ embers */

/**
 * Rising embers: point-like particles spawned below the hand that drift up with noise, cool from
 * white-hot to red, and die out. Density follows the effect intensity so a low intensity is
 * sparse, not dim.
 */
export const EMBERS = `${PRELUDE}
uniform vec2 u_center;
uniform float u_spread;
uniform float u_energy;
uniform float u_fade;

float embers(vec2 p) {
  float acc = 0.0;
  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    float life = fract(u_time * (0.18 + hash11(fi * 1.7) * 0.18) + hash11(fi * 9.1));
    float y = mix(0.04, 0.95, life);
    float x = (hash11(fi * 3.3) - 0.5) * u_spread * (0.6 + life * 0.9);
    x += (vnoise(vec2(fi * 5.0, u_time * 0.6 + life * 3.0)) - 0.5) * u_spread * 0.5;
    vec2 c = u_center + vec2(x, -y * 0.5 + 0.25);
    vec2 d = p - c;
    d.x *= u_aspect;
    float size = mix(0.012, 0.003, life) * (0.6 + hash11(fi) * 0.8);
    float spark = smoothstep(size, 0.0, length(d));
    float twinkle = 0.55 + 0.45 * sin(u_time * (6.0 + hash11(fi) * 8.0) + fi);
    acc += spark * (1.0 - life) * twinkle;
  }
  return acc;
}

void main() {
  vec2 p = v_uv;
  float E = embers(p);
  float E2 = embers(p + vec2(0.08, 0.03)) * 0.4;
  float a = clamp((E + E2) * u_energy * u_fade, 0.0, 1.0);
  vec3 col = mix(vec3(1.0, 0.36, 0.06), vec3(1.0, 0.9, 0.6), clamp(a * 1.5, 0.0, 1.0));
  outColor = vec4(col * a * 1.2, a);
}`;

/* ------------------------------------------------------------------ smoke */

/**
 * A smoke veil rising where the hand swiped: two fbm layers with different speeds, shaped by a
 * soft vertical band so it reads as a curtain of smoke rather than a fog over the whole frame.
 */
export const SMOKE = `${PRELUDE}
uniform vec2 u_center;
uniform float u_width;
uniform float u_energy;
uniform float u_fade;

void main() {
  vec2 p = field();
  float band = 1.0 - smoothstep(u_width * 0.4, u_width * 1.4, abs(p.x - u_center.x));
  float up = (p.y - u_center.y) * 0.5;
  float n1 = fbm(vec2(p.x * 3.2, p.y * 2.0 + u_time * 0.22) + u_seed.xy, 4);
  float n2 = fbm(vec2(p.x * 7.0 + u_time * 0.1, p.y * 5.0 + u_time * 0.42) + u_seed.yz, 3);
  float density = smoothstep(0.42, 0.78, n1 * 0.7 + n2 * 0.4) * band * (1.0 - smoothstep(0.15, 0.9, up));
  float a = density * u_energy * u_fade;
  vec3 col = mix(vec3(0.55, 0.58, 0.66), vec3(0.82, 0.85, 0.92), density);
  outColor = vec4(col, a * 0.75);
}`;

/* ------------------------------------------------------------------ composite */

/** One full-screen pass per effect into the accumulation buffer: each layer is added to the light
 *  already there, weighted by its own alpha. Two programs: add (glow) and over (smoke/veil). */
export const COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_scene;
uniform sampler2D u_layer;
uniform float u_weight;
uniform int u_mode;    // 0 = add light, 1 = source-over
// Sampling a texture through two different sampler uniforms in one draw is INVALID_OPERATION
// when both point at the same texture object (the page binds the scene to both units; the camera
// blit binds only unit 0). One binding, one sampler: the mode decides which texture is read.
uniform int u_layerOnly; // 1 = read u_layer as the source (camera blit), 0 = read u_scene
void main() {
  vec4 l = u_layerOnly == 1 ? texture(u_layer, v_uv) : texture(u_scene, v_uv);
  if (u_layerOnly == 1) {
    outColor = l;
    return;
  }
  vec4 s = l;
  if (u_mode == 0) {
    outColor = vec4(s.rgb + l.rgb * l.a * u_weight, min(1.0, s.a + l.a * u_weight));
  } else {
    float a = l.a * u_weight;
    outColor = vec4(s.rgb * (1.0 - a) + l.rgb * a, min(1.0, s.a + a));
  }
}`;

/** Straight copy (bilinear when the target is smaller): the bloom downsample and the camera blit. */
export const BLIT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

/** Tonemap + grade the accumulated light, then a subtle bloom built from the 4× downscaled pass. */
export const FINAL = `${PRELUDE}
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_exposure;
uniform float u_bloomAmount;
void main() {
  vec4 s = texture(u_scene, v_uv);
  vec3 c = s.rgb * u_exposure;
  // filmic-ish knee: keeps the fire core white without clipping the smoke grey to white
  c = c / (1.0 + c * 0.6);
  vec3 b = texture(u_bloom, v_uv).rgb;
  c += b * u_bloomAmount;
  float a = clamp(s.a + dot(b, vec3(0.33)) * u_bloomAmount, 0.0, 1.0);
  outColor = vec4(c, a);
}`;
