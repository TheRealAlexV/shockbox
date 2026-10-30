// The effect renderer: WebGL2, layered passes, one draw per effect.
//
// Layers, back to front (every layer is a full-size RGBA texture):
//   0  scene     — camera (debug overlay mode) or transparent; everything accumulates here
//   1  layer     — one effect's own fragment program, drawn into this, composited onto scene
//   2  bloom     — a 4× downsample of scene, blurred, added by the final pass
//   3  debug     — camera + landmarks drawn with 2-D canvas primitives (only in debug mode)
//
// An effect is a plain object with `program` (its GLSL), `setFrame(gl, uniforms, frame)` to fill
// its uniforms, `mode` (0 add light, 1 source-over) and `weight(frame)`. Effects are listed in one
// registry so the server can name them (ids only) and the page can order/toggle them. The renderer
// knows nothing about hands: main.js reduces a frame to per-effect parameters (a palm position, a
// pair of fingertip points) and hands them over.

import { VERT, FIREBALL, LIGHTNING, SPARKRING, EMBERS, SMOKE, COMPOSITE, FINAL, BLIT } from './fx-glsl.js';
import { palmCentre, handScale } from './tracker.js';

const EFFECT_ORDER = ['fireball', 'lightning', 'sparkring', 'embers', 'smoke'];

export const EFFECTS = {
  fireball: {
    id: 'fireball',
    title: 'Fireball',
    gesture: 'palmUp',
    mode: 0,
    program: FIREBALL,
  },
  lightning: {
    id: 'lightning',
    title: 'Lightning fingers',
    gesture: 'bothFingertips',
    mode: 0,
    program: LIGHTNING,
  },
  sparkring: {
    id: 'sparkring',
    title: 'Spark ring',
    gesture: 'palmFront',
    mode: 0,
    program: SPARKRING,
  },
  embers: {
    id: 'embers',
    title: 'Ember rise',
    gesture: 'any',
    mode: 0,
    program: EMBERS,
  },
  smoke: {
    id: 'smoke',
    title: 'Smoke veil',
    gesture: 'swipe',
    mode: 1,
    program: SMOKE,
  },
};

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
    this.settings = { effects: EFFECT_ORDER.slice(), intensity: {}, bufferScroll: 0.35, mirror: true, debugOverlay: false, enabled: true };
    this.time0 = performance.now();
    this.frame = 0;
    this.debugGl = false; // set true from the browser test to collect the first error per stage
    this.debugLog = [];
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
      for (const id of Object.keys(EFFECTS)) this.progs.effects[id] = program(gl, EFFECTS[id].program, id);
    } catch (err) {
      this.error = err.message;
      this.onError(this.error);
      return false;
    }
    // Unit quad: two triangles, -1..1. One VAO, drawn for every pass.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.vao = vao;
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
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.layerTex) gl.deleteTexture(this.layerTex);
    if (this.bloomTex) gl.deleteTexture(this.bloomTex);
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.layerFbo) gl.deleteFramebuffer(this.layerFbo);
    if (this.bloomFbo) gl.deleteFramebuffer(this.bloomFbo);
    const make = (w2, h2) => {
      const tex = texture(gl, w2, h2);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    const scene = make(w, h);
    const layer = make(w, h);
    const bloom = make(Math.max(2, w >> 2), Math.max(2, h >> 2));
    this.sceneTex = scene.tex;
    this.sceneFbo = scene.fbo;
    this.layerTex = layer.tex;
    this.layerFbo = layer.fbo;
    this.bloomTex = bloom.tex;
    this.bloomFbo = bloom.fbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Spawn (or refresh) an effect at a page-space anchor. */
  trigger(id, { centre, radius } = {}) {
    if (!EFFECTS[id]) return false;
    if (!this.settings.effects.includes(id)) return false;
    const intensity = clamp(Number(this.settings.intensity[id] ?? 1), 0, 2);
    if (intensity <= 0.001) return false;
    let live = this.live.get(id);
    if (!live) {
      live = new Live(id, intensity, centre);
      this.live.set(id, live);
    } else {
      live.active = true;
      live.intensity = intensity;
      if (centre) live.centre = centre;
    }
    if (radius) live.radius = radius;
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

  /**
   * One frame. `view` carries where things are, in page space (0..1, already mirrored):
   *   palms: [{x, y, radius}]   open palms up
   *   fingertipPairs: [[a,b]]   index/middle fingertip pairs for lightning
   *   front: {x, y, radius}     a palm towards the camera
   *   swipe: {x, y, dir}        a sideways hand
   * Nothing here invents a position: an effect is only drawn where a hand actually is.
   */
  render(now, view = {}) {
    if (!this.supported) return;
    const gl = this.gl;
    // A context can be lost (a GPU reset, a driver crash) without the page noticing: report it,
    // once, instead of leaving a black canvas that looks like a working overlay.
    if (gl.isContextLost && gl.isContextLost() && !this.error) {
      this.error = 'WebGL2 context lost';
      this.onError(this.error);
      return;
    }
    // Read once per stage only when asked (the browser test sets debugGl): getError() forces a
    // pipeline sync, and a per-frame sync is exactly what a stream overlay cannot afford.
    const checkpoint = (stage) => {
      if (!this.debugGl) return;
      const e = gl.getError();
      if (e) this.debugLog.push(`${stage}:0x${e.toString(16)}`);
    };
    this._resize();
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

    // Scene: transparent (OBS source) or, in debug mode, the camera picture.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    checkpoint('clear');
    if (this.settings.debugOverlay && this.cameraTex) this._blitCamera();
    checkpoint('camera');

    // Effects, in the operator's order: each draws into the layer, then composites onto scene.
    for (const id of this.settings.effects) {
      const live = this.live.get(id);
      if (!live) continue;
      const def = EFFECTS[id];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
      gl.viewport(0, 0, this.w, this.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this._drawEffect(id, live, view, t);
      checkpoint(`draw:${id}`);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      gl.viewport(0, 0, this.w, this.h);
      this._composite(this.layerTex, def.mode === 1 ? 1 : 0);
      checkpoint(`composite:${id}`);
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
      const loc = gl.getUniformLocation(prog, n);
      if (loc) f(loc);
    };
    set('u_res', (l) => gl.uniform2f(l, this.w, this.h));
    set('u_time', (l) => gl.uniform1f(l, t));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_seed', (l) => gl.uniform3f(l, 1, 2, 3));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    checkpoint('final');
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
      const loc = gl.getUniformLocation(prog, n);
      if (loc) f(loc);
    };
    set('u_res', (l) => gl.uniform2f(l, this.w, this.h));
    set('u_time', (l) => gl.uniform1f(l, t));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_seed', (l) => gl.uniform3f(l, 1, 2, 3));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    checkpoint('final');
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
      const loc = gl.getUniformLocation(prog, n);
      if (loc) f(loc);
    };
    set('u_res', (l) => gl.uniform2f(l, this.w, this.h));
    set('u_time', (l) => gl.uniform1f(l, t));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_seed', (l) => gl.uniform3f(l, 1, 2, 3));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    checkpoint('final');
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
      const loc = gl.getUniformLocation(prog, n);
      if (loc) f(loc);
    };
    // Every effect is a procedural fragment: no sampler uniforms, so a texture left bound from a
    // previous pass cannot leak into one. The composite is a blit program of its own.
    set('u_res', (l) => gl.uniform2f(l, this.w, this.h));
    set('u_time', (l) => gl.uniform1f(l, t));
    set('u_aspect', (l) => gl.uniform1f(l, this.w / this.h));
    set('u_seed', (l) => gl.uniform3f(l, seed, seed * 1.7, seed * 2.3));
  }

  _drawEffect(id, live, view, t) {
    const gl = this.gl;
    const prog = this.progs.effects[id];
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    this._uniformHeader(prog, t, live.t0 % 100);
    const set = (n, f) => {
      const loc = gl.getUniformLocation(prog, n);
      if (loc) f(loc);
    };
    // Page space (0..1, y down) is what main.js gives; the shaders think in uv (y up), and the
    // fragment field scales uv.x by aspect, so a centre goes in as (x * aspect, 1 - y).
    const toUv = (p) => [p.x * (this.w / this.h), 1 - p.y];
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
      set('u_energy', (l) => gl.uniform1f(l, live.energy));
      set('u_fade', (l) => gl.uniform1f(l, live.fade));
    } else if (id === 'embers') {
      const c = view.anchor || live.centre;
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_spread', (l) => gl.uniform1f(l, Math.max(0.15, (c.radius || 0.1) * 3.2)));
      set('u_energy', (l) => gl.uniform1f(l, live.energy));
      set('u_fade', (l) => gl.uniform1f(l, live.fade));
    } else if (id === 'smoke') {
      const c = view.swipe || view.anchor || live.centre;
      const [u, v] = toUv(c);
      set('u_center', (l) => gl.uniform2f(l, u, v));
      set('u_width', (l) => gl.uniform1f(l, Math.max(0.12, (c.radius || 0.12) * 2.6)));
      set('u_energy', (l) => gl.uniform1f(l, live.energy));
      set('u_fade', (l) => gl.uniform1f(l, live.fade));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    gl.enable(gl.BLEND);
    if (mode === 1) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
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
    for (const t of [this.sceneTex, this.layerTex, this.bloomTex, this.cameraTex]) if (t) gl.deleteTexture(t);
    for (const f of [this.sceneFbo, this.layerFbo, this.bloomFbo]) if (f) gl.deleteFramebuffer(f);
    for (const p of Object.values(this.progs?.effects || {})) gl.deleteProgram(p);
    if (this.progs) {
      gl.deleteProgram(this.progs.composite);
      gl.deleteProgram(this.progs.final);
      gl.deleteProgram(this.progs.blit);
    }
    this.supported = false;
  }
}

export { EFFECT_ORDER };

/** Reduce a classify() result to the anchors the effects draw at. Positions stay in camera space
 *  here; the caller mirrors them (the renderer must never guess which way the camera faces). */
export function anchorsFrom(readings) {
  const out = { palms: [], fingertipPairs: [], front: null, anchor: null, swipe: null };
  for (const h of readings || []) {
    const c = palmCentre(h.landmarks);
    const s = handScale(h.landmarks);
    out.palms.push({ x: c.x, y: c.y, radius: Math.max(0.04, s * 1.6), hand: h });
    if (!out.anchor) out.anchor = { x: c.x, y: c.y, radius: Math.max(0.08, s * 2.2) };
    if (h.palmFront && !out.front) out.front = { x: c.x, y: c.y, radius: Math.max(0.05, s * 1.6) };
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
