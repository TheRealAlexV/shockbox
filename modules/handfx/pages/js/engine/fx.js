// The effect renderer: WebGL2, layered passes, one draw per effect.
//
// Layers, back to front (every layer is a full-size RGBA texture):
//   0  scene     — camera (debug overlay mode) or transparent; everything accumulates here
//   1  layer     — one effect's own fragment program, drawn into this, composited onto scene
//   2  bloom     — a 4× downsample of scene, blurred, added by the final pass
//   3  debug     — camera + landmarks drawn with 2-D canvas primitives (only in debug mode)
//
// An effect is a plain object with `program` (its GLSL), `mode` (0 add light, 1 source-over) and a
// `layer` ('hands' | 'body' | 'spectacle'): effects are drawn grouped by layer in that order, and
// inside a layer the operator's `settings.effects` order is kept. The renderer fills each effect's
// uniforms itself (see `_drawEffect`) — there is no per-effect `setFrame` callback to keep in sync.
// Effects are listed in one registry so the server can name them (ids only) and the page can
// order/toggle them. The renderer knows nothing about hands: main.js reduces a frame to
// per-effect anchors (palms, fingertip pairs, a palm towards the camera, a swipe) and hand
// landmarks, and hands them over in `view`.
//
// Texture units — one map, because the samplers are bound by number and a unit that still points
// at the previous pass's texture is how a black camera picture happens:
//   0  camera / generic blit source            (_blit, _blitCamera, camera)
//   1  layer / composite source                (_composite, _blitCamera)
//   2  body mask      (u_body, body effects)   TEXTURE_UNIT_BODY
//   3  history (ping-pong) (u_prev, inkflow)   TEXTURE_UNIT_HISTORY
//   4  scene snapshot (u_src, electroshock)    TEXTURE_UNIT_SNAP
//   5  particles source (u_body/u_prev/u_src   TEXTURE_UNIT_NEUTRAL, nil)
// The final pass uses 0 (scene) and 1 (bloom).

import { VERT, FIREBALL, LIGHTNING, SPARKRING, SMOKE, COMPOSITE, FINAL, BLIT } from './fx-glsl.js';
import {
  EMBERS2,
  WIRES,
  AURA,
  FROST,
  PORTAL,
  DISCO,
  SLIME,
  INKFLOW,
  SHATTER,
  ECHO,
  BODYFIRE,
  BODYSMOKE,
  ELECTOWAVE,
  FROZENBODY,
  CYBER,
  BLOOMLIFE,
  METEOR,
  HEART,
  PROJECTILE,
} from './fx-glsl2.js';
import { palmCentre, handScale } from './tracker.js';

const EFFECT_ORDER = ['fireball', 'lightning', 'sparkring', 'embers', 'smoke'];

/** Layer draw order. Effects are drawn grouped by layer in this order, never interleaved. */
const LAYER_ORDER = ['hands', 'body', 'spectacle'];

/**
 * The twenty-one MediaPipe landmarks as one shape: one hand's 2-D points plus its scale and
 * handedness. `view.hands` carries these (already mirrored, page space) and every effect that needs
 * a skeleton or a per-hand blob reads them from here — nothing invents a position when there is no
 * hand: `view.hands` is simply empty.
 */
export const GESTURE_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 9], [0, 13], [0, 17],
];

const TEXTURE_UNIT_BODY = 2;
const TEXTURE_UNIT_HISTORY = 3;
const TEXTURE_UNIT_SNAP = 4;
const TEXTURE_UNIT_NEUTRAL = 5;

/** Per-upload EMA weight for the body mask (see setBodyMask). */
const BODY_EMA = 0.35;

/** Additive composite weight for an effect layer (1 = the layer's own brightness). */
const ADD_WEIGHT = 0.55;
/** The dye effects are a full-frame field, so they land lighter than a glow. */
const ADD_WEIGHT_DYE = 0.35;

/**
 * Add-mode composite weight for a layer. The layer shaders write premultiplied colour, so an
 * additive composite adds `rgb * weight`: at 1.0 a handful of overlapping effects clip to white
 * and the frame reads as a milky veil. The dye effects are a full-frame field and land lighter.
 */
const layerWeight = (id) => (id === 'inkflow' || id === 'echo' ? ADD_WEIGHT_DYE : ADD_WEIGHT);

/** How long a history-needing effect may be absent before its ping-pong targets are cleared. */
const HISTORY_IDLE_FRAMES = 30;

export const EFFECTS = {
  fireball: {
    id: 'fireball',
    title: 'Fireball',
    gesture: 'palmUp',
    mode: 0,
    layer: 'hands',
    program: FIREBALL,
  },
  lightning: {
    id: 'lightning',
    title: 'Lightning fingers',
    gesture: 'bothFingertips',
    mode: 0,
    layer: 'hands',
    program: LIGHTNING,
  },
  sparkring: {
    id: 'sparkring',
    title: 'Spark ring',
    gesture: 'palmFront',
    mode: 0,
    layer: 'hands',
    program: SPARKRING,
  },
  embers: {
    id: 'embers',
    title: 'Ember rise',
    gesture: 'any',
    mode: 0,
    layer: 'hands',
    program: EMBERS2,
  },
  smoke: {
    id: 'smoke',
    title: 'Smoke veil',
    gesture: 'swipe',
    mode: 1,
    layer: 'hands',
    program: SMOKE,
  },
  aura: {
    id: 'aura',
    title: 'Aura outline',
    gesture: 'any',
    mode: 0,
    layer: 'hands',
    program: AURA,
  },
  wires: {
    id: 'wires',
    title: 'Wire skeleton',
    gesture: 'any',
    mode: 0,
    layer: 'hands',
    program: WIRES,
  },
  frost: {
    id: 'frost',
    title: 'Frost creep',
    gesture: 'palmFront',
    mode: 0,
    layer: 'hands',
    program: FROST,
  },
  portal: {
    id: 'portal',
    title: 'Portal ring',
    gesture: 'openPalmFront',
    mode: 0,
    layer: 'hands',
    program: PORTAL,
  },
  disco: {
    id: 'disco',
    title: 'Disco ball',
    gesture: 'bothRaised',
    mode: 0,
    layer: 'hands',
    program: DISCO,
  },
  slime: {
    id: 'slime',
    title: 'Slime drip',
    gesture: 'palmTouch',
    mode: 1,
    layer: 'hands',
    program: SLIME,
  },
  inkflow: {
    id: 'inkflow',
    title: 'Ink flow',
    gesture: 'swipe',
    mode: 1,
    layer: 'hands',
    program: INKFLOW,
  },
  shatter: {
    id: 'shatter',
    title: 'Shatter shards',
    gesture: 'fist',
    mode: 0,
    layer: 'hands',
    program: SHATTER,
  },
  cyber: {
    id: 'cyber',
    title: 'Cyber glitch',
    gesture: 'fist',
    mode: 0,
    layer: 'hands',
    program: CYBER,
  },
  bloomlife: {
    id: 'bloomlife',
    title: 'Bloom life',
    gesture: 'bothPalmsUp',
    mode: 0,
    layer: 'hands',
    program: BLOOMLIFE,
  },
  echo: {
    id: 'echo',
    title: 'Echo trails',
    gesture: 'any',
    mode: 1,
    layer: 'hands',
    program: ECHO,
  },
  bodyonfire: {
    id: 'bodyonfire',
    title: 'Body on fire',
    gesture: 'bodyAny',
    mode: 0,
    layer: 'body',
    program: BODYFIRE,
  },
  bodysmoke: {
    id: 'bodysmoke',
    title: 'Body smoke',
    gesture: 'bodyAny',
    mode: 1,
    layer: 'body',
    program: BODYSMOKE,
  },
  frozenbody: {
    id: 'frozenbody',
    title: 'Frozen body',
    gesture: 'bodyAny',
    mode: 0,
    layer: 'body',
    program: FROZENBODY,
  },
  edit: {
    id: 'edit',
    title: 'Hand edit',
    gesture: 'fist',
    mode: 0,
    layer: 'spectacle',
    program: null, // the pointer's own strokes, drawn straight onto the scene
  },
  electroshock: {
    id: 'electroshock',
    title: 'Electro shockwave',
    gesture: 'palmFront',
    mode: 0,
    layer: 'spectacle',
    program: ELECTOWAVE,
  },
  meteor: {
    id: 'meteor',
    title: 'Meteor',
    gesture: 'bothRaised',
    mode: 0,
    layer: 'spectacle',
    program: METEOR,
  },
  shoot: {
    id: 'shoot',
    title: 'Shoot',
    gesture: 'point',
    mode: 0,
    layer: 'spectacle',
    program: null, // drawn as particles with the PROJECTILE / HEART program
  },
};

/** Effects whose fragment program samples the previous frame (history ping-pong). */
const HISTORY_EFFECTS = new Set(['inkflow', 'echo']);
/** Effects that sample a snapshot of the accumulated scene (taken once per frame, only when one of
 *  these is live, and only after the layer it belongs to has been composited). */
const SNAPSHOT_EFFECTS = new Set(['electroshock', 'echo']);
/** Effects that read the body mask; they do not draw at all until a mask has been set. */
const BODY_EFFECTS = new Set(['bodyonfire', 'bodysmoke', 'frozenbody']);

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    gl.deleteShader(sh);
    throw new Error(`${label} shader failed to compile: ${log}`);
  }
  return sh;
}

function program(gl, frag, label) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, `${label} vertex`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag, label);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${label} program failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function texture(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function texFbo(gl, w, h) {
  const tex = texture(gl, w, h);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fbo };
}

function clearPair(gl, pair) {
  if (!pair) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, pair.fbo);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/**
 * One effect's live state. `age` counts up while the gesture is held, `fade` ramps in/out so an
 * effect never pops, and `gone` retires it after the fade so nothing keeps drawing.
 */
class Live {
  constructor(id, intensity, centre) {
    this.id = id;
    this.intensity = intensity;
    this.active = true;
    this.t0 = performance.now();
    this.age = 0;
    this.centre = centre || { x: 0.5, y: 0.5 };
    this.radius = 0.06;
    this.fade = 0;
    this.energy = 0;
    this.extra = {};
    /** Layer this effect belongs to ('hands' | 'body' | 'spectacle'): effects are drawn grouped by
     *  layer, so one layer's pass (ink history, body mask) can be shared by its effects. */
    this.layer = 'hands';
    /** Bumped whenever this effect starts drawing again, so a layer's history starts clean
     *  instead of advecting whatever the previous spawn left behind. */
    this.epoch = (Live.epoch = (Live.epoch || 0) + 1);
  }
}

/* ------------------------------------------------------------------ edit stroke */

/** Program for the hand-edit brush: the shared quad positioned at the pointer, soft-edged. */
function strokeProgram(gl) {
  const vs = compile(gl, gl.VERTEX_SHADER, EDIT_STROKE, 'edit-stroke vertex');
  const fs = compile(gl, gl.FRAGMENT_SHADER, EDIT_FRAG, 'edit-stroke');
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`edit-stroke program failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

const EDIT_STROKE = `#version 300 es
in vec2 a_pos;
uniform vec2 u_center;   // field space (uv.x * aspect, 1 - page y)
uniform float u_size;    // half the brush's field-space size
uniform float u_aspect;
out vec2 v_uv;
void main() {
  vec2 q = u_center + a_pos * u_size;
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(q.x / u_aspect * 2.0 - 1.0, q.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const EDIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec3 u_colour;
out vec4 outColor;
void main() {
  float d = length(v_uv - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.55, d);
  outColor = vec4(u_colour * a, a);
}`;

/* ------------------------------------------------------------------ particles */

const PARTICLES = 512;
const P_FIELDS = ['x', 'y', 'vx', 'vy', 'age', 'life', 'size', 'skin', 'mode'];
/** The 9:16 page has side walls: how much of a hit comes back, how much of the slide it keeps, and
 *  how long a particle is allowed to live on after touching one (an explosive particle spends
 *  itself on the wall instead of bouncing for the rest of its life). */
const FENCE_RESTITUTION = 0.35;
const FENCE_FRICTION = 0.9;
const FENCE_IMPACT_LIFE = 0.12;

/**
 * The ratio's stage, in canvas pixels. 9:16 is the centred portrait column inside the full-surface
 * page — width = height*9/16, x centred, y 0, full height — and 16:9 (or an unresolved `default`)
 * is the whole frame, so there is no wall to report. Pure: the fence is a formula, not a stored
 * rect, so a headless test can check it without a canvas and a ratio change re-derives it.
 */
export function fenceRectFor(ratio, width, height) {
  if (ratio !== '9:16' || !(width > 0) || !(height > 0)) return null;
  const w = (height * 9) / 16;
  return { x: (width - w) / 2, y: 0, w, h: height };
}

/**
 * One particle's motion step, the fence included. Pure over numbers so the boundary rule can be
 * tested without WebGL, and so every effect that spawns a particle inherits the same wall.
 *
 * `fence` is `{x0, x1}` in page-x (0..1 across the canvas); `null` is open flight. A record that
 * crosses an edge is placed on the wall and its x-velocity flipped and scaled by `restitution`,
 * with the slide damped by `friction` and the remaining life clipped to `impactLife` — a wall hit
 * is an ending, not a trampoline. `mode` 1 (an explosive burst) is instead consumed: the result is
 * `dead` and the caller detonates at the contact point. 16:9 passes straight through.
 */
export function stepParticle(p, dt, fence, {
  radiusToX = 0,
  restitution = FENCE_RESTITUTION,
  friction = FENCE_FRICTION,
  impactLife = FENCE_IMPACT_LIFE,
} = {}) {
  const next = { x: p.x + p.vx * dt, y: p.y + p.vy * dt, vx: p.vx, vy: p.vy, life: p.life, hit: null, dead: false };
  if (!fence) return next;
  // A drawn orb is `size` field units tall, which is size / (2 * aspect) in page-x, so the wall
  // inset is that radius: the picture touches the wall, not the particle's centre.
  const inset = Math.max(0, (p.size || 0) * radiusToX);
  const lo = fence.x0 + inset;
  const hi = fence.x1 - inset;
  if (lo > hi) return next; // a column narrower than the particle has no inside to be in
  if (next.x < lo || next.x > hi) {
    const side = next.x < lo ? lo : hi;
    const inward = next.x < lo ? 1 : -1; // normal of the wall it touched
    // Only a particle arriving from inside is an impact; a clamped one is just held against it.
    const impact = next.vx * inward < 0;
    next.x = side;
    next.hit = { x: side, y: next.y, impact };
    if (impact && p.mode === 1) {
      next.vx = 0;
      next.vy = 0;
      next.dead = true;
      return next;
    }
    next.vx = inward * Math.abs(next.vx) * restitution;
    next.vy *= friction;
    next.life = Math.min(next.life, p.age + impactLife);
  }
  return next;
}

/**
 * A tiny CPU particle store, flat `Float32Array` records so a headless test can count and a batched
 * draw can read one buffer. `skin` is 0 (projectile) or 1 (heart). Positions are page space and the
 * renderer converts them per draw, like every other anchor.
 */
class ParticleStore {
  constructor(capacity = PARTICLES) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * P_FIELDS.length);
    this.count = 0; // records in use; compacted when one dies
    this.cursor = 0;
  }
  /** Allocate one record; overwrites the oldest when full (a burst never stalls the frame). */
  alloc() {
    if (this.count < this.capacity) {
      const i = this.count++ * P_FIELDS.length;
      this.data.fill(0, i, i + P_FIELDS.length);
      return i;
    }
    const i = this.cursor * P_FIELDS.length;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.data.fill(0, i, i + P_FIELDS.length);
    return i;
  }
  /** Remove record `i` by moving the last record into its slot (order does not matter here). */
  kill(i) {
    const L = P_FIELDS.length;
    const last = (this.count - 1) * L;
    if (i !== last) this.data.copyWithin(i, last, last + L);
    this.count--;
  }
  clear() {
    this.count = 0;
    this.cursor = 0;
    this.data.fill(0);
  }
}

export class FxRenderer {
  constructor(canvas, { onError } = {}) {
    this.onError = onError || (() => {});
    this.canvas = canvas;
    this.gl = null;
    this.error = null;
    this.supported = false;
    this.live = new Map(); // id -> Live
    this.settings = { effects: EFFECT_ORDER.slice(), intensity: {}, bufferScroll: 0.35, mirror: true, debugOverlay: false, enabled: true, ratio: 'default' };
    this.time0 = performance.now();
    this.frame = 0;
    this.debugGl = false; // set true from the browser test to collect the first error per stage
    this.debugLog = [];
    this.particles = new ParticleStore(PARTICLES);
    this.bodyMaskSeen = false;
    this.historyAge = 0;
    this.historyEpoch = 0;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.error = 'WebGL2 is not available in this browser (the effects need WebGL2).';
      this.onError(this.error);
      return false;
    }
    this.gl = gl;
    try {
      this.progs = {
        composite: program(gl, COMPOSITE, 'composite'),
        final: program(gl, FINAL, 'final'),
        blit: program(gl, BLIT, 'blit'),
        effects: {},
      };
      for (const id of Object.keys(EFFECTS)) {
        if (!EFFECTS[id].program) continue;
        this.progs.effects[id] = program(gl, EFFECTS[id].program, id);
      }
      this.progs.skins = {
        projectile: program(gl, PROJECTILE, 'projectile'),
        heart: program(gl, HEART, 'heart'),
      };
      // The edit stroke needs its own program: the quad is positioned in the vertex shader (a_pos
      // is ±1, scaled by u_size and offset by u_center), so the brush lands where the pointer is.
      this._editProg = strokeProgram(gl);
    } catch (err) {
      this.error = err.message;
      this.onError(this.error);
      return false;
    }
    this._uniformCache = new WeakMap();
    // Unit quad: two triangles, -1..1. One VAO, drawn for every pass.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
    // One 1x1 black texture every sampler unit falls back to when its effect is skipped, and one
    // white 1x1 for the edit canvas's "add" command (white x alpha = paint).
    this.neutralTex = texture(gl, 1, 1);
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_NEUTRAL);
    gl.bindTexture(gl.TEXTURE_2D, this.neutralTex);
    this.whiteTex = texture(gl, 1, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.activeTexture(gl.TEXTURE0);
    // A lost context comes back with every object gone: rebuild rather than draw into nothing.
    this._onLost = (ev) => {
      ev.preventDefault();
      this.supported = false;
      this._lost = true;
      if (!this.error) {
        this.error = 'WebGL2 context lost';
        this.onError(this.error);
      }
    };
    this._onRestored = () => {
      this._lost = false;
      this.error = null;
      this.progs = null;
      this.w = 0;
      this.h = 0;
      this.history = null;
      this._historyEpoch = -1;
      if (this.init()) this.onError(null);
    };
    this.canvas.addEventListener('webglcontextlost', this._onLost);
    this.canvas.addEventListener('webglcontextrestored', this._onRestored);
    this.supported = true;
    this._resize();
    return true;
  }

  setSettings(s) {
    const next = {
      ...this.settings,
      ...s,
      effects: Array.isArray(s.effects) ? s.effects : this.settings.effects,
      intensity: Object.assign({}, this.settings.intensity, s.intensity || {}),
      // `skins` is optional everywhere (absent means the default projectile orb); when it is
      // given it replaces the map, so removing a key falls back to the default.
      ...(s.skins && typeof s.skins === 'object' ? { skins: { ...s.skins } } : {}),
    };
    // Effects removed from the list stop drawing at once (their fade-out is not worth keeping
    // when the operator has switched the effect off; the server calls that state the truth).
    for (const [id, live] of this.live) if (!next.effects.includes(id)) live.active = false;
    this.settings = next;
  }

  _resize() {
    const gl = this.gl;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of [this.sceneTex, this.layerTex, this.bloomTex, this.snapTex]) if (t) gl.deleteTexture(t);
    for (const f of [this.sceneFbo, this.layerFbo, this.bloomFbo, this.snapFbo]) if (f) gl.deleteFramebuffer(f);
    if (this.history) for (const p of this.history) if (p) {
      gl.deleteTexture(p.tex);
      gl.deleteFramebuffer(p.fbo);
    }
    const scene = texFbo(gl, w, h);
    const layer = texFbo(gl, w, h);
    const bloom = texFbo(gl, Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.sceneTex = scene.tex;
    this.sceneFbo = scene.fbo;
    this.layerTex = layer.tex;
    this.layerFbo = layer.fbo;
    this.bloomTex = bloom.tex;
    this.bloomFbo = bloom.fbo;
    // Spectacle snapshot: a copy of the scene before a spectacle effect is applied.
    const snap = texFbo(gl, w, h);
    this.snapTex = snap.tex;
    this.snapFbo = snap.fbo;
    this._snapTaken = false;
    // History ping-pong: full-res RGBA8, cleared on every (re)size and when the effect respawns.
    this.history = [texFbo(gl, w, h), texFbo(gl, w, h)];
    this.historyCur = 0;
    this.historyAge = 0;
    this.historyEpoch = 0;
    for (const p of this.history) clearPair(gl, p);
    clearPair(gl, snap);
    // The hand-edit canvas: full-res, wiped on resize; `edit.clear()` wipes it on demand.
    if (this.edit) {
      gl.deleteTexture(this.edit.tex);
      gl.deleteFramebuffer(this.edit.fbo);
    }
    this.edit = texFbo(gl, w, h);
    this.editPointer = null;
    clearPair(gl, this.edit);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Spawn (or refresh) an effect at a page-space anchor. */
  trigger(id, { centre, radius, dir, view } = {}) {
    if (!EFFECTS[id]) return false;
    if (!this.settings.effects.includes(id)) return false;
    const intensity = clamp(Number(this.settings.intensity[id] ?? 1), 0, 2);
    if (intensity <= 0.001) return false;
    // A body effect has nothing to draw without a mask; say so instead of drawing an empty pass.
    if (BODY_EFFECTS.has(id) && !this.bodyMaskSeen) return false;
    let live = this.live.get(id);
    if (!live) {
      live = new Live(id, intensity, centre);
      live.layer = EFFECTS[id].layer || 'hands';
      this.live.set(id, live);
    } else {
      live.active = true;
      live.intensity = intensity;
      live.epoch = (Live.epoch = (Live.epoch || 0) + 1);
      live.extra = {};
      if (centre) live.centre = centre;
    }
    if (radius) live.radius = radius;
    // The hand-edit canvas is a scratch picture: a new session starts on a clean canvas, because
    // the previous gesture's strokes belong to the previous effect, not this one.
    if (id === 'edit') this.editClear();
    // `shoot` and `meteor` throw particles from the anchor the gesture fired at, along the
    // direction the page saw. Both are read from the frame the page handed us at trigger time
    // (`opts.dir`, `opts.view`) rather than from `this.view`: the page triggers in its input
    // handler, before `render()` has stored the new view, so this.view there is one frame old and
    // the burst would leave from the previous hand position.
    if (id === 'shoot' || id === 'meteor') {
      const seen = view || this.view || {};
      const palm = (seen.palms && seen.palms[0]) || (seen.hands && seen.hands[0] && seen.hands[0].palm) || null;
      const from = centre || (seen.anchor && seen.anchor) || palm || live.centre;
      const burstDir = dir || (seen.swipe && seen.swipe.dir ? { x: seen.swipe.dir, y: -1 } : null);
      this.spawnBurst(id, from, burstDir, id === 'shoot' ? 24 : 16);
    }
    return true;
  }

  /** Stop an effect (fade out). */
  release(id) {
    const live = this.live.get(id);
    if (live) live.active = false;
  }

  releaseAll() {
    for (const live of this.live.values()) live.active = false;
  }

  /* ------------------------------------------------------------ body mask */

  /**
   * Give the renderer the body silhouette mask. Accepted sources: anything `texImage2D` takes (an
   * ImageBitmap, ImageData, canvas, OffscreenCanvas, video) uploaded as RGBA with its alpha as the
   * mask — or `{ width, height, data }` with a Uint8Array of one channel (w*h, an R8 mask) or four
   * (w*h*4, RGBA).
   *
   * The mask is smoothed with an exponential running average *on upload*, not in a blit pass: the
   * tracker hands it over once per camera frame at a fraction of the canvas size, so the few
   * hundred kilobytes of lerp in JS cost less than a full-resolution blend target that would have
   * to be cleared and re-read every frame — and an upload-time EMA has to happen exactly once per
   * sample, which is the rate a blit cannot see from here. `BODY_EMA = 0.35` keeps a flickering
   * silhouette from popping: `out = prev + (in - prev) * 0.35`.
   */
  setBodyMask(source) {
    return this._uploadBodyMask(source, true);
  }

  /** One upload. `smooth` runs the EMA; `false` seeds it (first mask, or a deliberate reset). */
  _uploadBodyMask(source, smooth) {
    const gl = this.gl;
    if (!gl || !source) return false;
    const w = Math.max(1, Math.round(source.width || source.displayWidth || 0));
    const h = Math.max(1, Math.round(source.height || source.displayHeight || 0));
    let px = null;
    if (ArrayBuffer.isView(source.data)) {
      const n = source.data.length;
      if (n === w * h) {
        px = new Uint8Array(w * h * 4);
        for (let i = 0, j = 0; i < n; i++, j += 4) px[j] = px[j + 1] = px[j + 2] = px[j + 3] = source.data[i];
      } else if (n === w * h * 4) {
        px = new Uint8Array(source.data.buffer || source.data, source.data.byteOffset || 0, n);
      }
    }
    // Canvas row 0 is the top of the picture; every shader here reads v_uv.y = 0 at the bottom.
    // Array sources have no upload flip (UNPACK_FLIP_Y only applies to DOM sources and is ignored
    // for ImageBitmap), so the flip is done once, right here, by walking rows.
    if (px) {
      const out = new Uint8Array(px.length);
      const row = w * 4;
      for (let y = 0; y < h; y++) out.set(px.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
      px = out;
    }
    if (px && smooth && this._bodyRaw && this._bodyRaw.length === px.length) {
      const a = BODY_EMA;
      const prev = this._bodyRaw;
      for (let i = 0; i < px.length; i++) px[i] = prev[i] + (px[i] - prev[i]) * a;
    }
    if (!px && smooth) {
      // A DOM source (canvas, ImageBitmap, video): read it back once so the EMA and the row flip
      // apply to it too. `texImage2D` alone would upload it unflipped and unsmoothed — which is
      // what left a canvas mask uniform under a shader that reads v_uv.y upward.
      try {
        const tmp = this._bodyRead || (this._bodyRead = document.createElement('canvas'));
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(source, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const a = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
        if (this._bodyRaw && this._bodyRaw.length === a.length) {
          for (let i = 0; i < a.length; i++) a[i] = this._bodyRaw[i] + (a[i] - this._bodyRaw[i]) * BODY_EMA;
        }
        const out = new Uint8Array(a.length);
        const row = w * 4;
        for (let y = 0; y < h; y++) out.set(a.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
        px = out;
      } catch (err) {
        px = null;
      }
    }
    if (px) this._bodyRaw = Uint8Array.from(px);
    if (!this.bodyTex) this.bodyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bodyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      if (px) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) {
      // A source the driver refuses (a dead video element, an empty bitmap): keep the old mask.
      return false;
    }
    this.bodyW = w;
    this.bodyH = h;
    this.bodyMaskSeen = true;
    return true;
  }

  /* ------------------------------------------------------------ particles */

  /**
   * `shoot` and `meteor` spawn from here. `kind` picks the skin and the spread, `anchor` is page
   * space, `dir` (optional) is the launch direction in page space, `count` the burst size. Kept
   * public and small so a headless test can spawn and count without a camera.
   */
  spawnBurst(kind, anchor, dir, count) {
    const n = Math.max(1, Math.min(128, count | 0));
    // No anchor is no burst: the renderer never invents a position (same rule as live.centre).
    if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return 0;
    const a = anchor;
    const d = dir && (Number.isFinite(dir.x) || Number.isFinite(dir.y)) ? Math.hypot(dir.x, dir.y) || 1 : 0;
    const launched = kind === 'meteor' || kind === 'shoot';
    for (let i = 0; i < n; i++) {
      const o = this.particles.alloc();
      const ang = Math.random() * Math.PI * 2;
      const speed = (kind === 'meteor' ? 0.55 : 0.35) * (0.4 + Math.random());
      let vx = Math.cos(ang) * speed;
      let vy = Math.sin(ang) * speed;
      if (launched) {
        // Down/up of page space: y grows downward, so an upward launch is negative vy.
        vx = (d ? dir.x / d : 0) * speed * 1.6;
        vy = (d ? dir.y / d : -1) * speed * 1.6;
      }
      const skin = kind === 'shoot' ? this._skinIndex('shoot') : 0;
      const data = this.particles.data;
      data[o + 0] = a.x;
      data[o + 1] = a.y;
      data[o + 2] = vx;
      data[o + 3] = vy;
      data[o + 4] = 0;
      data[o + 5] = launched ? 0.9 + Math.random() * 0.8 : 0.5 + Math.random() * 0.8;
      // field-space radius: page-space sizes scale with the shorter side, like every other anchor
      data[o + 6] = (skin === 1 ? 0.035 : 0.018) * (0.7 + Math.random() * 0.7);
      data[o + 7] = skin;
      // An explosive burst spends itself on the wall (see `stepParticle`); a projectile bounces.
      data[o + 8] = kind === 'meteor' ? 1 : 0;
    }
    return n;
  }

  /**
   * Which skin an effect wears. `settings.skins` is optional (id → 'heart' | 'projectile'); a
   * missing id, an absent settings object or an id this build does not draw all mean the default
   * projectile orb — the setting never invents a skin.
   */
  _skinIndex(id) {
    const skins = this.settings?.skins;
    const want = skins && typeof skins === 'object' ? skins[id] : null;
    return want === 'heart' ? 1 : 0;
  }

  /** Records currently live. Headless tests read this to prove the burst integrated. */
  particleCount() {
    return this.particles.count;
  }

  /**
   * The wall the resolved ratio puts in front of the particles, in canvas pixels; `null` in 16:9.
   * Derived on every call from the ratio and the live canvas size, never stored, so a ratio change
   * or a resize moves the fence on the next frame and a mount with `default` is ratio-agnostic.
   */
  fenceRect() {
    return fenceRectFor(this.settings.ratio, this.w || 0, this.h || 0);
  }

  /** Advance the particle store by `dt` seconds and retire what expired. */
  _integrateParticles(dt) {
    const data = this.particles.data;
    const L = P_FIELDS.length;
    // The fence is the ratio's stage, not the viewport's shape: in 9:16 the portrait column is
    // physical ground, so an effect thrown at its edge hits the wall and comes back rather than
    // sailing out of the picture, while tracking and classification still read the whole frame.
    // 16:9 (`fence` null) keeps the free-flight rule — off-frame records retire.
    const rect = this.fenceRect();
    const fence = rect ? { x0: rect.x / this.w, x1: (rect.x + rect.w) / this.w } : null;
    const aspect = this.h > 0 ? this.w / this.h : 1;
    const radiusToX = 1 / (2 * aspect);
    const impacts = fence ? [] : null;
    for (let r = this.particles.count - 1; r >= 0; r--) {
      const o = r * L;
      data[o + 4] += dt;
      if (data[o + 4] >= data[o + 5]) {
        this.particles.kill(o);
        continue;
      }
      const step = stepParticle(
        {
          x: data[o + 0], y: data[o + 1], vx: data[o + 2], vy: data[o + 3],
          age: data[o + 4], life: data[o + 5], size: data[o + 6], mode: data[o + 8],
        },
        dt,
        fence,
        { radiusToX },
      );
      data[o + 0] = step.x;
      data[o + 1] = step.y;
      data[o + 2] = step.vx;
      data[o + 3] = step.vy;
      data[o + 5] = step.life;
      // An explosive particle is consumed by the wall; a projectile was only reflected.
      if (step.dead) {
        this.particles.kill(o);
        if (step.hit && step.hit.impact && impacts.length < 6) impacts.push(step.hit.x, step.hit.y);
        continue;
      }
      if (step.hit && step.hit.impact && impacts.length < 6) impacts.push(step.hit.x, step.hit.y);
      // Off-frame particles are retired here, so the store cannot grow with invisible records and
      // a later draw cannot resurrect one.
      if (data[o + 0] < -0.15 || data[o + 0] > 1.15 || data[o + 1] < -0.15 || data[o + 1] > 1.15) {
        this.particles.kill(o);
        continue;
      }
      // Drag and a little buoyancy: a projectile's trail settles rather than flying off the frame.
      data[o + 2] *= 1 - Math.min(0.9, dt * 1.8);
      data[o + 3] = data[o + 3] * (1 - Math.min(0.9, dt * 1.8)) - dt * 0.05;
    }
    // Sparks go in after the walk, not during it: the store compacts in place and `alloc` on a full
    // store rewrites records the loop is still visiting. spawnBurst is the one emit path this file
    // has, so the impact reuses it rather than growing a second allocator.
    if (impacts) for (let i = 0; i < impacts.length; i += 2) this.spawnBurst('spark', { x: impacts[i], y: impacts[i + 1] }, null, 3);
  }

  /**
   * Draw the particle store, one program per skin. Every particle gets its own textured quad — the
   * skin's own fragment program, fed that particle's centre/size/fade — which is the cheapest batch
   * that shares a program and the uniform header: instancing would need a second vertex buffer and
   * a per-particle attribute stream for a store that is often empty, while a positioned quad costs
   * one draw and no new state. Additive, like the light effects.
   */
  _drawParticles(view, t) {
    const gl = this.gl;
    if (!this.particles.count) return 0;
    const data = this.particles.data;
    const L = P_FIELDS.length;
    let draws = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (const [skin, progKey] of [[0, 'projectile'], [1, 'heart']]) {
      const prog = this.progs.skins[progKey];
      if (!prog) continue;
      let used = false;
      gl.useProgram(prog);
      gl.bindVertexArray(this.vao);
      for (let r = 0; r < this.particles.count; r++) {
        const o = r * L;
        if (Math.round(data[o + 7]) !== skin) continue;
        // A page-space y is 0 at the top and 1 at the bottom; a particle thrown upward leaves the
        // frame through y < 0. Without this a dead orb sits at y -2 and paints the whole screen
        // white — the field is unbounded, so there is no edge to clip it.
        if (data[o + 0] < -0.15 || data[o + 0] > 1.15 || data[o + 1] < -0.15 || data[o + 1] > 1.15) continue;
        if (!used) {
          // the header and per-program uniforms are filled once per batch
          this._uniformHeader(prog, t, 7.0 + skin);
          used = true;
        }
        const life = Math.max(0.001, data[o + 5]);
        const age = data[o + 4];
        // fade in over the first 0.12 s and out over the last 60% of the life
        const fade = Math.min(1, age / 0.12) * Math.min(1, (life - age) / (life * 0.6));
        const size = data[o + 6] * (1 - (age / life) * 0.5);
        const [u, v] = toUv(data[o + 0], data[o + 1], this.w / this.h);
        // The skin programs draw at unit scale: u_radius is the field-space size, while the vertex
        // shader works in clip space where x spans the whole width whatever the aspect. The orb is
        // round on screen, so a size in field units becomes size / aspect in clip x.
        const radius = size / (this.w / this.h);
        // The orb's trail points back along its own velocity, so the streak follows the throw
        // instead of always hanging downward. Field space, like METEOR's u_dir.
        const vx = data[o + 2] * (this.w / this.h);
        const vy = -data[o + 3];
        const vm = Math.hypot(vx, vy) || 1;
        loc(gl, prog, 'u_center', this._uniformCache, (l) => gl.uniform2f(l, u, v));
        loc(gl, prog, 'u_radius', this._uniformCache, (l) => gl.uniform1f(l, radius));
        loc(gl, prog, 'u_dir', this._uniformCache, (l) => gl.uniform2f(l, vx / vm, vy / vm));
        loc(gl, prog, 'u_energy', this._uniformCache, (l) => gl.uniform1f(l, 1.4));
        loc(gl, prog, 'u_fade', this._uniformCache, (l) => gl.uniform1f(l, Math.max(0, fade)));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        draws++;
      }
    }
    gl.disable(gl.BLEND);
    return draws;
  }

  /**
   * The landmarks `wires` draws: the first hand's, already page space and mirrored by main.js.
   * Kept on the renderer as the last seen skeleton so the wires hold their place between tracker
   * frames; with no hand ever seen it is null and the effect draws nothing (never a guess).
   */
  _handLandmarks(view) {
    const hand = view.hands && view.hands[0];
    const lm = hand && (hand.landmarks || hand.points);
    if (lm && lm.length >= 21) {
      this._lastLandmarks = lm;
      return lm;
    }
    return this._lastLandmarks || null;
  }

  /* ------------------------------------------------------------ history */

  /**
   * Bind the history read target and the write target before a history effect draws: the effect
   * draws into `history[cur]`, and samples `history[1-cur]` (bound to TEXTURE_UNIT_HISTORY) as
   * `u_prev`. Returns the top-left texco of the write target, for a caller that needs it.
   */
  _beginHistory() {
    const gl = this.gl;
    if (!this.history) this._resize();
    const pair = this.history[this.historyCur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, pair.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_HISTORY);
    gl.bindTexture(gl.TEXTURE_2D, this.history[1 - this.historyCur].tex);
    this.historyAge = 0;
    return this.history[1 - this.historyCur].tex;
  }

  /** After a history effect drew: its write target becomes the next frame's read target. */
  _swapHistory() {
    this.historyCur = 1 - this.historyCur;
    this.historyAge = 0;
  }

  /** Clear both history targets (a resize, or a respawn of the effect that was advecting them). */
  _clearHistory() {
    const gl = this.gl;
    if (!this.history) return;
    for (const p of this.history) clearPair(gl, p);
    this.historyCur = 0;
    this.historyAge = 0;
  }

  /** Copy the accumulated scene into `snapTex` (before a spectacle effect is applied over it). */
  _snapshotScene() {
    const gl = this.gl;
    if (!this.snapFbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.snapFbo);
    gl.viewport(0, 0, this.w, this.h);
    this._blit(this.sceneTex); // opaque full-frame copy: no clear needed
    this._snapTaken = true;
  }

  /* ------------------------------------------------------------ hand edit */

  /**
   * The pointer's own strokes for the `edit` effect. The page calls these from pointer events (a
   * mouse, a wand, a tablet stylus — whatever the operator paints with) and the renderer stamps
   * each segment into a full-resolution canvas texture, added to the scene once per frame. No
   * trail history: the canvas *is* the picture, and `editClear()` is the eraser.
   */
  editBegin(x, y, { colour, width } = {}) {
    this.editPointer = { x, y, colour: colour || [1, 1, 1], width: Number.isFinite(width) ? width : 0.012 };
    this._editLoc = null;
    return Boolean(this.gl) && Boolean(this.edit);
  }

  /** A stroke step. A fast drag is interpolated so the stroke is a line, not a row of dots. */
  editMove(x, y) {
    const p = this.editPointer;
    if (!p || !this.gl || !this.edit) return false;
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < 0.0015) return false;
    const steps = Math.min(255, Math.max(1, Math.ceil(d / (p.width * 0.6))));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this._stamp(p.x + (x - p.x) * t, p.y + (y - p.y) * t, p);
    }
    p.x = x;
    p.y = y;
    return true;
  }

  editEnd() {
    this.editPointer = null;
    return true;
  }

  /** Wipe the edit canvas (a new stroke session, or the operator asking for a clean slate). */
  editClear() {
    const gl = this.gl;
    if (!gl || !this.edit) return false;
    clearPair(gl, this.edit);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /**
   * One disc of the stroke. The shared quad's vertices are a_pos = ±1, so the stroke program scales
   * them by `u_size` (field space) and offsets by `u_center` before the usual uv mapping: the brush
   * is a small quad at the pointer, drawn source-over in the stroke colour.
   */
  _stamp(x, y, p) {
    const gl = this.gl;
    if (!this._editProg) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edit.fbo);
    gl.viewport(0, 0, this.w, this.h);
    const prog = this._editProg;
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    const set = (n, f) => {
      const l = uniformLoc(gl, prog, n, this._uniformCache);
      if (l) f(l);
    };
    const r = p.width * 0.5;
    set('u_center', (l) => gl.uniform2f(l, x * (this.w / this.h), 1 - y));
    set('u_size', (l) => gl.uniform1f(l, r));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_colour', (l) => gl.uniform3f(l, p.colour[0], p.colour[1], p.colour[2]));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    // Leave the default framebuffer bound: the edit FBO must not leak into the next frame's scene
    // clear, or the stroke (and everything else painted after it) is wiped by the clear.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Add the edit canvas to the scene, source-over (it is paint, not light). */
  _drawEdit(live, view, t) {
    const gl = this.gl;
    if (!this.edit) this._resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.w, this.h);
    this._composite(this.edit.tex, 1);
  }

  /* ------------------------------------------------------------ frame */

  /**
   * One frame. `view` carries where things are, in page space (0..1, already mirrored):
   *   palms: [{x, y, radius}]        open palms up
   *   fingertipPairs: [[a,b]]        index/middle fingertip pairs for lightning
   *   front: {x, y, radius}          a palm towards the camera
   *   swipe: {x, y, dir}             a sideways hand
   *   anchor / hands: also read; `hands` is [GESTURE_BONES] per hand, which is what `wires` needs.
   * Nothing here invents a position: an effect is only drawn where a hand (or its own last
   * anchor) actually is.
   */
  render(now, view = {}) {
    // Per-pass durations for the last frame, in ms, keyed by checkpoint name. Diagnostics only:
    // a pass whose cost changes with the GL backend shows up here first.
    this.passCost = {};
    if (!this.supported) return;
    const gl = this.gl;
    // A context can be lost (a GPU reset, a driver crash) without the page noticing: report it,
    // once, instead of leaving a black canvas that looks like a working overlay.
    if (gl.isContextLost && gl.isContextLost()) {
      if (!this.error) {
        this.error = 'WebGL2 context lost';
        this.onError(this.error);
      }
      return;
    }
    if (this._lost) return;
    this.view = view;
    // Read once per stage only when asked (the browser test sets debugGl): getError() forces a
    // pipeline sync, and a per-frame sync is exactly what a stream overlay cannot afford.
    const tPass = { start: 0 };
    const checkpoint = (stage) => {
      // Cost per stage, always collected (a Date.now pair is free next to a draw): a pass that
      // changes cost with the GL backend names itself here, before anything looks wrong on screen.
      const nowMs = performance.now();
      if (stage === 'begin') tPass.start = nowMs;
      else if (tPass.start) {
        this.passCost[stage] = Math.round((nowMs - tPass.start) * 100) / 100;
        tPass.start = nowMs;
      }
      if (!this.debugGl) return;
      const e = gl.getError();
      if (e) this.debugLog.push(`${stage}:0x${e.toString(16)}`);
    };
    this._resize();
    checkpoint('begin');
    checkpoint('resize');
    const t = (now - this.time0) / 1000;
    const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 0.016;
    this._last = now;

    // Age and retire live effects.
    for (const [id, live] of [...this.live]) {
      live.age = (now - live.t0) / 1000;
      const target = live.active ? 1 : 0;
      live.fade += (target - live.fade) * Math.min(1, dt * (live.active ? 8 : 3.5));
      if (!live.active && live.fade < 0.01) {
        this.live.delete(id);
        continue;
      }
      live.energy = live.intensity * live.fade;
    }
    this._integrateParticles(dt);

    // Scene: transparent (OBS source) or, in debug mode, the camera picture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    checkpoint('clear');
    if (this.settings.debugOverlay && this.cameraTex) this._blitCamera();
    checkpoint('camera');

    // Effects, grouped by layer, the operator's order kept inside a layer.
    this._snapTaken = false;
    const groups = { hands: [], body: [], spectacle: [] };
    for (const id of this.settings.effects) {
      const live = this.live.get(id);
      if (!live) continue;
      const layer = live.layer || EFFECTS[id]?.layer || 'hands';
      (groups[layer] || groups.hands).push(live);
    }
    let historyUsed = false;
    for (const layer of LAYER_ORDER) {
      for (const live of groups[layer]) {
        // `id` is what `_drawEffect` keys the program and the uniform fill on; take it from `live`
        // so the draw can never disagree with the effect that is actually live.
        const id = live.id;
        const def = EFFECTS[id];
        if (!def) continue;
        if (id === 'shoot') {
          // The default projector: particles go through the ordinary layer path (cleared layer,
          // particles drawn into it, layer composited onto the scene at the effect's `mode`), so
          // they sit in the same order as every other effect instead of bypassing the layers.
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
          gl.viewport(0, 0, this.w, this.h);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          this._drawParticles(view, t);
          checkpoint('particles');
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
          gl.viewport(0, 0, this.w, this.h);
          this._composite(this.layerTex, def.mode === 1 ? 1 : 0, layerWeight(id));
          continue;
        }
        if (id === 'edit') {
          this._drawEdit(live, view, t);
          checkpoint('edit');
          continue;
        }
        if (SNAPSHOT_EFFECTS.has(id) && !this._snapTaken) {
          this._snapshotScene();
          checkpoint('snapshot');
        }
        const history = HISTORY_EFFECTS.has(id);
        if (history) {
          historyUsed = true;
          if (this._historyEpoch !== live.epoch) {
            this._clearHistory();
            this._historyEpoch = live.epoch;
          }
          this._beginHistory();
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
          gl.viewport(0, 0, this.w, this.h);
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const drew = this._drawEffect(id, live, view, t);
        checkpoint(`draw:${id}`);
        // A history effect wrote into its own ping-pong target; that target is what composites.
        const target = history ? this.history[this.historyCur].tex : this.layerTex;
        if (history) this._swapHistory();
        if (!drew) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
        gl.viewport(0, 0, this.w, this.h);
        this._composite(target, def.mode === 1 ? 1 : 0, layerWeight(id));
        checkpoint(`composite:${id}`);
      }
    }
    // History that nobody read this frame ages out, so a re-enable starts from a clean slate.
    if (!historyUsed) {
      this.historyAge++;
      if (this.historyAge === HISTORY_IDLE_FRAMES) this._clearHistory();
    }

    // Bloom: a 4× downsample of the scene (bilinear), added back by the final pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo);
    gl.viewport(0, 0, Math.max(2, this.w >> 2), Math.max(2, this.h >> 2));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._blit(this.sceneTex);
    checkpoint('bloom');

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const fp = this.progs.final;
    gl.useProgram(fp);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTex);
    const set = (n, f) => {
      const loc = gl.getUniformLocation(fp, n);
      if (loc) f(loc);
    };
    set('u_scene', (l) => gl.uniform1i(l, 0));
    set('u_bloom', (l) => gl.uniform1i(l, 1));
    set('u_exposure', (l) => gl.uniform1f(l, 1.0));
    set('u_bloomAmount', (l) => gl.uniform1f(l, 0.55));
    set('u_res', (l) => gl.uniform2f(l, this.w, this.h));
    set('u_time', (l) => gl.uniform1f(l, t));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_seed', (l) => gl.uniform3f(l, 1, 2, 3));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    checkpoint('final');
    // Back to the neutral bindings so nothing outside a draw inherits an effect's units.
    gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_BODY);
    gl.bindTexture(gl.TEXTURE_2D, this.bodyTex || this.neutralTex);
    gl.activeTexture(gl.TEXTURE0);
    // Surface a GL error as an error, not as silence. Read once per frame; the flag stops the
    // render loop from piling up log rows if it keeps erroring.
    const err = gl.getError();
    if (err !== 0 && err !== this.lastGlError) {
      this.lastGlError = err;
      this.error = `WebGL error 0x${err.toString(16)} while compositing`;
      this.onError(this.error);
    }
    this.frame++;
  }

  _uniformHeader(prog, t, seed) {
    const gl = this.gl;
    const set = (n, f) => {
      const loc = uniformLoc(gl, prog, n, this._uniformCache);
      if (loc) f(loc);
    };
    // The header every effect program shares. Effects that sample a texture (history, the body
    // mask, the camera) bind their samplers in `_drawEffect`; programs that declare none cannot be
    // fed a stale unit, so the header stays free of sampler assignment.
    set('u_res', (l) => gl.uniform2f(l, this.w, this.h));
    set('u_time', (l) => gl.uniform1f(l, t));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_seed', (l) => gl.uniform3f(l, seed, seed * 1.7, seed * 2.3));
  }

  /**
   * Fill one effect's uniforms and draw it into the currently bound layer (or history) target.
   * Returns false when the effect had nothing to draw (no body mask, no hand for a skeleton), in
   * which case the caller skips its composite pass entirely.
   */
  _drawEffect(id, live, view, t) {
    const gl = this.gl;
    const prog = this.progs.effects[id];
    if (!prog) return false;
    const def = EFFECTS[id];
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    this._uniformHeader(prog, t, live.t0 % 100);
    const set = (n, f) => {
      const loc = uniformLoc(gl, prog, n, this._uniformCache);
      if (loc) f(loc);
    };
    // Page space (0..1, y down) is what main.js gives; the shaders think in uv (y up), and the
    // fragment field scales uv.x by aspect, so a centre goes in as (x * aspect, 1 - y).
    const toUv = (p) => toUvPoint(p, this.w / this.h);
    const body = BODY_EFFECTS.has(id);
    if (body && !this.bodyMaskSeen) return false;
    // Every sampler unit is bound to its documented texture (or the neutral 1x1) before the effect
    // draws, so a skipped branch above can never inherit the last program's binding.
    const bindUnit = (unit, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex || this.neutralTex);
    };
    bindUnit(TEXTURE_UNIT_BODY, this.bodyTex);
    bindUnit(TEXTURE_UNIT_HISTORY, this.history ? this.history[1 - this.historyCur].tex : this.neutralTex);
    bindUnit(TEXTURE_UNIT_SNAP, this.snapTex);
    // The hand blob effects (aura, portal, slime, bloom) share one anchor rule: the first open
    // palm, else the first hand's palm, else the effect's own last centre.
    const anchor =
      (view.palms && view.palms[0]) ||
      (view.hands && view.hands[0] && view.hands[0].palm) ||
      view.anchor ||
      null;
    const centreOf = (c) => (c && Number.isFinite(c.x) ? c : live.centre);
    const radiusOf = (c, floor) => Math.max(floor, (c && c.radius) || live.radius);
    const energySet = () => {
      set('u_energy', (l) => gl.uniform1f(l, live.energy));
      set('u_fade', (l) => gl.uniform1f(l, live.fade));
    };
    if (id === 'fireball') {
      const palm = view.palms && view.palms[0];
      const c = palm ? { x: palm.x, y: palm.y, radius: palm.radius } : live.centre;
      const [u, v] = toUv(c);
      // A palm near the bottom of the frame carries the ball further up (the "travel" setting).
      const lift = (1 - c.y) * this.settings.bufferScroll * 0.6;
      set('u_center', (l) => gl.uniform2f(l, u, Math.min(1, v + lift)));
      set('u_radius', (l) => gl.uniform1f(l, Math.max(0.03, c.radius || live.radius)));
      set('u_energy', (l) => gl.uniform1f(l, live.energy));
      set('u_fade', (l) => gl.uniform1f(l, live.fade));
    } else if (id === 'lightning') {
      const pairs = (view.fingertipPairs || []).slice(0, 4);
      const a = new Float32Array(16);
      const b = new Float32Array(16);
      const meta = new Float32Array(16);
      pairs.forEach((pair, i) => {
        const [ax, ay] = toUv(pair[0]);
        const [bx, by] = toUv(pair[1]);
        a.set([ax, ay, 0, 0], i * 4);
        b.set([bx, by, 0, 0], i * 4);
        // Zig-zag along the field: a straight line between two fingertips wants a slight sag so
        // the arc reads as energy, not a wire. Ends stay on the fingertips.
        meta.set([1, live.energy, i * 3.17 + 1, 1], i * 4);
      });
      set('u_a', (l) => gl.uniform4fv(l, a));
      set('u_b', (l) => gl.uniform4fv(l, b));
      set('u_meta', (l) => gl.uniform4fv(l, meta));
      set('u_count', (l) => gl.uniform1i(l, pairs.length));
    } else if (id === 'sparkring') {
      const c = view.front || live.centre;
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_radius', (l) => gl.uniform1f(l, Math.max(0.05, (c.radius || live.radius) * 1.9)));
      energySet();
    } else if (id === 'embers') {
      const c = view.anchor || live.centre;
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_spread', (l) => gl.uniform1f(l, Math.max(0.15, (c.radius || 0.1) * 3.2)));
      energySet();
    } else if (id === 'smoke') {
      const c = view.swipe || view.anchor || live.centre;
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_width', (l) => gl.uniform1f(l, Math.max(0.12, (c.radius || 0.12) * 2.6)));
      energySet();
    } else if (id === 'wires') {
      // One skeleton per draw: the frame's own landmarks, page space (mirrored by main.js), x
      // scaled by aspect because the shader's field() does the same. Missing points stay (0,0) —
      // the tracker's "not seen" sentinel — and the shader skips every bone that touches one.
      // With a hand the skeleton follows it; without one `_handPoint` hands back the last hit, so
      // the wires stay on the operator's digit (the same rule as `live.centre`, never a guess).
      const pts = new Float32Array(42);
      const lm = this._handLandmarks(view);
      for (let i = 0; i < 21; i++) {
        const q = lm && lm[i];
        pts[i * 2] = q ? q.x * (this.w / this.h) : 0;
        pts[i * 2 + 1] = q ? 1 - q.y : 0;
      }
      set('u_p', (l) => gl.uniform2fv(l, pts));
      set('u_count', (l) => gl.uniform1i(l, GESTURE_BONES.length));
      energySet();
    } else if (id === 'aura' || id === 'portal' || id === 'slime' || id === 'bloomlife') {
      // The blob follows the hand's centre; its size follows the hand's scale where the shader reads
      // a radius. Slime's goo sags from the centre, so it wants the palm-sized radius, not a ring's.
      const c = centreOf(anchor);
      const handRadius = Math.max(0.06, (anchor && anchor.radius) || live.radius * 2);
      if (id === 'bloomlife') {
        // Blossoms are placed at `u_center + (cos, sin) * u_radius * (0.45..2)`, i.e. the shader
        // works in field space (x already aspect-scaled). Passing a uv centre and a field radius
        // squashed the ring toward the frame edge, so the flowers mostly fell off it; both go in
        // in field units here, with the vertical sweep kept to the hand's own scale.
        set('u_center', (l) => gl.uniform2f(l, c.x * (this.w / this.h), 1 - c.y));
        set('u_radius', (l) => gl.uniform1f(l, handRadius * 2.2));
        energySet();
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return true;
      }
      // Slime is field space (see SLIME: `vec2 p = field()`, `u_radius` a field radius); aura and
      // portal read `field()` too, so a uv centre here put the goo half a frame to the left and
      // its radius in uv units made it large enough to read as a veil. One space for all four.
      set('u_center', (l) => gl.uniform2f(l, c.x * (this.w / this.h), 1 - c.y));
      const r = id === 'aura' ? handRadius * 5 : id === 'portal' ? handRadius * 6 : handRadius;
      set('u_radius', (l) => gl.uniform1f(l, r));
      energySet();
    } else if (id === 'frost') {
      // Frost roots sit at field y = -0.15 / 1.15 and grow *toward* u_center, so the centre is a
      // field-space point (x aspect-scaled) like every other field-space input in this shader —
      // feeding it a uv point put the growth target off to the left of the frame.
      const c = centreOf(anchor);
      set('u_center', (l) => gl.uniform2f(l, c.x * (this.w / this.h), 1 - c.y));
      // Growth curve: reach rises fast in the first half second (the creep is visible immediately)
      // and saturates by ~2.5 s; smoothstep keeps the tip soft instead of a hard edge.
      const grow = smoothstep01(live.age / 2.5);
      set('u_grow', (l) => gl.uniform1f(l, grow));
      energySet();
    } else if (id === 'disco') {
      const c = centreOf(anchor);
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      energySet();
    } else if (id === 'cyber' || id === 'shatter') {
      const c = centreOf(anchor);
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      energySet();
    } else if (id === 'inkflow' || id === 'echo') {
      // Both read the previous frame from the history unit; `_beginHistory` chose the targets and
      // bound the read side there. Echo is the same dye on a different source: the edit canvas, so
      // the operator's own strokes bleed instead of an invented colour field.
      const c = centreOf(anchor);
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_prev', (l) => gl.uniform1i(l, TEXTURE_UNIT_HISTORY));
      set('u_src', (l) => gl.uniform1i(l, TEXTURE_UNIT_SNAP));
      if (id === 'echo') set('u_radius', (l) => gl.uniform1f(l, live.radius * 9.0));
      energySet();
    } else if (id === 'electroshock') {
      const c = centreOf(view.front || anchor);
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      // The wavefront expands with age: 0.5 s to cross the short side, then it lingers and dies in
      // the fade. Radius is in field units (x in aspect-scaled uv, y in uv).
      set('u_radius', (l) => gl.uniform1f(l, 0.02 + live.age * 1.6));
      set('u_src', (l) => gl.uniform1i(l, TEXTURE_UNIT_SNAP));
      energySet();
    } else if (id === 'meteor') {
      // One meteor per `meteor` live, thrown from the anchor where the gesture fired: it climbs up
      // and to the side, the side following the swipe direction when the frame has one. `u_arc`
      // walks the head along the path (0..1 over ~1.1 s), then the fade retires it.
      const c = centreOf(anchor);
      const [fu, fv] = toUv(c);
      const side = view.swipe && Number.isFinite(view.swipe.dir) && view.swipe.dir !== 0 ? Math.sign(view.swipe.dir) : 0.35;
      const m = Math.hypot(side, 1) || 1;
      const dir = { x: side / m, y: -1 / m };
      // The anchor is a page-space point; the direction is converted to field space (x times the
      // aspect, y flipped for uv) so the shader's normalise() keeps it a unit vector either way.
      const aspect = this.w / this.h;
      set('u_from', (l) => gl.uniform2f(l, fu, fv));
      set('u_dir', (l) => gl.uniform2f(l, dir.x * aspect, -dir.y));
      set('u_arc', (l) => gl.uniform1f(l, Math.min(1.0, live.age / 1.1)));
      energySet();
    } else if (id === 'bodyonfire' || id === 'bodysmoke' || id === 'frozenbody') {
      const c = centreOf(anchor);
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_body', (l) => gl.uniform1i(l, TEXTURE_UNIT_BODY));
      energySet();
    } else {
      // shoot (particles) and anything not yet wired: draw nothing rather than a black pass.
      return false;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /**
   * Copy the layer onto the scene: add light (glow effects) or source-over (smoke).
   *
   * The scene texture is the draw target here, so the shader must not sample it — a shader that
   * samples its own framebuffer attachment is INVALID_OPERATION whatever the branch would do. So
   * the scene copy is split: this pass writes the layer with blending, and `blend` says which
   * equation the framebuffer applies. One sampler, one texture, no feedback loop.
   */
  _composite(layerTex, mode, weight) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    const p = this.progs.blit;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, layerTex);
    const loc = gl.getUniformLocation(p, 'u_tex');
    if (loc) gl.uniform1i(loc, 1);
    // mode 0 = add light, 1 = over.
    // The layer shaders write premultiplied colour, so there is no separable weight for add-mode
    // that keeps `src + dst` exact. Additive composition is done in the COMPOSITE program instead
    // (mode 0, `u_weight` on the light and a max() on coverage): a fixed-function ONE/ONE add
    // here would clip every bright layer to white and trip the frame-haze check.
    const w = Number.isFinite(weight) ? clamp(weight, 0, 1) : 1;
    gl.enable(gl.BLEND);
    if (mode === 1) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    else if (w !== 1) {
      gl.disable(gl.BLEND);
      this._addLayer(layerTex, w);
      return;
    } else gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  /**
   * Add one layer onto the scene. Light adds (the layer is premultiplied, so ONE/ONE on colour is
   * exact), and coverage unions instead of summing: a second pass rewrites the destination alpha
   * to `max(dst, src)` by drawing the layer's alpha again with `blendEquationSeparate(ADD, MAX)`,
   * which WebGL2 supports natively (no program, no scene re-read, so no feedback loop).
   */
  _addLayer(layerTex, weight) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.w, this.h);
    const p = this.progs.blit;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, layerTex);
    const loc = gl.getUniformLocation(p, 'u_tex');
    if (loc) gl.uniform1i(loc, 1);
    gl.enable(gl.BLEND);
    if (weight !== 1) {
      // constant factor on colour (CONSTANT_COLOR) and on the source alpha of the coverage pass
      gl.blendColor(weight, weight, weight, weight);
      gl.blendFunc(gl.CONSTANT_COLOR, gl.ONE);
    } else gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // coverage union: colour writes off, alpha equation = MAX
    gl.colorMask(false, false, false, true);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquationSeparate(gl.MAX, gl.FUNC_ADD);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendEquation(gl.FUNC_ADD);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
  }

  _blit(srcTex) {
    const gl = this.gl;
    const p = this.progs.blit;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    const loc = gl.getUniformLocation(p, 'u_tex');
    if (loc) gl.uniform1i(loc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Draw the camera into the scene (debug mode). No transparent black over the scene: the
   *  camera covers the frame, and the effects composite on top of it. */
  _blitCamera() {
    const gl = this.gl;
    const p = this.progs.composite;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    // The composite program declares both samplers; sampling `u_scene` from unit 0 is how it
    // wants them bound, and a unit left pointing at a depth-flipped video texture is what a
    // black camera picture looked like before.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cameraTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cameraTex);
    const set = (n, f) => {
      const loc = gl.getUniformLocation(p, n);
      if (loc) f(loc);
    };
    set('u_layer', (l) => gl.uniform1i(l, 1));
    set('u_layerOnly', (l) => gl.uniform1i(l, 1));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Hand the renderer the camera as a GL texture (debug overlay mode only). */
  setCameraTexture(source) {
    const gl = this.gl;
    if (!source) return;
    if (!this.cameraTex) this.cameraTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.cameraTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** Probe the 3-D-slice-free path from outside (the browser test uses it): one composite pass
   *  and the GL error it produces, so a failure is named by pass, not by frame. */
  probeComposite() {
    const gl = this.gl;
    while (gl.getError()) {
      /* drain */
    }
    this._composite(this.layerTex, 0);
    return gl.getError();
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    const textures = [this.sceneTex, this.layerTex, this.bloomTex, this.cameraTex, this.neutralTex, this.whiteTex, this.snapTex, this.bodyTex, this.edit && this.edit.tex];
    if (this.history) for (const p of this.history) textures.push(p.tex);
    for (const t of textures) if (t) gl.deleteTexture(t);
    const fbos = [this.sceneFbo, this.layerFbo, this.bloomFbo, this.snapFbo, this.edit && this.edit.fbo];
    if (this.history) for (const p of this.history) fbos.push(p.fbo);
    for (const f of fbos) if (f) gl.deleteFramebuffer(f);
    for (const p of Object.values(this.progs?.effects || {})) gl.deleteProgram(p);
    for (const p of Object.values(this.progs?.skins || {})) gl.deleteProgram(p);
    if (this.progs) {
      gl.deleteProgram(this.progs.composite);
      gl.deleteProgram(this.progs.final);
      gl.deleteProgram(this.progs.blit);
    }
    if (this._editProg) gl.deleteProgram(this._editProg);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this._onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    }
    this.history = null;
    this.supported = false;
  }
}

function uniformLoc(gl, prog, name, cache) {
  const key = name;
  let m = cache && cache.get(prog);
  if (!m) {
    m = new Map();
    if (cache) cache.set(prog, m);
  }
  if (m.has(key)) return m.get(key);
  const loc = gl.getUniformLocation(prog, name);
  m.set(key, loc);
  return loc;
}

/** Uniform location through the per-program cache (the Map is shared, the key is the name). */
function loc(gl, prog, name, cache, fn) {
  const l = uniformLoc(gl, prog, name, cache);
  if (l) fn(l);
}

function toUv(x, y, aspect) {
  return [x * aspect, 1 - y];
}

/** Page-space point -> field-space [x * aspect, 1 - y]. */
function toUvPoint(p, aspect) {
  return [p.x * aspect, 1 - p.y];
}

function smoothstep01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

export { EFFECT_ORDER, LAYER_ORDER };

/** Reduce a classify() result to the anchors the effects draw at. Positions stay in camera space
 *  here; the caller mirrors them (the renderer must never guess which way the camera faces).
 *  `hands` carries one 21-point skeleton per hand (page space, mirrored) for `wires`; `palm` is the
 *  same hand's palm centre, so an effect that wants a blob can use it without re-reading the list. */
export function anchorsFrom(readings) {
  const out = { palms: [], fingertipPairs: [], front: null, anchor: null, swipe: null, hands: [] };
  for (const h of readings || []) {
    const c = palmCentre(h.landmarks);
    const s = handScale(h.landmarks);
    out.palms.push({ x: c.x, y: c.y, radius: Math.max(0.04, s * 1.6), hand: h });
    if (!out.anchor) out.anchor = { x: c.x, y: c.y, radius: Math.max(0.08, s * 2.2) };
    if (h.palmFront && !out.front) out.front = { x: c.x, y: c.y, radius: Math.max(0.05, s * 1.6) };
    out.hands.push({
      landmarks: (h.landmarks || []).map((p) => ({ x: p.x, y: p.y, z: p.z })),
      palm: { x: c.x, y: c.y, radius: Math.max(0.05, s * 1.6) },
      handedness: h.handedness || null,
    });
  }
  if ((readings || []).length >= 2) {
    const [a, b] = readings;
    for (const tip of [8, 12]) {
      const pa = a.landmarks[tip];
      const pb = b.landmarks[tip];
      out.fingertipPairs.push([
        { x: pa.x, y: pa.y },
        { x: pb.x, y: pb.y },
      ]);
    }
  }
  return out;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
