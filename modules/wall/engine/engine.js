/**
 * LED Wall v2 — engine (engine.js)
 * ===============================
 * Classic script.  Exposes `window.LEDWall = { mount, version }` exactly as
 * ENGINE-API.md specifies; display.html and control.html both call mount().
 *
 * Frame (2560×1440, 112×63 by default):
 *
 *   1. sim pass      cols×rows RGBA16F ping-pong, one fragment per LED
 *   2. scene pass    clear to bg, instanced streaks, instanced LED quads
 *                    (zero per-frame buffers — cells come from gl_InstanceID)
 *   3. bright pass   scene → bloom mip0 (½ res)
 *   4. downsample    mip0 → mip1 … mip4
 *   5. upsample      mip4 → mip3 … mip0 (additive 9-tap tent)
 *   6. composite     bloom add, exposure/lift/contrast/sat, ACES, vignette,
 *                    grain, ordered dither → canvas
 *
 * Draw-call count per frame: 1 sim + 1 clear + 2 instanced + 1 bright +
 * 4 down + 4 up + 1 composite = 13.  No allocation, no upload after the first
 * frame (uniforms and the 256×1 LUT only change when settings change).
 */
(function () {
  'use strict';

  var DEFAULTS  = window.LEDWALL_DEFAULTS  || {};
  var PALETTES  = window.LEDWALL_PALETTES  || {};
  var PRESETS   = window.LEDWALL_PRESETS   || {};
  var GRADE     = window.LEDWALL_GRADE;
  var SIM       = window.LEDWALL_SIM;

  if (!GRADE || !SIM) throw new Error('LEDWall: config.js, grade.js and sim.js must load first');

  // ── Preset dimensions ─────────────────────────────────────────────────────
  // What a preset *is*: the look of the wall. Deliberately excludes grid geometry (`gridCols`,
  // `gridRows`, `cellShape`) because that is a property of the physical installation, not of a
  // look, and it excludes everything under `views.*.text` because a preset must never reach the
  // text-mode message pool.  `preset.save` copies exactly these keys off the live settings.
  // One list, two runtimes: `server.js` imports it (it is exported below) and this page uses it.
  // A dimension added to a preset must be added once, or a saved look loses it on the way back.
  var PRESET_DIMS = [
    'mode', 'pattern', 'speed', 'transitionSpeed',
    'palette', 'paletteWeight', 'bgColor', 'hdrGain',
    'ledSize', 'streakOpacity', 'flashDensity', 'waveFrequency', 'persistence',
    'flareIntensity', 'flareLength', 'flareRotation',
    'bloom', 'bloomThreshold', 'bloomRadius',
    'exposure', 'saturation', 'contrast', 'lift', 'vignette', 'grain',
    'dither', 'acsTonemap', 'bits',
    // The picture is part of the look: where it sits, how it is coloured, how deep. `imageOn`
    // says the picture is on the wall at all; `imageRev` names the stored upload so loading the
    // preset puts the same picture back.
    'imageX', 'imageY', 'imageScale', 'imageRotate', 'imageColour', 'imageBits', 'imageDither',
    'imageOn', 'imageRev',
    'textScroll', 'safeArea'
  ];

  /** Operator-saved presets live beside the shipped ones in the same lookup the engine reads. */
  function applySavedPresets(saved) {
    Object.keys(saved || {}).forEach(function (n) { PRESETS[n] = saved[n]; });
    return PRESETS;
  }

  /**
   * How fast the palette scrolls across LIT TEXT cells, per pattern.
   *
   * In text mode the pattern selector no longer switches what the cells do (a glyph cell is
   * always a lit LED); it switches the motion of the colour ramp running through them, so
   * "pattern = animation only" still means something while a notice is on air. Indexed by
   * SIM.PATTERNS so the list order stays the engine's own.
   */
  var TEXT_SCROLL_RATE = {
    random: 0.10, wave: 0.04, bottomCenter: 0.06, sweep: 0.14, bars: 0.08, ripple: 0.07,
    plasma: 0.05, chase: 0.20, sweepMirror: 0.12, comet: 0.16,
    matrix: 0.09, spectrum: 0.11, orbits: 0.06, rain: 0.07, equalizer: 0.10, static: 0.00,
    heartbeat: 0.05
  };

  function textScrollRate(idx) {
    var name = SIM.PATTERNS[idx];
    var rate = TEXT_SCROLL_RATE[name];
    return typeof rate === 'number' ? rate : 0.04;
  }

  function savedPresetList() {
    return Object.keys(PRESETS);
  }

  var BLOOM_MIPS = 5;

  // ── Small helpers ──────────────────────────────────────────────────────────

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  // Same URL helper boot.js uses (`qNum` there): absent parameter → the default, present →
  // Number() of it, so a typo reads as NaN instead of a silent 0.
  function qNum(name, dflt) {
    var v = (typeof location === 'undefined' || !location.search) ? null
      : new URLSearchParams(location.search).get(name);
    return v === null ? dflt : Number(v);
  }

  // ── Idle throttle ─────────────────────────────────────────────────────────
  // A wall page lives in an OBS browser source for days. When the look is static — speed 0,
  // no grain, no trail, nothing revealing, and no image on the way in — a full GPU frame per
  // vsync draws the same picture again. The loop then sleeps at IDLE_FPS. `?idleFps=` overrides
  // the rate for verification (0 = never skip); absent leaves the default path untouched.
  var IDLE_FPS = (function () {
    var v = qNum('idleFps', 5);
    if (!isFinite(v)) v = 5;
    return v <= 0 ? 0 : clamp(v, 0.5, 30);
  })();
  // After a change, keep drawing for this long: the sim eases `cur` toward `br` with
  // `1 - exp(-dt * rate * transition)`, so one frame after a patch is not the final picture.
  var IDLE_SETTLE_MS = 1000;

  function merge(base, part) {
    var out = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (part) {
      for (var j in part) {
        if (!Object.prototype.hasOwnProperty.call(part, j)) continue;
        var v = part[j];
        if (v && typeof v === 'object' && !Array.isArray(v) &&
            base[j] && typeof base[j] === 'object') {
          out[j] = merge(base[j], v);
        } else if (v !== undefined) {
          out[j] = v;
        }
      }
    }
    return out;
  }

  function hexToRgb01(hex) {
    var c = GRADE.hexToRgb(hex);
    return [c[0], c[1], c[2]];
  }

  function cloneJSON(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  /**
   * One name from `list` that is not in `exclude`; null when nothing is left.
   * `text.send`'s `'random'` uses this so the operator always sees a *change*:
   * candidates that would reproduce the current look are removed first, and an
   * empty pool means "no override" rather than a silent repeat.
   */
  function pickOther(list, exclude) {
    var pool = [];
    for (var i = 0; i < list.length; i++) {
      if (exclude.indexOf(list[i]) < 0) pool.push(list[i]);
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ── GL program helpers ────────────────────────────────────────────────────

  function compile(gl, type, src, label) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('LEDWall shader (' + label + '): ' + log);
    }
    return sh;
  }

  function makeProgram(gl, vsSrc, fsSrc, label) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vs');
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.fs');
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('LEDWall link (' + label + '): ' + log);
    }
    return { p: p, u: Object.create(null) };
  }

  function loc(gl, prog, name) {
    var l = prog.u[name];
    if (l === undefined) {
      l = gl.getUniformLocation(prog.p, name);
      prog.u[name] = l;
    }
    return l;
  }

  function f1(gl, prog, name, v) { var l = loc(gl, prog, name); if (l) gl.uniform1f(l, v); }
  function i1(gl, prog, name, v) { var l = loc(gl, prog, name); if (l) gl.uniform1i(l, v); }
  function f2(gl, prog, name, x, y) { var l = loc(gl, prog, name); if (l) gl.uniform2f(l, x, y); }
  function f3(gl, prog, name, x, y, z) { var l = loc(gl, prog, name); if (l) gl.uniform3f(l, x, y, z); }
  function f4(gl, prog, name, x, y, z, w) { var l = loc(gl, prog, name); if (l) gl.uniform4f(l, x, y, z, w); }

  // ── LED draw shaders ──────────────────────────────────────────────────────

  var LED_VERT = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2  u_grid;      // cols, rows',
    'uniform float u_extent;    // quad half-size, in cell units',
    'uniform sampler2D u_sim;',
    'uniform vec4  u_imgXf;      // x, y (picture centre, wall uv), scale, unused',
    'uniform vec2  u_imgRot;     // cos, sin',
    'uniform vec2  u_imgSize;    // half width, half height (cell-pitch units)',
    'out vec2  v_p;             // local offset from cell centre, cell units',
    'out float v_br;',
    'flat out float v_pal;',
    'out vec2  v_cell;          // this LED place on the wall, in cell units',
    'void main() {',
    '  int cols = int(u_grid.x + 0.5);',
    '  int id = gl_InstanceID;',
    '  int col = id - (id / cols) * cols;',
    '  int row = id / cols;',
    '  vec4 st = texelFetch(u_sim, ivec2(col, row), 0);',
    '  v_br  = st.r;',
    '  v_pal = st.b;',
    // The picture's placement maths lives in the fragment shader, on this interpolated wall
    // position: per-instance would quantise the picture to the cell grid, and it stays one frame
    // behind a settings change.
    '  vec2 corner = vec2(float((gl_VertexID & 1) << 1) - 1.0,',
    '                     float(((gl_VertexID >> 1) & 1) << 1) - 1.0);',
    '  v_p = corner * u_extent;',
    '  vec2 c = vec2(float(col) + 0.5, float(row) + 0.5) + v_p;',
    '  v_cell = c;',
    '  vec2 clip = vec2(c.x / u_grid.x, 1.0 - c.y / u_grid.y) * 2.0 - 1.0;',
    '  gl_Position = vec4(clip, 0.0, 1.0);',
    '}'
  ].join('\n');

  var LED_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_lut;',
    'uniform vec3  u_textColor;   // used when a cell is flagged v_pal < -0.5',
    'uniform vec2  u_pxPerCell;   // pixels per cell (x, y)',
    'uniform float u_radiusPx;    // LED disc radius in pixels',
    'uniform float u_ledSize;',
    'uniform float u_flare;',
    'uniform float u_flareLen;',
    'uniform float u_flareRot;    // radians',
    'uniform float u_hdrGain;',
    'uniform float u_streak;      // unused here, keeps the uniform block stable',
    'uniform float u_global;      // the look exposure an image cell is lit at',
    'in vec2  v_p;',
    'in float v_br;',
    'flat in float v_pal;',
    'in vec2  v_cell;           // this fragment in cell units, interpolated',
    'uniform sampler2D u_image;  // the uploaded picture, RGBA8',
    'uniform vec2  u_grid;        // cols, rows (the picture plane is derived from it)',
    'uniform float u_imgOn;       // 0 = no image layer, 1 = sample it where it covers the wall',
    'uniform vec4  u_imgXf;       // x, y (picture centre, wall uv), scale, unused',
    'uniform vec2  u_imgRot;      // cos(theta), sin(theta)',
    'uniform float u_imgMode;     // 0 raw, 1 match the ramp, 2 luminance through the ramp',
    'uniform vec2  u_imgSize;     // aspect compensation: (1, (h / w) * wall aspect)',
    'uniform float u_bits;        // picture bit depth per channel: 4, 8 or 12',
    'uniform float u_imgDither;   // 0 = flat quantise, 1 = 4x4 Bayer offset before quantising',
    'out vec4 o;',
    'void main() {',
    '  vec2 px = v_p * u_pxPerCell;',
    '  float d = length(px);',
    '  // -- the picture plane, computed HERE from the interpolated wall position --',
    '  // Deriving uv per fragment rather than per instance matters for two reasons:',
    '  // (1) the LED instance spans several pixels, so a per-instance uv quantises the',
    '  // picture to the cell grid and its colour-space, and (2) `flat`/interpolated',
    '  // placement attributes survive a settings change one frame late, which is what',
    '  // made a moved picture keep drawing at its old place for a frame.',
    // The picture plane is expressed in WALL fractions on both axes: `u_imgXf.xy` is the
    // picture centre (0..1 of the wall, down-positive) and `u_imgXf.z` its width as a fraction
    // of the wall width. The box that comes out is `scale` of the wall WIDE; `u_imgSize.y`
    // stretches that plane vertically to the picture's own aspect (`scale * (h / w) * (W / H)`,
    // computed by the server from the uploaded file's real dimensions). Without the stretch a
    // square picture was drawn 0.6 wide and 0.34 tall, i.e. an aspect the picture never had, and
    // `scale` meant a different thing on each axis.
    '  vec2 rel = (vec2(v_cell.x / u_grid.x, v_cell.y / u_grid.y) - u_imgXf.xy) / max(u_imgXf.z, 1e-4);',
    '  vec2 uvImg = vec2(u_imgRot.x * rel.x + u_imgRot.y * rel.y,',
    '                    -u_imgRot.y * rel.x + u_imgRot.x * rel.y) + 0.5;',
    '  uvImg.y = (uvImg.y - 0.5) / max(u_imgSize.y, 1e-3) + 0.5;',
    '  // A palette coord of -1 means "this cell is a literal colour" (text with',
    '  // style.colour = "#rrggbb"); everything else samples the LUT.',
    '  vec3 base = v_pal < -0.5 ? u_textColor : texture(u_lut, vec2(v_pal, 0.5)).rgb;',
    '  // -- the image layer: the inverse of "picture centred on (x, y), `scale` of the wall',
    '  // wide, rotated". A picture on this wall is LIT LEDs, not a tint of the pattern: every',
    '  // cell inside the box emits the picture colour, and the pattern behind it is dropped',
    '  // there (the earlier version added the picture to the pattern, so a dark patch of the',
    '  // photograph stayed dark and the box on screen was a sprinkle of lit cells, not a',
    '  // picture). A picture covers the wall; it does not filter it.',
    '  vec3 imgCol = vec3(0.0);',
    '  float imgA = 0.0;',
    // The sample is taken OUTSIDE the box test on purpose. Inside an `if` the compiler is free
    // to treat a sampler read as non-differentiable and flatten `texture()` to its LOD-0
    // constant, which on a uniform picture is indistinguishable from "the picture never
    // arrived": the box lit in the right colour but reading as the texture's average. Sampled
    // unconditionally (and with an explicit LOD), then discarded outside the box, the picture is
    // the pixels that were uploaded.
    '  vec2 imgUv = vec2(clamp(uvImg.x, 0.0, 1.0), 1.0 - clamp(uvImg.y, 0.0, 1.0));',
    '  vec4 imgS = textureLod(u_image, imgUv, 0.0);',
    // The layer obeys u_imgOn and nothing else: pattern, exposure and blackout drive the
    // composite behind it. A picture that only shows when the pattern happens to light the same
    // cell is pattern-gated, not composited.
    '  if (u_imgOn > 0.5) {',
    '    if (uvImg.x >= 0.0 && uvImg.x <= 1.0 && uvImg.y >= 0.0 && uvImg.y <= 1.0) {',
    '      vec3 ic = imgS.rgb;',
    '      imgA = 1.0;',
    '      float lum = dot(ic, vec3(0.2126, 0.7152, 0.0722));',
    '      if (u_imgMode > 1.5) {',
    '        // palette: luminance drives the ramp - the picture\'s own hue is discarded',
    '        imgCol = texture(u_lut, vec2(clamp(lum, 0.0, 1.0), 0.5)).rgb;',
    '      } else if (u_imgMode > 0.5) {',
    '        // match: the nearest entry of the LIVE ramp, so the picture only uses colours the',
    '        // LEDs can emit (32 samples over a 256-entry ramp is close enough that a neighbour',
    '        // never beats the chosen entry by more than a hint)',
    '        float best = 1e9;',
    '        vec3 bestCol = ic;',
    // Every candidate is decoded once, before the loop: a `texture()` whose only consumer sits
    // inside a loop body is the other place a driver flattens a live ramp to a constant, and a
    // frozen ramp is exactly what makes "match" read as "raw".
    '        vec3 ramp[32];',
    '        for (int j = 0; j < 32; j++) {',
    '          ramp[j] = texture(u_lut, vec2((float(j) + 0.5) / 32.0, 0.5)).rgb;',
    '        }',
    '        for (int i = 0; i < 32; i++) {',
    '          vec3 cand = ramp[i];',
    '          vec3 dd = cand - ic;',
    '          float dist = dot(dd, dd);',
    '          if (dist < best) { best = dist; bestCol = cand; }',
    '        }',
    '        imgCol = bestCol;',
    '      } else {',
    '        imgCol = ic;',
    '      }',
    '      // -- bit depth: the picture\'s colour only --',
    '      // N levels per channel (8, 10 or 12 bit). 8 bit is 256 levels, already finer than the',
    '      // uploaded picture, so at the bottom of the ladder the quantiser is the identity and',
    '      // dithering it would only add noise. 4 bit was not an LED depth: 16 levels per channel',
    '      // is coarser than anything the wall\'s ramp can show and made every colour mode look',
    '      // like it had lost the picture.',
    '      // the ordered dither offsets by up to half a level before quantising, so the cells',
    '      // along a gradient land on DIFFERENT levels and the eye resolves the intermediate',
    '      // colours that no cell can show on its own.',
    '      float lv = max(pow(2.0, u_bits) - 1.0, 2.0);',
    '      if (u_imgDither > 0.5) {',
    // The block is 4x4 CELLS, not 4x4 pixels: a cell is one LED and its neighbours are the
    // only other things the same patch of wall is made of, so the pattern has to repeat over
    // the LEDs or the eye never sees it through the emitter profile.
    '        int bx = int(mod(floor(v_cell.x), 4.0));',
    '        int by = int(mod(floor(v_cell.y), 4.0));',
    // A constant-index fold of the 4x4 Bayer matrix (WebGL2 cannot index a matrix dynamically).
    '        float bayer = 0.0;',
    '        if (by == 0) { if (bx == 0) bayer = 0.0; else if (bx == 1) bayer = 8.0; else if (bx == 2) bayer = 2.0; else bayer = 10.0; }',
    '        else if (by == 1) { if (bx == 0) bayer = 12.0; else if (bx == 1) bayer = 4.0; else if (bx == 2) bayer = 14.0; else bayer = 6.0; }',
    '        else if (by == 2) { if (bx == 0) bayer = 3.0; else if (bx == 1) bayer = 11.0; else if (bx == 2) bayer = 1.0; else bayer = 9.0; }',
    '        else { if (bx == 0) bayer = 15.0; else if (bx == 1) bayer = 7.0; else if (bx == 2) bayer = 13.0; else bayer = 5.0; }',
    '        float boff = (bayer / 16.0 - 0.5) / 255.0;',
    // Spread across the three emitters (blue carries three times the offset, green three
    // quarters, red none): the SAME offset on every channel just makes every level per channel
    // and lands the cell on its nearest quantum again, which is why the earlier one-per-channel
    // version could only ever remove colours.
    '        imgCol += vec3(0.0, 0.75 * boff, 3.0 * boff);',
    '      }',
    '      imgCol = floor(clamp(imgCol, 0.0, 1.0) * lv + 0.5) / lv;',
    '    }',
    '  }',
    // A picture cell is lit the way any other cell is lit: the look's exposure (`u_global`,
    // the same `exposure` the composite grades with) times the emitter profile below. The pattern's `v_br` is NOT applied on top - inside the
    // box the picture IS the cell content, and multiplying it by whatever the pattern happened
    // to be doing would make the photo dim and patchy (and would make a colour patch of the
    // pattern show through a colour mode that is supposed to replace it).
    '  if (imgA > 0.5) { base = imgCol; }',
    '  float r = u_radiusPx;',
    // Emitter profile, all radii relative to the LED radius so it holds at any
    // grid density: pin-point core, soft lamp body, crisp edge at 0.78 r.
    '  float core    = exp(-(d * d) / max(r * r * 0.010, 0.8));',
    '  float inner   = exp(-pow(d / max(r * 0.95, 1.5), 1.8)) * 0.62;',
    '  float mid     = exp(-(d * d) / max(r * r * 0.36, 2.0)) * 0.26;',
    '  float e0      = max(1.2, r * 0.78);',
    '  float e1      = e0 + max(0.9, r * 0.16);',
    '  float mask    = 1.0 - clamp((d - e0) / (e1 - e0), 0.0, 1.0);',
    '  float s = (core + inner + mid) * mask;',
    '',
    '  if (u_flare > 0.001) {',
    '    float ca = cos(u_flareRot), sa = sin(u_flareRot);',
    '    vec2 rp = vec2(ca * px.x - sa * px.y, sa * px.x + ca * px.y);',
    '    float vlen = max(r * 5.0 * u_flare * u_flareLen, 1.0);',
    '    float hlen = max(r * 2.5 * u_flare * u_flareLen, 1.0);',
    '    float vfl = exp(-(rp.x * rp.x) / 9.0) * exp(-abs(rp.y) / (vlen * 0.30));',
    '    float hfl = exp(-(rp.y * rp.y) / 4.0) * exp(-abs(rp.x) / (hlen * 0.30));',
    '    s += vfl * 0.40 + hfl * 0.25;',
    '  }',
    '',
    '  float br = v_br;',
    '  float gain = 1.0 + (u_hdrGain - 1.0) * br * br;',
    // The exposure multiplier is NOT re-applied to a picture cell. `base` already carries it -
    // imgCol is `texture * u_global * (u_exposure/2)`, and the code below multiplies by u_global
    // again. That squared the exposure, so a restored image preset and a live-edited one sat at
    // different brightnesses for the same `exposure` and the gate that compares the two saw a
    // colour shift rather than the picture it uploaded.
    '  if (imgA > 0.5) { br = 1.0; gain = 1.0 + (u_hdrGain - 1.0); }',
    // A cell with no pattern behind it and no picture on it is unlit. This test MOVED here from
    // the top of main(): it used to run before the picture was consulted, so a picture cell on a
    // dark band of the wall was dropped before it could be drawn and the box on screen was a
    // copy of the pattern's lit cells rather than the picture.
    '  if (br < 0.002 && imgA < 0.5) { o = vec4(0.0); return; }',
    '  o = vec4(base * clamp(s, 0.0, 1.0) * br * gain, 1.0);',
    '}'
  ].join('\n');

  // ── Streak draw (vertical bleed between LED rows) ──────────────────────────

  var STREAK_VERT = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec2  u_grid;',
    'uniform vec2  u_canvas;',
    'uniform sampler2D u_sim;',
    'uniform sampler2D u_lut;',
    'uniform vec3  u_textColor;',
    'uniform float u_streak;',
    'uniform float u_hdrGain;',
    'uniform vec2  u_fence;       // window x, y (cells); 0 when off',
    'uniform vec2  u_fenceSize;   // window w, h (cells)',
    'uniform float u_fenceOn;',
    'out vec3  v_col;',
    'out float v_fade;',
    'void main() {',
    '  int cols = int(u_grid.x + 0.5);',
    '  int rows = int(u_grid.y + 0.5);',
    '  int id = gl_InstanceID;',
    '  int col = id - (id / cols) * cols;',
    '  int row = id / cols;',
    '  if (row >= rows - 1) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_col = vec3(0.0); v_fade = 0.0; return; }',
    '  vec4 a = texelFetch(u_sim, ivec2(col, row), 0);',
    '  vec4 b = texelFetch(u_sim, ivec2(col, row + 1), 0);',
    '  float avgBr = (a.r + b.r) * 0.5;',
    '  float pal = (a.b + b.b) * 0.5;',
    '  vec3 col3 = pal < -0.5 ? u_textColor : texture(u_lut, vec2(pal, 0.5)).rgb;',
    '  v_col = col3 * avgBr * u_streak * (1.0 + (u_hdrGain - 1.0) * avgBr * avgBr) * 1.6;',
    '  v_fade = 1.0;',
    '',
    // Pitch from the fence when it is on: inside the window the wall is its own dot matrix, and
    // the streak has to land on the cells the pattern actually lit.
    '  float colsF = u_fenceOn > 0.5 ? u_fenceSize.x : u_grid.x;',
    '  float rowsF = u_fenceOn > 0.5 ? u_fenceSize.y : u_grid.y;',
    '  float oxF = u_fenceOn > 0.5 ? u_fence.x : 0.0;',
    '  float oyF = u_fenceOn > 0.5 ? u_fence.y : 0.0;',
    '  float pitchX = u_canvas.x / colsF;',
    '  float pitchY = u_canvas.y / rowsF;',
    '  float x = (float(col) - oxF + 0.5) * pitchX;',
    '  float y0 = (float(row) - oyF + 0.5) * pitchY;',
    '  float y1 = y0 + pitchY;',
    '  float hw = pitchX * 0.20;',
    '  float cx = float((gl_VertexID & 1)) * 2.0 - 1.0;',
    '  float ty = float((gl_VertexID >> 1) & 1);',
    '  float px = x + cx * hw;',
    '  float py = mix(y0, y1, ty);',
    '  gl_Position = vec4(px / u_canvas.x * 2.0 - 1.0, 1.0 - py / u_canvas.y * 2.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var STREAK_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'in vec3  v_col;',
    'in float v_fade;',
    'out vec4 o;',
    'void main() {',
    '  o = vec4(v_col * v_fade, 1.0);',
    '}'
  ].join('\n');

  // ── Instance ──────────────────────────────────────────────────────────────

  function Instance(canvas, settings, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.opts = opts;
    this.s = merge(DEFAULTS, settings || {});
    this.onStats = typeof opts.onStats === 'function' ? opts.onStats : null;

    // Operator-saved presets, handed in by the page (`boot.js` pulls them from the server) or
    // pushed later by `ledwall:saved-presets`. Kept on the instance so `preset.set` sees them.
    this.savedPresets = {};
    applySavedPresets(opts.savedPresets || {});

    this.scale = num(opts.scale, num(this.s.deckDefault && this.s.deckDefault.scale, 2));

    // ── view / ratio ────────────────────────────────────────────────────────
    // The same engine drives a 16:9 and a 9:16 page.  Ratio picks the base
    // canvas (1280x720 or 720x1280, both ×scale) and therefore the cell pitch;
    // view picks which `views{}` block the page honours.
    var ratioQ = opts.ratio || (this.s.deckDefault && this.s.deckDefault.ratio) || '16:9';
    this.ratio = (ratioQ === '9:16') ? '9:16' : '16:9';
    this.view = opts.view || (this.ratio === '9:16' ? 'portrait' : 'landscape');
    if (this.view !== 'portrait') this.view = 'landscape';
    var baseW = this.ratio === '9:16' ? 720 : 1280;
    var baseH = this.ratio === '9:16' ? 1280 : 720;
    this.baseW = num(opts.width, baseW * this.scale);
    this.baseH = num(opts.height, baseH * this.scale);

    // ── the 9:16 fence ─────────────────────────────────────────────────────
    // `fence` is in CANVAS PIXELS (what the operator drags: 720x1280 at scale 1 is 1440x2560
    // here, because the page is 2x). The GPU never sees pixels: `fenceCells` snaps it to whole
    // cells and that is what every uniform gets, so a chase frame lands on the window's edge.
    this.fence = null;      // {x,y,w,h} px, or null
    this.fenceCells = null; // {x,y,w,h} cells, or null
    this.fenceOn = false;

    this.time = 0;          // speed-scaled
    this.elapsed = 0;       // real seconds
    this.scrollCells = 0;
    this.fps = 0;
    this.gpuMs = 0;
    this.cpuMs = 0;
    this.gpuHist = new Float32Array(64);
    this.gpuHistN = 0;
    this.gpuHistI = 0;
    this.paused = false;
    this.destroyed = false;
    this.frameIndex = 0;
    this.lastNow = 0;

    // ── idle throttle state ──────────────────────────────────────────────────
    // `_dirty` is raised by every entry point that changes what the wall draws (settings,
    // deck commands, fence, an image landing) and cleared by the frame that draws it. A dirty
    // frame always draws at once, so interaction is unchanged; only a clean, static look sleeps.
    this._dirty = true;
    this._idleLast = 0;        // timestamp of the last drawn frame
    this._idleSettle = 0;      // keep drawing until then (see IDLE_SETTLE_MS)
    // Readable as `window.LEDWALL_INSTANCE.renderStats` — boot.js puts this instance on that
    // global, so the counters are the loop's own numbers, not a copy.
    this.renderStats = { drawn: 0, skipped: 0, idle: false };

    this.benchState = null;
    this.samples = new Float32Array(8192);
    this.statsAccum = 0;
    // Optional display duration: one snapshot + timer per view.  Local
    // presentation state only — never persisted, never sent to the agent.
    this.holds = { portrait: null, landscape: null };
    // The look/pattern this view had before the live text started overriding it
    // (`{view, snap}`), or null when no text owns the look.  Separate from
    // `holds` because an untimed text has an override but no revert timer.
    this.textLook = null;

    var attrs = {
      alpha: false, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance', desynchronized: false, failIfMajorPerformanceCaveat: false
    };
    var gl = canvas.getContext('webgl2', attrs);
    if (!gl) throw new Error('LEDWall: WebGL2 unavailable');
    this.gl = gl;
    this.label = opts.label || '';

    this.debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    // HDR: probe RGBA16F colour attachment; fall back to RGBA8 + dither.
    this.floatCB = this._probeFloatCB();
    this.colourFmt = this.floatCB
      ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8,  format: gl.RGBA, type: gl.UNSIGNED_BYTE };

    this.progSim     = makeProgram(gl, SIM.vert, SIM.frag, 'sim');
    this.progLed     = makeProgram(gl, LED_VERT, LED_FRAG, 'led');
    this.progStreak  = makeProgram(gl, STREAK_VERT, STREAK_FRAG, 'streak');
    this.progBright  = makeProgram(gl, GRADE.vert, GRADE.bright, 'bright');
    this.progDown    = makeProgram(gl, GRADE.vert, GRADE.down, 'down');
    this.progUp      = makeProgram(gl, GRADE.vert, GRADE.up, 'up');
    this.progComp    = makeProgram(gl, GRADE.vert, GRADE.composite, 'composite');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.W = 0; this.H = 0;
    this.grid = null;
    this.lutTex = null;
    this.textTex = null;
    // The image layer: one RGBA8 texture holding whatever /api/wall/image last served, plus the
    // revision it was uploaded at, so a settings-only change never re-downloads the picture.
    this.imgTex = null;
    this.imgRev = null;       // revision the texture holds
    this.imgAspect = 1;       // picture width / height (diag; the shader uses imageGeometry)
    this.imageGeometry = null; // {aspect} from the server: picture aspect / wall aspect
    this.imgLoading = 0;      // in-flight fetches (diag)
    this.imgLoaded = 0;       // successful uploads (diag)
    this.imgError = '';       // last download/decode failure, verbatim
    this.imgInfo = null;      // {rev, file, w, h} as the server described it
    this.textSize = [0, 0];
    this.textKey = '';
    this.textMs = 0;          // last rasteriser cost, ms (proved in diag)
    this.textFit = { scale: 1, lines: 0, rows: [], overflow: false };
    this.textRasterCount = 0; // how many times the rasteriser ran since mount
    this.revealStart = -1;    // seconds; -1 = not running
    this.revealDur = 0;       // seconds
    this.eff = this.s;        // this view's effective look (inheritLook resolved)
    this.palKey = '';

    this.agent = null;        // agent client (EventSource + /state poster)
    this.agentCmdCount = 0;
    this.agentLastCmd = null;

    this.sceneTex = null;
    this.sceneFbo = null;
    this.bloom = [];
    this.persistOk = 0;       // look writes that reached the document (diag)
    this.persistFail = 0;     // look writes that did not (diag)
    this.imgProbe = null;     // one pixel of the decoded picture, to prove the decode happened
    this.imgAbort = null;     // AbortController of the fetch in flight
    this.imgWantRev = null;   // revision the wall currently WANTS (a late upload is dropped)
    this.simTex = [null, null];
    this.simFbo = [null, null];
    this.simCur = 0;

    this.syncBuf = new Uint8Array(4);
    this._layout();          // canvas size, scene/bloom targets, sim targets
    this._syncDerived();     // LUT, text bitmap, pattern indices
    this._initTimerQueries();

    this._frameBound = this._frame.bind(this);
    this._startAgent(opts.agent, opts.onCommand, opts.onStateChange);
    this.raf = requestAnimationFrame(this._frameBound);
  }

  Instance.prototype._startAgent = function (url, onCommand, onStateChange) {
    this.onCommand = typeof onCommand === 'function' ? onCommand : null;
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    if (!url || url === 'off') return null;
    try {
      this.agent = new AgentClient(this, url);
      this.agent.start();
    } catch (e) {
      this.agent = null;      // an unreachable bus must never stop the wall
    }
    return this.agent;
  };

  Instance.prototype._probeFloatCB = function () {
    var gl = this.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) return false;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  };

  // ── Target allocation ────────────────────────────────────────────────────

  Instance.prototype._makeTex = function (w, h, useFloat, filter, formatOverride) {
    var gl = this.gl;
    var f = formatOverride || (useFloat ? this.colourFmt : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE });
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, w, h, 0, f.format, f.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  Instance.prototype._makeFbo = function (tex) {
    var gl = this.gl;
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  };

  Instance.prototype._freeTargets = function () {
    var gl = this.gl;
    if (this.sceneTex) { gl.deleteTexture(this.sceneTex); this.sceneTex = null; }
    if (this.sceneFbo) { gl.deleteFramebuffer(this.sceneFbo); this.sceneFbo = null; }
    for (var i = 0; i < this.bloom.length; i++) {
      gl.deleteTexture(this.bloom[i].tex);
      gl.deleteFramebuffer(this.bloom[i].fbo);
    }
    this.bloom.length = 0;
    for (var j = 0; j < 2; j++) {
      if (this.simTex[j]) { gl.deleteTexture(this.simTex[j]); this.simTex[j] = null; }
      if (this.simFbo[j]) { gl.deleteFramebuffer(this.simFbo[j]); this.simFbo[j] = null; }
    }
  };

  /** Allocate scene + bloom targets at the current canvas size (this.W/H). */
  Instance.prototype._allocTargets = function () {
    var gl = this.gl;
    var w = this.W, h = this.H;

    this.sceneTex = this._makeTex(w, h, true, gl.LINEAR);
    this.sceneFbo = this._makeFbo(this.sceneTex);

    var bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    for (var i = 0; i < BLOOM_MIPS; i++) {
      var t = this._makeTex(bw, bh, true, gl.LINEAR);
      this.bloom.push({ tex: t, fbo: this._makeFbo(t), w: bw, h: bh });
      bw = Math.max(2, bw >> 1);
      bh = Math.max(2, bh >> 1);
    }
  };

  /**
   * Resolve canvas size and grid, (re)allocating only what changed.
   * Called on mount and whenever settings that move the grid change.
   */
  Instance.prototype._layout = function () {
    this._dirty = true;      // re-sizing, re-allocating or re-gridding always repaints
    var gl = this.gl;
    var W = Math.max(2, Math.round(this.baseW));
    var H = Math.max(2, Math.round(this.baseH));
    var dimsChanged = (W !== this.W || H !== this.H || !this.sceneTex);

    if (dimsChanged) {
      if (this.sceneTex) this._freeTargets();
      this.W = W; this.H = H;
      this.canvas.width = W;
      this.canvas.height = H;
      this._allocTargets();
    }

    var prevKey = this.grid ? (this.grid.cols + 'x' + this.grid.rows) : '';
    this._computeGrid();
    var key = this.grid.cols + 'x' + this.grid.rows;
    if (key !== prevKey || !this.simTex[0]) this._allocSim();
    // Cell pitch moved under the window: re-snap so the fence stays on whole cells.
    if (this.fenceOn) this._computeFence();
  };

  Instance.prototype._allocSim = function () {
    var gl = this.gl;
    var g = this.grid;
    for (var i = 0; i < 2; i++) {
      if (this.simTex[i]) gl.deleteTexture(this.simTex[i]);
      if (this.simFbo[i]) gl.deleteFramebuffer(this.simFbo[i]);
      var t = this._makeTex(g.cols, g.rows, this.floatCB, gl.NEAREST);
      this.simTex[i] = t;
      this.simFbo[i] = this._makeFbo(t);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[i]);
      gl.viewport(0, 0, g.cols, g.rows);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.simCur = 0;
  };

  // ── Grid maths ───────────────────────────────────────────────────────────

  Instance.prototype._computeGrid = function () {
    var s = this.s;
    // Portrait uses its own column count so the cell pitch matches 16:9's:
    // 720×2 / 63 = 22.857 px, and 1280×2 / 112 = 22.857 px (0.0 % drift).
    var wantCols = this.ratio === '9:16'
      ? num(s.gridColsPortrait, 63)
      : num(s.gridCols, 112);
    var cols = clamp(Math.round(wantCols), 4, 400);
    var cellShape = clamp(num(s.cellShape, 1), 0.25, 4);
    var pitchX = this.W / cols;
    var pitchY = pitchX * cellShape;
    var rows = Math.round(num(s.gridRows, 0));
    if (!rows || rows < 8) rows = Math.max(4, Math.round(this.H / pitchY));
    rows = clamp(rows, 4, 400);

    this.grid = {
      cols: cols, rows: rows,
      pitchX: this.W / cols,
      pitchY: this.H / rows,
      cellShape: cellShape
    };
  };

  // ── LUT + text textures ───────────────────────────────────────────────────

  Instance.prototype._syncLUT = function () {
    var gl = this.gl;
    var s = this.eff || this.s;
    var name = PALETTES[s.palette] ? s.palette : 'neonwave';
    var key = name + '|' + num(s.paletteWeight, 1);
    if (key === this.palKey && this.lutTex) return;
    this.palKey = key;

    var data = GRADE.buildLUT(PALETTES[name] || ['#ffffff'], num(s.paletteWeight, 1));
    if (!this.lutTex) {
      this.lutTex = this._makeTex(256, 1, false, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  };

  // ── the image layer ───────────────────────────────────────────────────────

  /**
   * Upload the picture the server is holding, when its revision moved.
   *
   * Same shape as `_syncLUT`: keyed, so a settings change (a drag, a colour mode pick) costs one
   * integer compare and never a re-download. The bytes come from `/api/wall/image` (the file the
   * server stored at upload time); a decode failure is recorded in `imgError` and leaves the
   * previous picture on the wall rather than blanking it.
   */
  Instance.prototype._syncImage = function () {
    var gl = this.gl;
    var s = this.eff || this.s;
    var rev = Math.round(num(s.imageRev, 0));
    var clear = !(num(s.imageOn, 0) >= 0.5);
    if (clear) {
      // Only the texture that IS the stored picture is dropped. A layer switched on again on the
      // next frame - a preset that carries `imageOn: 1`, an operator toggling the box - must not
      // find the upload thrown away and a fresh download put between it and the wall.
      if (this.imgTex && this.imgRev === rev) return;
      if (this.imgTex) { gl.deleteTexture(this.imgTex); this.imgTex = null; }
      this.imgRev = null;
      this.imgInfo = null;
      // The picture the operator just removed must not arrive later: an in-flight download for
      // this revision is cancelled here, or its `then` puts the texture straight back on the wall.
      if (this.imgAbort) { try { this.imgAbort.abort(); } catch (e1) { /* already settled */ } this.imgAbort = null; }
      this.imgWantRev = null;
      return;
    }
    // The guard is "this revision is already loaded", and it used to be `this.imgLoading` as well:
    // any in-flight download - including one for a revision that is already stale - then pinned
    // the picture forever. A layer switched on while the first fetch was still running never got
    // its texture, which is why "the picture does not show" survived a correct upload.
    var have = this.imgTex && this.imgRev === rev;
    if (have) return;
    var self = this;
    var url = '/api/wall/image?v=' + rev + '.' + (self.imgLoaded + 1);
    this.imgLoading++;
    // A picture request must not outlive the frame it belongs to. Two of these open at once (the
    // look flips imageOn on and off while a fetch is in flight) is how "removing the image" left
    // the layer on screen: the late response uploaded a texture for a revision nobody wanted.
    if (this.imgAbort) { try { this.imgAbort.abort(); } catch (e0) { /* already settled */ } }
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    this.imgAbort = ac;
    this.imgWantRev = rev;
    fetch(url, ac ? { signal: ac.signal } : undefined)
      .then(function (r) {
        if (!r.ok) throw new Error('image ' + r.status);
        self.imgInfo = {
          rev: rev,
          file: r.headers.get('x-wall-image') || '',
          w: Number(r.headers.get('x-wall-image-w') || 0),
          h: Number(r.headers.get('x-wall-image-h') || 0)
        };
        return r.blob();
      })
      .then(function (blob) {
        return createImageBitmap(blob);
      })
      .then(function (bmp) {
        // Late arrivals are dropped, not uploaded: the layer may have been switched off (or
        // another revision uploaded) between the request and the decode, and drawing that
        // picture anyway is the "it comes back on its own" the operator saw.
        if (self.imgWantRev !== rev) { if (bmp.close) bmp.close(); return; }
        var w = bmp.width, h = bmp.height;
        // The decoded image is copied through a 2D canvas rather than passed straight to
        // texImage2D: an ImageBitmap's upload is where a WebGL2 context can silently produce an
        // all-zero level 0, and a canvas is the one source that is always pixel-exact.
        var c2d = document.createElement('canvas');
        c2d.width = w;
        c2d.height = h;
        var ctx2d = c2d.getContext('2d');
        ctx2d.drawImage(bmp, 0, 0);
        self.imgProbe = Array.prototype.slice.call(ctx2d.getImageData(0, 0, 1, 1).data);
        if (!self.imgTex) self.imgTex = self._makeTex(w, h, false, gl.LINEAR);
        // Level 0: the decoded bitmap. Re-creating the texture per upload (rather than
        // respecifying the level-0 image of a live one) keeps the uploaded picture independent
        // of whatever unit happened to be active when the fetch resolved.
        gl.activeTexture(gl.TEXTURE0 + 3);
        gl.bindTexture(gl.TEXTURE_2D, self.imgTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c2d);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        // Deliberately NOT a mipmap-complete texture: the engine's own _makeTex leaves
        // MIN_FILTER at LINEAR (not LINEAR_MIPMAP_LINEAR) for exactly this reason — a texture
        // that claims mipmapping but has only level 0 samples black in WebGL2, and black is what
        // an un-set MIN_FILTER looks like here.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        self.imgErr = gl.getError();
        if (bmp.close) bmp.close();
        if (self.imgErr) throw new Error('image texture upload: gl error ' + self.imgErr);
        self.imgAspect = w / Math.max(1, h);
        self.imgRev = rev;
        self.imgLoaded++;
        self.imgError = '';
      })
      .catch(function (e) {
        // A cancelled request is the operator's own action (the layer went off, a new picture
        // arrived), not a failure worth reporting.
        if (e && e.name === 'AbortError') return;
        self.imgError = (e && e.message) ? e.message : String(e);
      })
      .then(function () {
        self.imgLoading = Math.max(0, self.imgLoading - 1);
        self._dirty = true;   // the picture that just landed (or failed) needs the wall drawn
      });
  };

  /** Placement + mode, straight onto the LED program. */
  Instance.prototype._drawImageUniforms = function (s) {
    var gl = this.gl, p = this.progLed;
    // The placement is written here, with the LED program bound and from the same `s` the
    // diffuse pass reads: the settings object the pane edits is not the object this draw uses,
    // so reading it twice is how the transform ends up one value on one pass and another on the
    // next.
    //   u_imgXf = (centre x, centre y as down-positive, scale, 0)
    //   u_imgRot = (cos, sin)
    //   u_imgSize = (1, aspect compensation for the HEIGHT)
    //     `scale` is a fraction of the WALL WIDTH (the pane draws its rectangle the same way).
    //     The wall is not square, so a picture `scale` of the wall wide is
    //     `scale * (h / w) * (W / H)` wall-heights tall; the shader works in wall fractions on
    //     both axes and divides by `u_imgSize.y` to get there.
    // The vertical stretch is the server's `imageGeometry.aspect` (picture height/width times
    // the wall aspect), derived from the uploaded file's real size. Falling back to the wall's own aspect
    // keeps a page that was handed only a look (a bare harness, a URL preset) drawing a square
    // box instead of dividing by zero.
    var geom = this.imageGeometry || null;
    var aspect = geom && num(geom.aspect, 0) > 0
      ? num(geom.aspect, 1)
      : (this.W > 0 && this.H > 0 ? this.W / this.H : (112 / 63));
    var on = (num(s.imageOn, 0) >= 0.5) && this.imgTex ? 1 : 0;
    var scale = clamp(num(s.imageScale, 1), 0.05, 4);
    var mode = String(s.imageColour || 'raw');
    f1(gl, p, 'u_imgOn', on);
    f1(gl, p, 'u_imgMode', mode === 'match' ? 1 : (mode === 'palette' ? 2 : 0));
    f4(gl, p, 'u_imgXf', clamp(num(s.imageX, 0.5), 0, 1), clamp(num(s.imageY, 0.5), 0, 1), scale, 0);
    var rot = num(s.imageRotate, 0) * Math.PI / 180;
    f2(gl, p, 'u_imgRot', Math.cos(rot), Math.sin(rot));
    f2(gl, p, 'u_imgSize', 1, aspect);
    // Bit depth: the picture's own channel levels. Only 8/10/12 are depths an LED wall can be
    // asked for; anything else - including the retired '4' and whatever an older saved preset
    // carries - is 8, where the quantiser is effectively the identity.
    var bits = Math.round(num(s.imageBits, 8));
    f1(gl, p, 'u_bits', bits === 10 || bits === 12 ? bits : 8);
    f1(gl, p, 'u_imgDither', num(s.imageDither, 1) >= 0.5 ? 1 : 0);
  };

  /**
   * Resolve this page's effective look.
   *
   * `views[view]` is a gate + an independent text object + an optional look.
   * With `inheritLook: false` the block's `look` (a preset name or a partial
   * settings object) replaces the global look for this page only; the other
   * view's block is never read.
   */
  Instance.prototype._resolveView = function () {
    var s = this.s;
    var vb = (s.views && s.views[this.view]) || null;
    var eff = s;
    if (vb && vb.inheritLook === false && vb.look && typeof vb.look === 'object') {
      var look = vb.look;
      var base = look.preset && PRESETS[look.preset] ? PRESETS[look.preset] : {};
      eff = merge(merge(s, base), look);
    }
    // A view block may carry its own `mode` / `pattern` (control.html stashes
    // them per view).  Only the page's own block is consulted, and only when
    // the key is actually present.
    if (vb && (vb.mode !== undefined || vb.pattern !== undefined)) {
      var ov = {};
      for (var k in eff) if (Object.prototype.hasOwnProperty.call(eff, k)) ov[k] = eff[k];
      if (vb.mode !== undefined) ov.mode = vb.mode;
      if (vb.pattern !== undefined) ov.pattern = vb.pattern;
      eff = ov;
    }
    this.viewCfg = vb || {};
    this.eff = eff;
    return eff;
  };

  /** The TEXT object this page draws (its own view's block only). */
  Instance.prototype.textObject = function () {
    var vb = this.viewCfg || (this.s.views && this.s.views[this.view]) || {};
    return (vb.text && typeof vb.text === 'object') ? vb.text : null;
  };

  /**
   * Is this page's own text actually on air right now (enabled *and* the
   * effective mode is text)?  Look/pattern commands consult this: they may
   * restyle the wall, never take a live notice off it.
   */
  Instance.prototype._textOnAir = function () {
    var txt = this.textObject();
    return !!(txt && txt.enabled && this.modeIndex);
  };

  Instance.prototype._syncText = function () {
    var gl = this.gl;
    var txt = this.textObject();
    if (!txt) return;
    var key = JSON.stringify([txt, this.grid.cols, this.grid.rows, this.ratio, !!this.textTex]);
    if (key === this.textKey && this.textTex) return;
    this.textKey = key;

    var t0 = (window.performance && performance.now) ? performance.now() : 0;
    var cv = SIM.makeTextCanvas(txt, this.grid.cols, this.grid.rows, { ratio: this.ratio });
    var t1 = (window.performance && performance.now) ? performance.now() : t0;
    this.textMs = t1 - t0;
    this.textRasterCount++;

    if (!this.textTex) {
      this.textTex = this._makeTex(Math.max(2, cv.width), Math.max(2, cv.height), false, gl.NEAREST);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.textTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cv.width, cv.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.textSize = [cv.width, cv.height];
    this.textChars = cv.charTotal || 0;
    this.textCanvas = cv;
    this.textFit = cv.fitInfo || { scale: 1, lines: 0, rows: [], overflow: false };
    // Upload the canvas itself: no getImageData readback, and r/g/b/a survive
    // the copy (r = coverage, g = type-on order; see sim.js).
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  };

  // ── Settings ─────────────────────────────────────────────────────────────

  /** Called on mount and on setSettings; `force` re-syncs derived state. */
  /**
   * Tell the server what this page now looks like, so the look the operator just applied survives
   * the document, the next snapshot frame and a page reload.
   *
   * `preset.save` and `preset.set` change the look on this page first — the server's document is
   * written from the control pane, not from here — so without this the saved/loaded preset lives
   * only in memory and the next `state.snapshot` (a heartbeat, a fence drag) restores whatever the
   * document still holds. Fire-and-forget: a missed write leaves the page rendering the right
   * look, which is why the failure is counted rather than thrown.
   */
  Instance.prototype._persistLook = function (look) {
    if (!look || typeof look !== 'object') return Promise.resolve(false);
    // The page and the server are one origin (the wall is served by the ShockBox server), so the
    // write is relative. It used to be prefix-built from the agent's base URL, which is absolute:
    // that made a same-origin PATCH a cross-origin request, which a page served with the wall's
    // COEP (`require-corp`) blocks - the write then failed every time while a hand-written
    // relative fetch from the same page returned 200.
    var url = '/api/wall/settings';
    this.persistOk = this.persistOk || 0;
    this.persistFail = this.persistFail || 0;
    var self = this;
    var done = function (ok, why) {
      if (ok) { self.persistOk++; } else { self.persistFail++; self.persistErr = why || ''; }
      return ok;
    };
    // Ordered writes: a load that follows a save within one round trip used to race it, and the
    // document kept whichever request happened to finish last. Chaining keeps the newest look
    // the newest write, which is what "the document agrees with the wall" means.
    var prev = this._persistQueue || Promise.resolve();
    this._persistQueue = prev.then(function () { return self._persistLookNow(look, done); });
    // A failed write must not poison the queue: the next look still has to be sent.
    this._persistQueue = this._persistQueue.catch(function () { return false; });
    return this._persistQueue;
  };

  /** One PATCH, serialised by `_persistLook`. `done` counts the outcome on the instance. */
  Instance.prototype._persistLookNow = function (look, done) {
    if (!look || typeof look !== 'object') return Promise.resolve(false);
    var url = '/api/wall/settings';
    try {
      return fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(look)
      }).then(function (r) {
        if (r && r.ok) return done(true);
        return r.text().catch(function () { return ''; }).then(function (t) {
          return done(false, 'HTTP ' + (r && r.status) + ' ' + String(t || '').slice(0, 200));
        });
      }, function (e) { return done(false, 'network ' + ((e && e.message) || e)); });
    } catch (e) {
      return Promise.resolve(done(false));
    }
  };

  Instance.prototype._syncDerived = function () {
    // Every look mutation lands here (setSettings, _patchField, _setViewField, _restoreHold,
    // preset apply, text edits), so one flag here covers the command bus as well as the URL.
    this._dirty = true;
    var eff = this._resolveView();
    this.patternIndex = SIM.PATTERN_INDEX[eff.pattern] !== undefined
      ? SIM.PATTERN_INDEX[eff.pattern] : 0;

    var txt = this.textObject();
    var textOn = !!(txt && txt.enabled);
    this.viewEnabled = this.viewCfg.enabled !== false;
    this.modeIndex = (eff.mode === 'text' && textOn) ? 1 : 0;

    // text colour: LUT sample ('palette') or a literal hex
    var style = (txt && txt.style) || {};
    var hex = (style.colour && style.colour !== 'palette') ? SIM.hexToRgb(style.colour) : null;
    this.textHex = hex ? hex : [1, 1, 1];
    this.textUseHex = !!hex;

    // reveal: restart whenever the text object changes, re-runnable on demand
    var revealMs = num(style.reveal, 0);
    var tk = JSON.stringify(txt);
    if (tk !== this.textObjKey) {
      this.textObjKey = tk;
      this.revealStart = -1;
    }

    this._syncLUT();
    this._syncText();
    this._syncImage();

    // `reveal` is milliseconds *per character*, so the total type-on window is
    // ms × characters; the shader only needs a normalised 0..1 progress.
    this.revealDur = (revealMs > 0 && this.textChars > 0)
      ? (revealMs * this.textChars) / 1000
      : 0;
  };

  /** 0..1 type-on progress; 1 when reveal is off or finished. */
  Instance.prototype._revealProgress = function () {
    if (!this.revealDur) return 1;
    if (this.revealStart < 0) this.revealStart = this.elapsed;
    var p = (this.elapsed - this.revealStart) / this.revealDur;
    return p < 0 ? 0 : (p > 1 ? 1 : p);
  };

  /** Re-run the type-on from the first character. */
  Instance.prototype.restartReveal = function () {
    this.revealStart = this.elapsed;
    return true;
  };

  Instance.prototype.setSettings = function (partial, opts) {
    if (partial && Object.keys(partial).length) {
      this.s = merge(this.s, partial);
      this._layout();
      this._syncDerived();
    }
    return this.getSettings();
  };

  /**
   * Show (or clear) the 9:16 window. `rect` is in canvas pixels at this page's scale; `null`
   * removes the fence. Snapping to whole cells happens here, once, so the sim and the streak
   * pass agree on the same rectangle.
   */
  Instance.prototype.setFence = function (rect) {
    // The server's shape is `{cells:{x,y,w,h}, px:{...}}`; the pane's (if one ever calls the
    // page directly) is the pixel rect. Either way, a window with a positive height is a window.
    // (A cell-count window — the server's shape — carries its own validity: a page's `grid` may
    // still be unset on the very first frame, so `fenceCells` is filled on the next layout.)
    var wholeCellWindow = Boolean(rect && rect.cells && num(rect.cells.h, 0) >= 8);
    if (wholeCellWindow) {
      this.fence = { cells: rect.cells, x: rect.cells.x, y: rect.cells.y, w: rect.cells.w, h: rect.cells.h };
      this.fenceOn = true;
      this._computeFence();
      return this.fence;
    }
    if (!rect || !(rect.h > 0)) {
      this.fence = null;
      this.fenceCells = null;
      this.fenceOn = false;
      this._computeFence();
      return this.fence;
    }
    this.fence = { x: num(rect.x, 0), y: num(rect.y, 0), w: num(rect.w, 0), h: num(rect.h, 0) };
    this.fenceOn = true;
    this._computeFence();
    return this.fence;
  };

  /** Snap `fence` to the grid's whole cells (cols/rows), clamped inside the wall. */
  Instance.prototype._computeFence = function () {
    this._dirty = true;      // every fence change reaches `setFence` through here
    var g = this.grid;
    if (!this.fenceOn || !this.fence || !g || !this.W) { this.fenceCells = null; return; }
    // The server sends cells already (the pane drags pixels, the server converts once, so both
    // the pane and the GPU speak the same unit). A page fed pixels by hand still works: a rect
    // whose `cells` flag is absent is divided down here.
    var c = this.fence.cells || null;
    var px = this.W / g.cols;
    var py = this.H / g.rows;
    var x0, y0, w, h;
    if (c && num(c.h, 0) < 8) {
      // A one- or two-cell window is a unit mix-up, not a frame: the pane sends 35x63 cells, and
      // pixels-as-cells would send ~1440. Fall through to the pixel branch, which divides them
      // by the pitch, rather than drawing a two-cell dot where the frame belongs.
      c = null;
    }
    if (c) {
      if (num(c.w, 0) > g.cols || num(c.h, 0) > g.rows) {
        this.fenceCells = null;
        this.fenceBad = { reason: `cells ${c.w}x${c.h} outside 8..${g.rows}`, cells: c };
        return;
      }
      this.fenceBad = null;
      x0 = Math.round(num(c.x, 0));
      y0 = Math.round(num(c.y, 0));
      w = Math.max(2, Math.round(num(c.w, 2)));
      h = Math.max(2, Math.round(num(c.h, 2)));
    } else {
      // No cells: the rect is in canvas pixels at this page's scale. The pane's rect is authored
      // at scale 1, so a page at 2x halves it before dividing by its own pitch.
      var sc = this.scale || 1;
      x0 = Math.round(this.fence.x / sc / px);
      y0 = Math.round(this.fence.y / sc / py);
      h = Math.max(2, Math.round(this.fence.h / sc / py));
      w = Math.max(2, Math.round(this.fence.w / sc / px));
    }
    x0 = clamp(x0, 0, Math.max(0, g.cols - 2));
    y0 = clamp(y0, 0, Math.max(0, g.rows - 2));
    w = clamp(w, 2, g.cols - x0);
    h = clamp(h, 2, g.rows - y0);
    // A window taller than it is wide is 9:16; pin the width to the height so the cell count
    // cannot drift into a near-miss on the wall's own pitch.
    var wantW = clamp(Math.round(h * (9 / 16) * (py / px)), 2, g.cols - x0);
    this.fenceCells = { x: x0, y: y0, w: wantW, h: h };
  };

  /**
   * The API name the engine's contract documents for the window. `fence` is in whole cells
   * (`{x,y,w,h}`); this keeps `setFence` as the internal name while a caller following
   * ENGINE-API.md gets the documented one.
   */
  Instance.prototype.setWindow = function (cells) {
    return this.setFence(cells && cells.w > 0 ? { cells: cells } : null);
  };

  Instance.prototype.getSettings = function () {
    return JSON.parse(JSON.stringify(this.s));
  };

  Instance.prototype.applyPreset = function (nameOrObject) {
    var preset = nameOrObject;
    this.label = typeof nameOrObject === 'string' ? nameOrObject : (this.label || 'custom');
    if (typeof nameOrObject === 'string') preset = PRESETS[nameOrObject] || {};
    // A preset re-specifies the *look*; keys it omits fall back to defaults.
    // The per-view content blocks are page state, not look, so they survive a
    // LOOK-key change: the deck must be able to restyle without clearing text.
    //
    // That rule has to hold for the *live* text too, not just for the block's
    // continued existence: a preset that carries `views` (e.g. `sign`) would
    // deep-merge its own `text` over the notice that is on air, and both the
    // rebuilt `mode` and the preset's `views.*.mode` would take the page out of
    // text mode.  Capture the on-air text and the mode flags before the rebuild
    // and put them back after it, so a look change only ever changes look.
    // Grid geometry is operator-owned, not look.  No preset carries a column
    // count, and the rebuild below falls back to DEFAULTS for every key the
    // preset omits — which snapped a deliberately fine 120-column wall back to
    // the 63-column default on the next preset change, so text that had just
    // been made legible went small and dotty again.  Carry the geometry across
    // unless the preset names it explicitly.
    var prevGrid = {};
    var GRID_KEYS = ['gridCols', 'gridColsPortrait', 'gridRows', 'cellShape'];
    for (var gki = 0; gki < GRID_KEYS.length; gki++) {
      var gk = GRID_KEYS[gki];
      if (Object.prototype.hasOwnProperty.call(this.s, gk) &&
          !(preset && Object.prototype.hasOwnProperty.call(preset, gk))) {
        prevGrid[gk] = this.s[gk];
      }
    }

    var wasText = this._textOnAir();
    var prevViews = this.s.views;
    var prevVB = (prevViews && prevViews[this.view]) || null;
    var liveText = wasText ? cloneJSON(prevVB.text) : undefined;
    var hadEnabled = !!(prevVB && Object.prototype.hasOwnProperty.call(prevVB, 'enabled'));
    var liveEnabled = hadEnabled ? prevVB.enabled : undefined;
    var hadViewMode = !!(prevVB && Object.prototype.hasOwnProperty.call(prevVB, 'mode'));
    var liveViewMode = hadViewMode ? prevVB.mode : undefined;

    this.s = merge(DEFAULTS, preset || {});
    // Presets saved before `imageOn` was a dim cannot say the picture was on; a recorded
    // revision is the only evidence they carry.
    if (!(preset && Object.prototype.hasOwnProperty.call(preset, 'imageOn')) &&
        Number(preset && preset.imageRev) > 0) {
      this.s.imageOn = 1;
    }
    for (var pk in prevGrid) {
      if (Object.prototype.hasOwnProperty.call(prevGrid, pk)) this.s[pk] = prevGrid[pk];
    }
    if (!(preset && preset.views)) {
      this.s.views = prevViews;
    } else {
      this.s.views = merge(prevViews || {}, preset.views);
    }

    if (wasText) {
      if (!this.s.views) this.s.views = {};
      if (!this.s.views[this.view]) this.s.views[this.view] = {};
      var nvb = this.s.views[this.view];
      if (liveText !== undefined) nvb.text = liveText; else delete nvb.text;
      if (hadEnabled) nvb.enabled = liveEnabled; else delete nvb.enabled;
      // Keep the view's own mode key exactly as it was: an absent key stays
      // absent, an explicit 'text' stays 'text'.
      if (hadViewMode) nvb.mode = liveViewMode; else delete nvb.mode;
      // The rebuilt top-level mode came from DEFAULTS/preset; the live text
      // still owns the page.
      this.s.mode = 'text';
    }

    this.palKey = '';
    this.textKey = '';
    this._layout();
    this._syncDerived();
    return this.getSettings();
  };

  // ── Per-frame uniforms ───────────────────────────────────────────────────

  Instance.prototype._drawSim = function (dt) {
    var gl = this.gl, s = this.eff || this.s, g = this.grid;
    var src = this.simTex[this.simCur];
    var dst = 1 - this.simCur;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[dst]);
    gl.viewport(0, 0, g.cols, g.rows);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progSim.p);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    i1(gl, this.progSim, 'u_prev', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    i1(gl, this.progSim, 'u_text', 1);

    f2(gl, this.progSim, 'u_grid', g.cols, g.rows);
    f2(gl, this.progSim, 'u_textSize', this.textSize[0], this.textSize[1]);
    f1(gl, this.progSim, 'u_time', this.time);
    f1(gl, this.progSim, 'u_dt', dt);
    f1(gl, this.progSim, 'u_speed', num(s.speed, 1));
    f1(gl, this.progSim, 'u_transition', num(s.transitionSpeed, 1));
    f1(gl, this.progSim, 'u_flash', num(s.flashDensity, 0.15));
    f1(gl, this.progSim, 'u_waveFreq', num(s.waveFrequency, 3));
    f1(gl, this.progSim, 'u_persistence', clamp(num(s.persistence, 0), 0, 0.99));
    f1(gl, this.progSim, 'u_textScroll', this.scrollCells);
    f1(gl, this.progSim, 'u_reveal', this._revealProgress());
    f1(gl, this.progSim, 'u_textHex', this.textUseHex ? 1 : 0);
    f1(gl, this.progSim, 'u_textScrollRate', textScrollRate(this.patternIndex));
    f1(gl, this.progSim, 'u_cdScale', this.floatCB ? 1.0 : 0.25);
    i1(gl, this.progSim, 'u_pattern', this.patternIndex);
    /* Intensity for the eyecandy patterns.  Derived from waveFrequency so the
       Wave frequency slider also tunes them, clamped so the wall never blows
       out and never goes invisible at the extremes of that slider. */
    f1(gl, this.progSim, 'u_bright',
       Math.max(0.45, Math.min(1.0, 0.55 + 0.09 * (this.s.waveFrequency || 3))));
    i1(gl, this.progSim, 'u_mode', this.modeIndex);
    // ── the fence ──────────────────────────────────────────────────────────
    // Off: w = 0 tells the shader to treat the whole wall as the pattern's grid, which is the
    // pre-fence behaviour down to the arithmetic. On: whole cells from `_computeFence`.
    var fc = (this.fenceOn && this.fenceCells) ? this.fenceCells : null;
    f2(gl, this.progSim, 'u_fence', fc ? fc.x : 0, fc ? fc.y : 0);
    f2(gl, this.progSim, 'u_fenceSize', fc ? fc.w : 0, fc ? fc.h : 0);
    f1(gl, this.progSim, 'u_fenceOn', fc ? 1 : 0);
    // The ring is the frame the operator sees on the wall: a step of full brightness so the
    // window reads as a lit border even over a dark pattern.
    f1(gl, this.progSim, 'u_fenceLight', fc ? 0.85 : 0);
    // Outside the window the wall keeps a dim trace of the pattern instead of going dead black:
    // the room still glows, but the eye goes to the 9:16 frame.
    f1(gl, this.progSim, 'u_outDim', clamp(num(s.fenceOutDim, 0.18), 0, 1));

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.simCur = dst;
    return this.simTex[dst];
  };

  Instance.prototype._drawScene = function (simTex) {
    var gl = this.gl, s = this.eff || this.s, g = this.grid;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.W, this.H);
    var bg = hexToRgb01(s.bgColor || '#05050f');
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);

    // ── streaks ──────────────────────────────────────────────────────────
    var streak = clamp(num(s.streakOpacity, 0), 0, 1);
    if (streak > 0.001) {
      gl.useProgram(this.progStreak.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, simTex);
      i1(gl, this.progStreak, 'u_sim', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      i1(gl, this.progStreak, 'u_lut', 1);
      f2(gl, this.progStreak, 'u_grid', g.cols, g.rows);
    // Streak geometry must use the *fence's* pitch inside the window, or the lit cells sit on
    // the whole-wall pitch and drift off the window's own edge by several cells.
    var fcs = (this.fenceOn && this.fenceCells) ? this.fenceCells : null;
    f2(gl, this.progStreak, 'u_fence', fcs ? fcs.x : 0, fcs ? fcs.y : 0);
    f2(gl, this.progStreak, 'u_fenceSize', fcs ? fcs.w : 0, fcs ? fcs.h : 0);
    f1(gl, this.progStreak, 'u_fenceOn', fcs ? 1 : 0);
      f2(gl, this.progStreak, 'u_canvas', this.W, this.H);
      f1(gl, this.progStreak, 'u_streak', streak);
      f1(gl, this.progStreak, 'u_hdrGain', num(s.hdrGain, 2.2));
      f3(gl, this.progStreak, 'u_textColor', this.textHex[0], this.textHex[1], this.textHex[2]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.cols * (g.rows - 1));
    }

    // ── LEDs ─────────────────────────────────────────────────────────────
    var ledSize = clamp(num(s.ledSize, 1), 0.1, 3);
    var radiusPx = 0.5 * ledSize * Math.min(g.pitchX, g.pitchY);
    var flare = clamp(num(s.flareIntensity, 0), 0, 1);
    var flareLen = clamp(num(s.flareLength, 1), 0.1, 4);
    var flarePx = radiusPx * 5 * flare * flareLen;
    var extentPx = Math.max(radiusPx * 1.55, flarePx * 0.95, 2);
    var extentCells = extentPx / Math.min(g.pitchX, g.pitchY);
    extentCells = clamp(extentCells, 0.2, 4);

    gl.useProgram(this.progLed.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, simTex);
    i1(gl, this.progLed, 'u_sim', 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex || null);
    i1(gl, this.progLed, 'u_image', 2);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    i1(gl, this.progLed, 'u_lut', 1);
    this._drawImageUniforms(s);
    f2(gl, this.progLed, 'u_grid', g.cols, g.rows);
    f1(gl, this.progLed, 'u_extent', extentCells);
    f2(gl, this.progLed, 'u_pxPerCell', g.pitchX, g.pitchY);
    f1(gl, this.progLed, 'u_radiusPx', radiusPx);
    f1(gl, this.progLed, 'u_ledSize', ledSize);
    f1(gl, this.progLed, 'u_flare', flare);
    f1(gl, this.progLed, 'u_flareLen', flareLen);
    f1(gl, this.progLed, 'u_flareRot', num(s.flareRotation, 0) * Math.PI / 180);
    f1(gl, this.progLed, 'u_hdrGain', num(s.hdrGain, 2.2));
    f1(gl, this.progLed, 'u_global', clamp(num(s.exposure, 1), 0.2, 3));
    f1(gl, this.progLed, 'u_streak', streak);
    f3(gl, this.progLed, 'u_textColor', this.textHex[0], this.textHex[1], this.textHex[2]);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.cols * g.rows);

    gl.disable(gl.BLEND);
  };

  Instance.prototype._drawBloom = function () {
    var gl = this.gl, s = this.eff || this.s;
    var b0 = this.bloom[0];

    // bright pass, scene → mip0
    gl.bindFramebuffer(gl.FRAMEBUFFER, b0.fbo);
    gl.viewport(0, 0, b0.w, b0.h);
    gl.useProgram(this.progBright.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    i1(gl, this.progBright, 'u_src', 0);
    f2(gl, this.progBright, 'u_texel', 1 / this.W, 1 / this.H);
    f1(gl, this.progBright, 'u_threshold', clamp(num(s.bloomThreshold, 0.7), 0, 2));
    f1(gl, this.progBright, 'u_knee', 0.12);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // downsample chain
    gl.useProgram(this.progDown.p);
    for (var i = 1; i < BLOOM_MIPS; i++) {
      var src = this.bloom[i - 1], dst = this.bloom[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      i1(gl, this.progDown, 'u_src', 0);
      f2(gl, this.progDown, 'u_texel', 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // upsample chain, additive
    gl.useProgram(this.progUp.p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    var radius = clamp(num(s.bloomRadius, 1), 0.1, 4);
    for (var j = BLOOM_MIPS - 1; j > 0; j--) {
      var srcT = this.bloom[j], dstT = this.bloom[j - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstT.fbo);
      gl.viewport(0, 0, dstT.w, dstT.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcT.tex);
      i1(gl, this.progUp, 'u_src', 0);
      f2(gl, this.progUp, 'u_texel', 1 / srcT.w, 1 / srcT.h);
      f1(gl, this.progUp, 'u_radius', radius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  };

  Instance.prototype._drawComposite = function () {
    var gl = this.gl, s = this.eff || this.s;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.progComp.p);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    i1(gl, this.progComp, 'u_scene', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
    i1(gl, this.progComp, 'u_bloom', 1);

    f2(gl, this.progComp, 'u_res', this.W, this.H);
    f1(gl, this.progComp, 'u_bloomStrength', clamp(num(s.bloom, 0.55), 0, 4));
    f1(gl, this.progComp, 'u_exposure', clamp(num(s.exposure, 1), 0.01, 8));
    f1(gl, this.progComp, 'u_saturation', clamp(num(s.saturation, 1), 0, 4));
    f1(gl, this.progComp, 'u_contrast', clamp(num(s.contrast, 1), 0.1, 4));
    f1(gl, this.progComp, 'u_lift', clamp(num(s.lift, 0), -1, 1));
    f1(gl, this.progComp, 'u_vignette', clamp(num(s.vignette, 0.35), 0, 1));
    f1(gl, this.progComp, 'u_grain', clamp(num(s.grain, 0.03), 0, 1));
    f1(gl, this.progComp, 'u_dither', num(s.dither, 1) >= 0.5 ? 1 : 0);
    f1(gl, this.progComp, 'u_aces', num(s.acsTonemap, 1) >= 0.5 ? 1 : 0);
    // A view switched off in the admin UI goes dark but keeps reporting: the
    // sim still ticks, the composite just multiplies the whole frame away.
    var dark = (num(s.blackout, 0) >= 0.5) || (this.viewCfg && this.viewCfg.enabled === false);
    f1(gl, this.progComp, 'u_blackout', dark ? 1 : 0);
    f1(gl, this.progComp, 'u_time', this.elapsed);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // ── GPU timing ────────────────────────────────────────────────────────────

  Instance.prototype._initTimerQueries = function () {
    this.queries = [];
    this.queryBusy = [];
    this.queryIdx = 0;
    this.gpuPending = [];
    if (!this.timerExt) return;
    var gl = this.gl;
    for (var i = 0; i < 4; i++) {
      this.queries.push(gl.createQuery());
      this.queryBusy.push(false);
    }
  };

  Instance.prototype._timerBegin = function () {
    if (!this.timerExt) return false;
    var gl = this.gl;
    if (this.queryBusy[this.queryIdx]) return false;
    gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.queries[this.queryIdx]);
    this._queryOpen = true;
    return true;
  };

  Instance.prototype._timerEnd = function () {
    if (!this.timerExt) return;
    var gl = this.gl;
    if (this._queryOpen) {
      gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this._queryOpen = false;
      this.queryBusy[this.queryIdx] = true;
      this.queryIdx = (this.queryIdx + 1) % this.queries.length;
    }
    var disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
    // collect anything already available
    for (var i = 0; i < this.queries.length; i++) {
      if (!this.queryBusy[i]) continue;
      var q = this.queries[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        var ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        this.queryBusy[i] = false;
        if (!disjoint && ns > 0) this._pushGpuSample(ns / 1e6);
      }
    }
  };

  Instance.prototype._pushGpuSample = function (ms) {
    this.gpuHist[this.gpuHistI] = ms;
    this.gpuHistI = (this.gpuHistI + 1) % this.gpuHist.length;
    if (this.gpuHistN < this.gpuHist.length) this.gpuHistN++;
    var sum = 0;
    for (var i = 0; i < this.gpuHistN; i++) sum += this.gpuHist[i];
    this.gpuMs = sum / Math.max(1, this.gpuHistN);

    if (this.benchState && this.benchState.collecting) {
      var b = this.benchState;
      if (b.count < b.capacity) { this.samples[b.count++] = ms; }
    }
  };

  /** Force a sync and time the submitted frame — fallback when no timer query. */
  Instance.prototype._syncProbe = function () {
    var gl = this.gl;
    var t0 = performance.now();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncBuf);
    var ms = performance.now() - t0;
    this._pushGpuSample(ms);
    return ms;
  };

  // ── Frame ────────────────────────────────────────────────────────────────

  /**
   * True when redrawing now would paint exactly what is already on the canvas.
   *
   * This is the whole idle predicate: every clause below is a thing that changes the picture
   * with time rather than with settings.  Anything that is not listed here is font/render
   * state, and a change to it raises `_dirty` instead.
   */
  Instance.prototype._canIdle = function (now) {
    if (this._dirty) return false;                       // a change is waiting to be drawn
    if (this.benchState) return false;                   // the bench counts drawn frames
    if (now < this._idleSettle) return false;            // the sim is still easing to the new look
    if (this.imgLoading > 0) return false;               // a picture is on the way in
    var look = this.eff || this.s;
    if (num(look.speed, 1) !== 0) return false;          // pattern clock advancing (`time`)
    if (num(look.grain, 0.03) > 0) return false;         // wall-clock noise — grade.js:168
    if (clamp(num(look.persistence, 0), 0, 0.99) > 0.001) return false; // trail decay needs frames
    if (this.revealDur > 0 &&                           // type-on running (or not started yet)
        (this.revealStart < 0 || (this.elapsed - this.revealStart) < this.revealDur)) return false;
    if (this.modeIndex && num(this.textStyle().scroll, 0) !== 0) return false; // marquee
    // `random` is the one pattern driven by real time instead of `u_time`: its cooldown
    // (sim.js:180, `cd -= u_dt * u_cdScale`) re-rolls cells every few seconds even at speed 0,
    // so it is a wall-clock renderer and must keep drawing.
    if (this.patternIndex === SIM.PATTERN_INDEX.random) return false;
    return true;
  };

  Instance.prototype._frame = function (now) {
    if (this.destroyed) return;
    // Always re-arm: the page must wake on the very next vsync after a change, and a skipped
    // frame still has to keep the loop alive (the agent heartbeat below rides it).
    this.raf = requestAnimationFrame(this._frameBound);

    var t0 = performance.now();
    if (!this.lastNow) this.lastNow = now;
    var dtReal = (now - this.lastNow) / 1000;
    this.lastNow = now;
    if (!isFinite(dtReal) || dtReal < 0) dtReal = 0;
    // A frame that follows idle skips can arrive with a whole idle interval behind it. The cap
    // is the step the sim was tuned at, so nothing downstream ever sees more than 0.1 s in one
    // step. `lastNow` moves on skipped frames too, so a resumed frame normally measures one
    // vsync; the cap is what stops a stalled page (backgrounded tab, long GC) from injecting a
    // big step, and `time` cannot jump from idling at all because idling requires speed 0
    // (dt × 0 = 0).
    dtReal = Math.min(dtReal, 0.1);

    // Second heartbeat clock.  The frame loop is the one clock a browser source
    // provably keeps (it is what paints the wall), so the /state post rides it
    // as well as the 2 s timer; `beat()` de-duplicates within 1.5 s.  Runs
    // before the `paused` return: a paused page is still a live page whose
    // state the deck must see.  Runs before the idle return too: dragging a look
    // must not cost the deck its heartbeat.
    if (this.agent) this.agent.beat('frame');

    if (this.paused) {
      this.cpuMs = performance.now() - t0;
      return;
    }

    // Duration deadline, checked on the frame as well as by the timer: if the
    // browser is starving timers (a backgrounded tab, or a long frame) the
    // revert still lands on the first frame past due.  Both paths are guarded
    // by `holds[view] === h`, so whichever runs first wins and neither repeats.
    // It runs before the idle return so an expiry still fires on a sleeping wall
    // (the revert raises `_dirty`, and the next frame draws it).
    this._holdTick();

    // ── idle throttle ────────────────────────────────────────────────────────
    // Skip while the last *draw* is younger than one idle interval, so a sleeping wall redraws at
    // IDLE_FPS instead of at vsync. The test has to be "too soon", not "due": a skip never
    // advances `_idleLast`, so testing "the interval has elapsed since the last draw" stays true
    // after the first skip and the wall then skips every frame forever (measured: 0 draws/s while
    // skipping at vsync). Nothing on the wall may be moving either — a dirty frame fails
    // `_canIdle`, so a change is drawn on the very next vsync at full rate; the settle window
    // keeps it at full rate until the sim's ease has landed, so an animated wall and a change look
    // exactly as they did before. A wall whose frames already cost more than the interval is
    // draw-bound and simply never skips.
    var rs = this.renderStats;
    var idleTooSoon = IDLE_FPS > 0 && (now - this._idleLast) < (1000 / IDLE_FPS);
    if (idleTooSoon && this._canIdle(now)) {
      rs.skipped++;
      rs.idle = true;
      return;
    }

    // fps EMA (frame-to-frame, includes rAF pacing).  Below the idle return on purpose: a
    // sleeping wall keeps reporting what it draws at, instead of reporting the idle rate.
    if (dtReal > 0.0001) {
      var inst = 1 / dtReal;
      this.fps = this.fps ? this.fps * 0.9 + inst * 0.1 : inst;
    }

    var consumedChange = this._dirty;

    this.elapsed += dtReal;
    var look = this.eff || this.s;
    this.time += dtReal * num(look.speed, 1);

    // Marquee scroll is `style.scroll` in px/s; the shader wants cell units, so
    // divide by the current cell pitch and keep it inside one bitmap period.
    var scrollPx = num(this.textStyle().scroll, 0);
    if (scrollPx !== 0 && this.modeIndex) {
      var period = Math.max(1, this.grid.cols * 2);
      this.scrollCells += scrollPx * dtReal / this.grid.pitchX;
      this.scrollCells = this.scrollCells % period;
      if (this.scrollCells < 0) this.scrollCells += period;
    }

    var timed = this._timerBegin();

    var simTex = this._drawSim(dtReal);
    this._drawScene(simTex);
    this._drawBloom();
    this._drawComposite();

    if (timed) this._timerEnd();
    else if (this.benchState || this.frameIndex % 20 === 0) this._syncProbe();

    this.frameIndex++;
    this.cpuMs = performance.now() - t0;

    // A drawn frame satisfies every pending change, and holds the loop awake long enough for
    // the sim's ease to reach its target (IDLE_SETTLE_MS) before it may sleep again.
    rs.drawn++;
    rs.idle = false;
    this._dirty = false;
    this._idleLast = now;
    if (consumedChange) this._idleSettle = now + IDLE_SETTLE_MS;

    // ~2 Hz stats callback
    this.statsAccum += dtReal;
    if (this.statsAccum >= 0.5) {
      this.statsAccum = 0;
      if (this.onStats) {
        try { this.onStats(this.diag()); } catch (e) { /* never break the loop */ }
      }
    }

    if (this.benchState && this.benchState.collecting) {
      this.benchState.frames++;
      if (this.benchState.frames >= this.benchState.want) this._finishBench();
    }
  };

  Instance.prototype.diag = function () {
    var gl = this.gl;
    var renderer = '', vendor = '';
    if (this.debugInfo) {
      renderer = gl.getParameter(this.debugInfo.UNMASKED_RENDERER_WEBGL) || '';
      vendor = gl.getParameter(this.debugInfo.UNMASKED_VENDOR_WEBGL) || '';
    } else {
      renderer = gl.getParameter(gl.RENDERER) || '';
      vendor = gl.getParameter(gl.VENDOR) || '';
    }
    return {
      renderer: renderer,
      vendor: vendor,
      webgl2: true,
      floatCB: !!this.floatCB,
      canvas: [this.W, this.H],
      view: this.view,
      ratio: this.ratio,
      cols: this.grid.cols,
      rows: this.grid.rows,
      fps: Math.round(this.fps * 10) / 10,
      gpuMs: Math.round(this.gpuMs * 100) / 100,
      cpuMs: Math.round(this.cpuMs * 100) / 100,
      timerQuery: !!this.timerExt,
      textMs: Math.round(this.textMs * 1000) / 1000,
      textFit: this.textFit,
      textRasters: this.textRasterCount,
      reveal: Math.round(this._revealProgress() * 1000) / 1000,
      blackout: num(this.s.blackout, 0) >= 0.5,
      mode: this.modeIndex ? 'text' : 'pattern',
      viewEnabled: this.viewEnabled,
      hold: (function () {
        var h = this.holds[this.view];
        if (!h) return null;
        return { view: this.view, seconds: h.secs, remainingMs: Math.max(0, h.dueAt - Date.now()) };
      }).call(this),
      preset: this.label || null,
      agent: this.agent ? this.agent.status() : null
    };
  };

  // ── Bench ────────────────────────────────────────────────────────────────

  Instance.prototype.bench = function (frames) {
    var self = this;
    var n = clamp(Math.round(num(frames, 600)), 30, 8000);
    if (this.benchState) return this.benchState.promise;

    var state = {
      want: n, frames: 0, count: 0, capacity: Math.min(n + 8, this.samples.length),
      collecting: true
    };
    state.promise = new Promise(function (resolve) { state.resolve = resolve; });
    this.benchState = state;
    return state.promise;
  };

  Instance.prototype._finishBench = function () {
    var st = this.benchState;
    st.collecting = false;
    var n = st.count;
    var arr = Array.prototype.slice.call(this.samples.subarray(0, n));
    arr.sort(function (a, b) { return a - b; });
    var pick = function (q) {
      if (!arr.length) return 0;
      var i = clamp(Math.round(q * (arr.length - 1)), 0, arr.length - 1);
      return arr[i];
    };
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    var res = {
      p50: Math.round(pick(0.5) * 1000) / 1000,
      p95: Math.round(pick(0.95) * 1000) / 1000,
      mean: Math.round((sum / Math.max(1, arr.length)) * 1000) / 1000,
      min: Math.round((arr[0] || 0) * 1000) / 1000,
      max: Math.round((arr[arr.length - 1] || 0) * 1000) / 1000,
      frames: st.frames,
      samples: n,
      fps: Math.round(this.fps * 10) / 10,
      cpuMs: Math.round(this.cpuMs * 100) / 100,
      canvas: [this.W, this.H],
      view: this.view,
      ratio: this.ratio,
      cols: this.grid.cols,
      rows: this.grid.rows,
      timerQuery: !!this.timerExt,
      textMs: Math.round(this.textMs * 1000) / 1000,
      preset: this.label || null
    };
    this.benchState = null;
    if (st.resolve) st.resolve(res);
    if (this.onBench) { try { this.onBench(res); } catch (e) { /* ignore */ } }
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────

  Instance.prototype.pause = function () { this.paused = true; };
  Instance.prototype.resume = function () { this.paused = false; this.lastNow = 0; this._dirty = true; };

  Instance.prototype.captureDataURL = function (maxWidth) {
    // Render one frame and grab it in the same task; the GL buffer is still intact.
    if (this.paused) this._frame(this.lastNow || performance.now());
    var w = this.W, h = this.H;
    var scale = Math.min(1, (maxWidth || 960) / w);
    var cw = Math.max(2, Math.round(w * scale));
    var ch = Math.max(2, Math.round(h * scale));
    if (!this.shotCanvas) {
      this.shotCanvas = document.createElement('canvas');
      this.shotCtx = this.shotCanvas.getContext('2d');
    }
    this.shotCanvas.width = cw;
    this.shotCanvas.height = ch;
    this.shotCtx.drawImage(this.canvas, 0, 0, cw, ch);
    return this.shotCanvas.toDataURL('image/png');
  };

  Instance.prototype.destroy = function () {
    this.destroyed = true;
    this.cancelHolds();          // a duration timer must not fire after teardown
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.agent) this.agent.destroy();
    var gl = this.gl;
    this._freeTargets();
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    if (this.textTex) gl.deleteTexture(this.textTex);
    var progs = [this.progSim, this.progLed, this.progStreak, this.progBright,
                 this.progDown, this.progUp, this.progComp];
    for (var i = 0; i < progs.length; i++) if (progs[i]) gl.deleteProgram(progs[i].p);
    if (this.queries) for (var j = 0; j < this.queries.length; j++) gl.deleteQuery(this.queries[j]);
    if (this.vao) gl.deleteVertexArray(this.vao);
  };

  // ── Optional display duration (text.send `duration`) ──────────────────────
  // `text.send` may carry `duration` in seconds (1..600; absent or 0 means hold
  // indefinitely).  After that long the page puts its view back exactly as it
  // was immediately before the send: the same mode and the previous text item,
  // `text.enabled` included.  A second send replaces text and timer; text.clear,
  // text.enabled{on:false} and blackout.on cancel the timer; one timer per view;
  // nothing is persisted and nothing is reported to the agent.

  /**
   * Snapshot the parts of this view that `text.send` overwrites.  Taken fresh on
   * every send: the contract reverts to "the mode it had immediately before *the
   * send*", so a second send's revert target is the first send's state, and its
   * own timer is the only one left running (the first was replaced).
   */
  Instance.prototype._holdSnapshot = function () {
    var txt = this.textObject();
    var vb = this.s.views && this.s.views[this.view];
    return {
      view: this.view,
      mode: this.s.mode,
      // `undefined` means the view block had no `mode` key: restoring must not
      // invent one, or the page would lose the top-level mode it inherited.
      viewMode: (vb && vb.mode !== undefined) ? vb.mode : undefined,
      text: txt ? JSON.parse(JSON.stringify(txt)) : null,
      // The view's whole look, captured key-for-key.  A revert must put back
      // exactly what was there: `undefined` deletes the key again (never
      // inventing `inheritLook:true` or an empty `look`), a present value is
      // restored byte-identically.
      viewLook: (vb && vb.look !== undefined) ? cloneJSON(vb.look) : undefined,
      viewInheritLook: (vb && vb.inheritLook !== undefined) ? vb.inheritLook : undefined,
      viewPattern: (vb && vb.pattern !== undefined) ? cloneJSON(vb.pattern) : undefined,
      // The per-send overrides this text carries, resolved at send time (null =
      // that arg carried no override).  Kept on the snapshot because the mid-text
      // rule needs to know which dimensions the hold still owns.
      sendPreset: null,
      sendPattern: null,
      // The look the text that is about to be replaced was itself overriding
      // from, so a revert can restore that notice *and* the look it was sent on.
      textLookBase: (this.textLook && this.textLook.view === this.view) ? this.textLook.snap : null,
      // A dimension the operator changed while the text was up.  Cleared for
      // revert: their newer choice must not be clobbered by the older state.
      lookDropped: false,
      patternDropped: false
    };
  };

  Instance.prototype._cancelHold = function (view) {
    var v = (view === 'portrait' || view === 'landscape') ? view : this.view;
    var h = this.holds[v];
    if (h && h.timer) clearTimeout(h.timer);
    this.holds[v] = null;
  };

  /**
   * Cancel a pending timer *and* undo the send it belonged to.  Used by
   * `blackout.on`: the notice's time is over, so the view goes back to the state
   * the send found, which is also what gets reported to the agent.
   */
  Instance.prototype._endHold = function (why) {
    var h = this.holds[this.view];
    if (!h) return false;
    this._cancelHold();
    try { this._restoreHold(h.snap); } catch (e) { if (this.debug) console.warn('[ledwall] hold revert failed', e); }
    this.lastHold = { view: this.view, secs: h.secs, at: Date.now(), why: why || 'cancelled' };
    if (this.onHoldRevert) { try { this.onHoldRevert(this.lastHold); } catch (e2) { /* ignore */ } }
    return true;
  };

  /** Cancel every pending duration timer (teardown, reload, pagehide). */
  Instance.prototype.cancelHolds = function () {
    this._cancelHold('portrait');
    this._cancelHold('landscape');
  };

  /** Put the view back the way the send found it (mode + previous text item). */
  Instance.prototype._restoreHold = function (snap) {
    var view = snap.view;
    if (!this.s.views) this.s.views = {};
    if (!this.s.views[view]) this.s.views[view] = {};
    // Restore both mode scopes: `text.send` writes the top-level `mode` *and*
    // the view block's (the block's wins in _resolveView), so undoing it means
    // putting both back — and *removing* the block key when it was absent.
    this.s.mode = snap.mode;
    if (snap.viewMode === undefined) delete this.s.views[view].mode;
    else this.s.views[view].mode = snap.viewMode;
    if (snap.text) this.s.views[view].text = JSON.parse(JSON.stringify(snap.text));
    else delete this.s.views[view].text;
    // The look the send may have overridden goes back too — unless the operator
    // changed that dimension while the text was up (see _noteLookCommand).
    if (!snap.lookDropped) this._restoreLookParts(snap);
    if (!snap.patternDropped) this._restorePatternPart(snap);
    this.textLook = null;
    // A text that was already up when this send landed carried its own look
    // override; restoring that text means restoring its override too, or the
    // revert would show the old notice under the baseline look and `/state`
    // would report a preset that is not being applied.
    this._reapplyTextLook(snap);
    this._syncDerived();
  };

  /**
   * Re-apply the look/pattern a restored text recorded for itself, on top of the
   * look its own send found (`snap.textLookBase`), so a revert onto a notice
   * that was itself an override does not leave that override welded to the view
   * for ever.
   *
   * If the operator changed either dimension while the *later* text was up
   * (`lookDropped` / `patternDropped`), their choice wins outright: nothing is
   * re-applied and the restored text loses the recorded keys, so `/state`
   * cannot claim an override that is not on the wall.
   */
  Instance.prototype._reapplyTextLook = function (holdSnap) {
    var txt = this.textObject();
    var dropped = !!(holdSnap && (holdSnap.lookDropped || holdSnap.patternDropped));
    if (!txt || !txt.enabled || dropped) {
      this.textLook = null;
      this._stripTextOverride('preset');
      this._stripTextOverride('pattern');
      return false;
    }
    var preset = (typeof txt.preset === 'string' && PRESETS[txt.preset]) ? txt.preset : null;
    var pattern = (typeof txt.pattern === 'string' && SIM.PATTERN_INDEX[txt.pattern] !== undefined) ? txt.pattern : null;
    if (!preset && !pattern) { this.textLook = null; return false; }
    var snap = (holdSnap && holdSnap.textLookBase) || this._lookSnapNow();
    this._applySendLook(preset, pattern, snap);
    this.textLook = { view: this.view, snap: snap };
    return true;
  };

  /**
   * Restore `views.<view>.look` / `inheritLook` from a hold snapshot.  Keys the
   * snapshot did not carry are *removed* rather than filled with a default: a
   * view that had no override before the send must have no override after it.
   */
  Instance.prototype._restoreLookParts = function (snap) {
    this._dirty = true;
    var view = snap.view;
    if (!this.s.views) this.s.views = {};
    if (!this.s.views[view]) this.s.views[view] = {};
    var vb = this.s.views[view];
    if (snap.viewLook === undefined) delete vb.look;
    else vb.look = cloneJSON(snap.viewLook);
    if (snap.viewInheritLook === undefined) delete vb.inheritLook;
    else vb.inheritLook = snap.viewInheritLook;
    return vb;
  };

  Instance.prototype._restorePatternPart = function (snap) {
    this._dirty = true;
    var view = snap.view;
    if (!this.s.views) this.s.views = {};
    if (!this.s.views[view]) this.s.views[view] = {};
    var vb = this.s.views[view];
    if (snap.viewPattern === undefined) delete vb.pattern;
    else vb.pattern = cloneJSON(snap.viewPattern);
    return vb;
  };

  // ── text.send look / pattern overrides ────────────────────────────────────
  // `text.send` may name the preset the notice is shown on and the pattern it
  // animates, per view, for the life of that text.  It writes the same per-view
  // look override `preset.set`-by-view uses (`views.<view>.look` +
  // `inheritLook:false`), so the global look and the other view are untouched.

  /** Preset name this view is showing now (the view's own override, else label). */
  Instance.prototype._currentLookName = function () {
    var vb = this.s.views && this.s.views[this.view];
    if (vb && vb.inheritLook === false && vb.look && typeof vb.look === 'object' &&
        typeof vb.look.preset === 'string' && PRESETS[vb.look.preset]) {
      return vb.look.preset;
    }
    return this.label || null;
  };

  /** Pattern name this view is showing now. */
  Instance.prototype._currentPatternName = function () {
    var p = (this.eff || this.s).pattern;
    return (SIM.PATTERN_INDEX[p] !== undefined && p !== undefined) ? p : null;
  };

  /** One debug line per distinct problem; a bad arg must never spam the console. */
  Instance.prototype._warnOnce = function (msg) {
    this._warned = this._warned || Object.create(null);
    if (this._warned[msg]) return;
    this._warned[msg] = 1;
    if (typeof console !== 'undefined' && console.warn) console.warn('[ledwall] ' + msg);
  };

  /**
   * `text.send` `preset` → a concrete preset name, or null for "no override".
   * Absent, empty and `'live'` mean no override; `'random'` resolves once, now,
   * to a name other than the one this view is showing.  An unknown name is
   * ignored with one debug line — the send still delivers the text.
   */
  Instance.prototype._resolveSendPreset = function (raw) {
    if (raw === undefined || raw === null) return null;
    var name = String(raw).trim();
    if (!name || name === 'live') return null;
    if (name === 'random') {
      var cur = this._currentLookName();
      var out = pickOther(Object.keys(PRESETS), cur ? [cur] : []);
      if (!out) this._warnOnce('text.send: no preset differs from "' + cur + '"; preset override ignored');
      return out;
    }
    if (!PRESETS[name]) {
      this._warnOnce('text.send: unknown preset "' + name + '"; preset override ignored');
      return null;
    }
    return name;
  };

  /**
   * `text.send` `pattern` → a concrete pattern name, or null for "no override".
   * `'random'` excludes the literal `random` pattern *and* the pattern this view
   * is showing; a concrete name must be in SIM.PATTERNS and not `'random'`
   * (that word means "pick one", never the pattern of that name).
   */
  Instance.prototype._resolveSendPattern = function (raw) {
    if (raw === undefined || raw === null) return null;
    var name = String(raw).trim();
    if (!name || name === 'live') return null;
    if (name === 'random') {
      var cur = this._currentPatternName();
      var pool = [];
      for (var i = 0; i < SIM.PATTERNS.length; i++) {
        if (SIM.PATTERNS[i] !== 'random') pool.push(SIM.PATTERNS[i]);
      }
      var out = pickOther(pool, cur ? [cur] : []);
      if (!out) this._warnOnce('text.send: no pattern differs from "' + cur + '"; pattern override ignored');
      return out;
    }
    if (SIM.PATTERN_INDEX[name] === undefined) {
      this._warnOnce('text.send: unknown pattern "' + name + '"; pattern override ignored');
      return null;
    }
    return name;
  };

  /**
   * Just the look/pattern keys of this view, in the shape a snapshot uses.
   * `undefined` means the key was absent and a restore must remove it again.
   */
  Instance.prototype._lookSnapNow = function () {
    var vb = this.s.views && this.s.views[this.view];
    return {
      view: this.view,
      viewLook: (vb && vb.look !== undefined) ? cloneJSON(vb.look) : undefined,
      viewInheritLook: (vb && vb.inheritLook !== undefined) ? vb.inheritLook : undefined,
      viewPattern: (vb && vb.pattern !== undefined) ? cloneJSON(vb.pattern) : undefined,
      lookDropped: false,
      patternDropped: false
    };
  };

  /**
   * The snapshot the live text's look override reverts to: the pending hold's
   * (a replacing send keeps the state before the *first* send) or, for an
   * untimed text, the look recorded when the override was first written.
   */
  Instance.prototype._textLookSnap = function () {
    var h = this.holds[this.view];
    if (h && h.snap) return h.snap;
    if (this.textLook && this.textLook.view === this.view) return this.textLook.snap;
    return this._lookSnapNow();
  };

  /**
   * A new send's revert target is the state immediately before *that* send, so
   * a dimension the operator changed mid-text is re-baselined to what is on the
   * wall right now instead of the older pre-text state.
   */
  Instance.prototype._rebaselineDroppedLook = function (snap) {
    if (!snap) return snap;
    var vb = this.s.views && this.s.views[this.view];
    if (snap.lookDropped) {
      snap.viewLook = (vb && vb.look !== undefined) ? cloneJSON(vb.look) : undefined;
      snap.viewInheritLook = (vb && vb.inheritLook !== undefined) ? vb.inheritLook : undefined;
      snap.lookDropped = false;
    }
    if (snap.patternDropped) {
      snap.viewPattern = (vb && vb.pattern !== undefined) ? cloneJSON(vb.pattern) : undefined;
      snap.patternDropped = false;
    }
    return snap;
  };

  /**
   * Write the send's override onto the view.  Starts from the snapshot the send
   * will revert to, so a second send does not layer its override on the first
   * one's: "no arg on the replacing send" really means "no override".
   */
  Instance.prototype._applySendLook = function (preset, pattern, snap) {
    if (!this.s.views) this.s.views = {};
    if (!this.s.views[this.view]) this.s.views[this.view] = {};
    var vb = this.s.views[this.view];
    if (!snap.lookDropped) this._restoreLookParts(snap);
    if (!snap.patternDropped) this._restorePatternPart(snap);
    if (preset) {
      // A preset is the whole look, its own default pattern included, so the
      // view's pattern key would mask it — drop it here; the snapshot still
      // carries the value the revert restores.
      vb.inheritLook = false;
      vb.look = { preset: preset };
      delete vb.pattern;
    }
    if (pattern) vb.pattern = pattern;
    return vb;
  };

  /** Remove this text's recorded override for one dimension (`preset`|`pattern`). */
  Instance.prototype._stripTextOverride = function (kind) {
    var txt = this.textObject();
    if (txt && txt[kind] !== undefined) delete txt[kind];
  };

  /**
   * Release the text's look override when the text ends without a revert timer
   * (`text.clear`, `text.enabled{on:false}`) and on `blackout.on` — the look
   * goes back to what the view had before the override, respecting any
   * dimension the operator changed mid-text.
   */
  Instance.prototype._releaseTextLook = function () {
    var h = this.holds[this.view];
    var snap = (h && h.snap) || (this.textLook && this.textLook.view === this.view ? this.textLook.snap : null);
    if (!snap) return false;
    if (!snap.lookDropped) this._restoreLookParts(snap);
    if (!snap.patternDropped) this._restorePatternPart(snap);
    this._stripTextOverride('preset');
    this._stripTextOverride('pattern');
    this.textLook = null;
    return true;
  };

  /**
   * Rule: a look/pattern command that lands while a text is up is the
   * operator's newest choice and beats the hold.  The send's override for that
   * dimension is released now (so the command is actually visible), and the
   * dimension is marked dropped so a later revert does not put the older state
   * back over their choice.
   */
  Instance.prototype._noteLookCommand = function (cmd) {
    var isPreset = (cmd === 'preset.set' || cmd === 'preset.next' || cmd === 'preset.prev' ||
                    cmd === 'preset.save');
    // `look.pattern` is the animation-only half of a look change, so it is a pattern command;
    // `look.palette` is a colour change and touches neither dimension (a palette already
    // reaches text cells live through the LUT, see sim.js — no override to release).
    var isPattern = (cmd === 'pattern.set' || cmd === 'pattern.next' || cmd === 'pattern.prev' ||
                     cmd === 'look.pattern');
    if (!isPreset && !isPattern) return false;
    var h = this.holds[this.view];
    var snap = (h && h.snap) || (this.textLook && this.textLook.view === this.view ? this.textLook.snap : null);
    if (!snap) return false;
    if (isPattern) {
      if (snap.patternDropped) return false;
      this._restorePatternPart(snap);
      snap.patternDropped = true;
      this._stripTextOverride('pattern');
      return true;
    }
    var touched = false;
    if (!snap.lookDropped) {
      this._restoreLookParts(snap);
      snap.lookDropped = true;
      touched = true;
    }
    if (!snap.patternDropped) {
      // The preset's own pattern must not mask the operator's preset either.
      this._restorePatternPart(snap);
      snap.patternDropped = true;
      touched = true;
    }
    if (touched) {
      this._stripTextOverride('preset');
      this._stripTextOverride('pattern');
    }
    return touched;
  };

  Instance.prototype._armHold = function (view, seconds, snap) {
    var self = this;
    var h = {
      view: view, secs: seconds,
      dueAt: Date.now() + Math.round(seconds * 1000),
      snap: snap, timer: 0
    };
    h.timer = setTimeout(function () { self._fireHold(view, h); }, Math.round(seconds * 1000));
    this.holds[view] = h;
    return h;
  };

  /** Revert one pending hold.  Idempotent: a fired or cancelled hold does nothing. */
  Instance.prototype._fireHold = function (view, h) {
    if (this.destroyed) return false;
    if (this.holds[view] !== h) return false;      // cancelled or superseded
    this.holds[view] = null;
    if (h.timer) { clearTimeout(h.timer); h.timer = 0; }
    try { this._restoreHold(h.snap); } catch (e) { /* keep rendering */ }
    // The view just changed with no command behind it, so nothing else would
    // tell the agent: without this the deck keeps showing the held text forever
    // (the heartbeat only refreshes counters, and a silent/broken POST path
    // leaves the old text on the deck).  Report the restored state at once.
    if (this.agent) this.agent.pushState();
    // Diagnostics only: lets boot.js report the revert (the report stream, never
    // the agent) so its timing can be measured instead of inferred.
    this.lastHold = { view: view, secs: h.secs, at: Date.now() };
    if (this.onHoldRevert) { try { this.onHoldRevert(this.lastHold); } catch (e2) { /* ignore */ } }
    return true;
  };

  /** Frame-side deadline check; see _frame. */
  Instance.prototype._holdTick = function () {
    var now = Date.now();
    for (var v in this.holds) {
      var h = this.holds[v];
      if (h && now >= h.dueAt) this._fireHold(v, h);
    }
  };

  // ── Command bus (agent → page) ────────────────────────────────────────────

  // Deck cycling order. `sign` was a text behaviour bolted onto the preset bank and is gone:
  // it carried no look of its own, so `preset.next` landed on a preset that did not exist and
  // the wall flickered through an empty look. Operator-saved presets are appended after these.
  var PRESET_ORDER = ['neonwave', 'arctic', 'chase', 'bassline', 'ember'];

  /**
   * One command, from the deck through services/ledwall-agent.  Returns
   * `{ok, changed, note}`; never throws — a malformed command is reported, not
   * fatal, because the page must keep rendering whatever the agent does.
   */
  Instance.prototype.applyCommand = function (cmd, args) {
    // A command addressed to the other view is not ours: the bus filters by
    // `?view=`, but the envelope's own view wins when it is explicit.
    if (args && typeof args.view === 'string' &&
        args.view !== 'both' && args.view !== this.view) {
      return { ok: true, changed: false, note: 'ignored: other view', cmd: cmd };
    }
    var a = (args && typeof args === 'object') ? args : {};
    var self = this;
    var changed = false;
    var note = 'applied';

    // A command may target one view or `both`. Every page implements every
    // command, so an off-target command is a normal no-op, not an error.
    if (a.view && a.view !== 'both' && a.view !== this.view) {
      if (this.onCommand) { try { this.onCommand(cmd, a); } catch (e0) { /* ignore */ } }
      return { ok: false, changed: false, cmd: cmd, note: 'ignored: for ' + a.view };
    }

    function bump(field, delta, lo, hi, dflt) {
      var cur = num(self.s[field], dflt);
      var v = (a.set !== undefined) ? num(a.set, cur) : cur + num(delta, 0);
      self._patchField(field, clamp(v, lo, hi));
      changed = true;
    }

    try {
      // A look/pattern command that lands while a text is up is the operator's
      // newest choice: release the send's override for that dimension first, so
      // the command is visible, and drop it from the snapshot so the revert
      // cannot put the older look back over their choice.
      this._noteLookCommand(cmd);
      switch (cmd) {
        case 'preset.next':
        case 'preset.prev': {
          var order = PRESET_ORDER.filter(function (n) { return !!PRESETS[n]; });
          savedPresetList().forEach(function (n) {
            if (order.indexOf(n) < 0) order.push(n);
          });
          if (!order.length) { note = 'ignored: no presets'; break; }
          var i = order.indexOf(this.label);
          var d = cmd === 'preset.next' ? 1 : -1;
          var next = order[(((i < 0 ? 0 : i) + d) % order.length + order.length) % order.length];
          this.applyPreset(next);
          changed = true;
          break;
        }
        case 'preset.set': {
          if (!a.name) { note = 'ignored: no name'; break; }
          var setName = String(a.name);
          this.applyPreset(setName);
          changed = true;
          // The server writes its document from the control pane, not from this page, so a preset
          // applied here has to be handed back: otherwise the look lives only in this engine's
          // memory and the next `state.snapshot` puts the document's (pre-load) values back.
          // Everything the preset touched is sent, omissions included — a preset that omits a
          // dimension means "default", and the document has to agree.
          try {
            if (typeof this._persistLook === 'function') {
              var lk = this.getSettings();
              // Every dimension the preset carries is handed back, omissions included. The
              // server drops the ones its document does not own (`mode` is page state); sending
              // the whole set keeps this side free of a second schema to keep in step.
              var out = {};
              PRESET_DIMS.forEach(function (f) {
                if (lk[f] !== undefined) out[f] = lk[f];
              });
              out.preset = setName;
              // Keep the page's own view of the document quiet until this write lands: the
              // snapshot it triggers is the one that must win, not one already in flight.
              var self2 = this;
              this.presetLoadingUntil = Date.now() + 1500;
              this._persistLook(out).then(function (ok) {
                // Once the document has the preset, the page may follow frames again.
                if (ok) self2.presetLoadingUntil = 0;
              });
            }
          } catch (e1) { note = 'applied; persist threw: ' + (e1 && e1.message); }
          break;
        }

        case 'preset.save': {
          // Capture the look the wall is showing *now* as a named preset. Only the look
          // dimensions a preset can carry are copied: grid geometry is operator-owned and a
          // pool record is never read here (presets must not touch text-mode message pools).
          if (!a.name) { note = 'ignored: no name'; break; }
          var savedName = String(a.name);
          var saved = {};
          PRESET_DIMS.forEach(function (f) {
            if (self.s[f] !== undefined) saved[f] = cloneJSON(self.s[f]);
          });
          this.savedPresets[savedName] = saved;
          applySavedPresets(this.savedPresets);
          this._patchField('preset', savedName);
          changed = true;
          note = 'saved:' + savedName;
          break;
        }

        case 'look.palette':
          // Palette is the *ramp only*: which colours the LEDs emit. The pattern (what the
          // cells do over time) and every other look dimension stay exactly as they are.
          if (!a.name && a.delta === undefined && a.set === undefined) { note = 'ignored: no name'; break; }
          if (a.name !== undefined) {
            if (!PALETTES[String(a.name)]) { note = 'ignored: unknown palette'; break; }
            this._patchField('palette', String(a.name));
          } else {
            var pOrder = Object.keys(PALETTES);
            var pi = pOrder.indexOf(this.s.palette);
            if (pi < 0) pi = 0;
            if (a.set !== undefined) {
              var si = Math.round(num(a.set, 0));
              pi = ((si % pOrder.length) + pOrder.length) % pOrder.length;
            } else {
              pi = (pi + (num(a.delta, 1) >= 0 ? 1 : -1) + pOrder.length) % pOrder.length;
            }
            this._patchField('palette', pOrder[pi]);
          }
          changed = true;
          break;

        case 'look.pattern':
          // Pattern is *animation only*: the same palette keeps the same colours while the
          // cells change what they do. Mode is left alone, so a live text stays on air.
          if (!a.name && a.delta === undefined && a.set === undefined) { note = 'ignored: no name'; break; }
          var patKeepText = this._textOnAir();
          if (a.name !== undefined) {
            if (SIM.PATTERN_INDEX[String(a.name)] === undefined) { note = 'ignored: unknown pattern'; break; }
            this._setViewField('pattern', SIM.PATTERNS[SIM.PATTERN_INDEX[String(a.name)]]);
          } else {
            var pIdx = this.patternIndex;
            if (a.set !== undefined) {
              var sIdx = Math.round(num(a.set, 0));
              pIdx = ((sIdx % SIM.PATTERNS.length) + SIM.PATTERNS.length) % SIM.PATTERNS.length;
            } else {
              pIdx = (pIdx + (num(a.delta, 1) >= 0 ? 1 : -1) + SIM.PATTERNS.length) % SIM.PATTERNS.length;
            }
            this._setViewField('pattern', SIM.PATTERNS[pIdx]);
          }
          if (!patKeepText) this._setViewField('mode', 'pattern');
          changed = true;
          break;

        case 'pattern.next':
        case 'pattern.set': {
          var idx;
          if (cmd === 'pattern.set') {
            if (SIM.PATTERN_INDEX[a.name] === undefined) { note = 'ignored: unknown pattern'; break; }
            idx = SIM.PATTERN_INDEX[a.name];
          } else {
            idx = (this.patternIndex + (cmd === 'pattern.next' ? 1 : -1) + SIM.PATTERNS.length) %
                  SIM.PATTERNS.length;
          }
          // The pattern is the look *under* the page.  A text on air keeps the
          // page in text mode: only the pattern the text renders with may
          // change, never the mode that puts it on the wall.  Forcing
          // `mode:'pattern'` here (as this branch used to) is what made
          // `pattern.set` blank a live notice in portrait.
          var keepText = this._textOnAir();
          this._setViewField('pattern', SIM.PATTERNS[idx]);
          if (!keepText) this._setViewField('mode', 'pattern');
          changed = true;
          break;
        }

        case 'text.send': {
          if (!a.item || typeof a.item !== 'object') { note = 'ignored: no item'; break; }
          var item = a.item;
          // Duration snapshot must be taken before the send mutates the view.
          // While a hold is pending the visible state is already synthetic, so a
          // second send *keeps the original snapshot*: its revert target stays
          // the state before the first send, not "text mode showing send #1",
          // which would strand the view in text with a stale item.
          var pendingHold = this.holds[this.view];
          var holdSnap = (pendingHold && pendingHold.snap) || this._holdSnapshot();
          var holdS = num(a.duration, 0);
          holdS = (isFinite(holdS) && holdS > 0) ? clamp(holdS, 1, 600) : 0;
          // Which look and which pattern this text sits on; `'random'` is
          // resolved here, once, against what this view is showing now.  The
          // look reverts to the pending hold's snapshot (state before the first
          // send) or, for an untimed text, to the look recorded when this text's
          // override was first written.
          var ovPreset = this._resolveSendPreset(a.preset);
          var ovPattern = this._resolveSendPattern(a.pattern);
          var lookSnap = this._textLookSnap();
          this._rebaselineDroppedLook(lookSnap);
          holdSnap.sendPreset = ovPreset;
          holdSnap.sendPattern = ovPattern;
          var txt = JSON.parse(JSON.stringify(this.textObject() || {}));
          txt.title = item.title || '';
          txt.source = item.id ? { kind: 'pool', id: item.id } : { kind: 'inline' };
          txt.paras = item.paras || [{ align: 'center', runs: [{ t: item.text || '' }] }];
          txt.style = merge(txt.style || {}, item.style || {});
          txt.enabled = true;
          if (typeof item.safeArea === 'string') txt.safeArea = item.safeArea === '9x16' ? '9x16' : 'off';
          // Recorded on the text itself, so `/state` derives them from live
          // state at any time instead of remembering a command.
          if (ovPreset) txt.preset = ovPreset; else delete txt.preset;
          if (ovPattern) txt.pattern = ovPattern; else delete txt.pattern;
          this._applySendLook(ovPreset, ovPattern, lookSnap);
          this.textLook = (ovPreset || ovPattern)
            ? { view: this.view, snap: lookSnap }
            : null;
          this._setViewField('text', txt);
          // `mode` is top-level, but a view block may carry its own `mode`
          // (control.html and pattern.set both stash one) and that override
          // wins in _resolveView, so write both or the send shows nothing.
          this.s.mode = 'text';
          this._setViewField('mode', 'text');
          this.restartReveal();
          // A send always replaces the pending timer: without a duration the
          // text now holds indefinitely.
          this._cancelHold();
          if (holdS > 0) this._armHold(this.view, holdS, holdSnap);
          changed = true;
          break;
        }
        case 'text.clear':
          // A held text takes its look override with it; the view goes back to
          // the look it had before the send, as it does on duration expiry.
          this._releaseTextLook();
          this._cancelHold();
          this._setViewText({ enabled: false });
          this.s.mode = 'pattern';
          this._setViewField('mode', 'pattern');
          changed = true;
          break;
        case 'text.enabled':
          if (a.on === false) {
            this._releaseTextLook();
            this._cancelHold();
          }
          this._setViewText({ enabled: a.on !== false });
          changed = true;
          break;
        case 'text.reveal':
          if (a.ms !== undefined) this._setViewTextStyle({ reveal: num(a.ms, 0) });
          this.restartReveal();
          changed = true;
          break;

        case 'speed': bump('speed', a.delta, 0.1, 4, 1); break;
        case 'brightness': bump('exposure', a.delta, 0.05, 4, 1); break;
        case 'bloom': bump('bloom', a.delta, 0, 4, 0.55); break;
        case 'flare': bump('flareIntensity', a.delta, 0, 4, 0.2); break;
        case 'streak': bump('streakOpacity', a.delta, 0, 1.5, 0.1); break;
        case 'textSize': {
          var cur = num(this.textStyle().size, 0.8);
          var v = (a.set !== undefined) ? num(a.set, cur) : cur + num(a.delta, 0);
          this._setViewTextStyle({ size: clamp(v, 0.3, 1.2) });
          changed = true;
          break;
        }

        case 'blackout.on':
          // A blackout during a timed notice ends the notice rather than
          // freezing it under the black: the view keeps its snapshot restore, so
          // `blackout.off` cannot resurrect a message whose time was up.  The
          // agent is told the restored state, not the notice's.
          this._endHold('blackout');
          this._patchField('blackout', 1);
          changed = true;
          break;
        case 'blackout.off': this._patchField('blackout', 0); changed = true; break;
        case 'blackout.toggle':
          this._patchField('blackout', num(this.s.blackout, 0) >= 0.5 ? 0 : 1);
          changed = true;
          break;

        // a17: the deck's ratio key. The server owns the persisted value (it broadcasts the
        // resulting snapshot back), so the page flipping its own copy here would be a second
        // writer; it only reports that it accepted the press.
        case 'ratio.toggle':
        case 'ratio.force16x9':
        case 'fence.toggle':
          changed = true;
          break;

        case 'settings.patch':
          if (a.patch && typeof a.patch === 'object') {
            this.setSettings(a.patch);
            changed = true;
          } else note = 'ignored: no patch';
          break;

        case 'reload':
          // Contract: only the admin UI's explicit "reload source" sends this.
          // The display pages never schedule a reload of their own.
          if (window.location && window.location.reload) window.location.reload();
          changed = true;
          break;

        case 'wall.image.set': {
          // The upload route answers this on the server (it owns the file), but a deck or the
          // pane can also pin a placement: the picture is already there, only the transform
          // moves. Anything not named is left alone.
          var imgPatch = {};
          var keys = ['x', 'y', 'scale', 'rotate', 'colour', 'bits', 'dither'];
          var fields = ['imageX', 'imageY', 'imageScale', 'imageRotate', 'imageColour', 'imageBits', 'imageDither'];
          for (var ki = 0; ki < keys.length; ki++) {
            if (a[keys[ki]] !== undefined) imgPatch[fields[ki]] = a[keys[ki]];
          }
          if (a.rev !== undefined) {
            imgPatch.imageRev = num(a.rev, 0);
            imgPatch.imageOn = 1;
          }
          if (!Object.keys(imgPatch).length) { note = 'ignored: no image arguments'; break; }
          this.setSettings(imgPatch);
          changed = true;
          break;
        }
        case 'wall.image.clear':
          this.setSettings({ imageOn: 0 });
          changed = true;
          break;

        default:
          note = 'ignored: unknown command';
      }
    } catch (e) {
      note = 'error: ' + (e && e.message ? e.message : String(e));
      changed = false;
    }

    if (this.onCommand) { try { this.onCommand(cmd, a); } catch (e2) { /* ignore */ } }
    if (changed && this.onStateChange) {
      try { this.onStateChange(this.state()); } catch (e3) { /* ignore */ }
    }
    return { ok: changed, changed: changed, note: note, cmd: cmd };
  };

  /** Field patch that keeps the per-view look honest and skips a full re-layout. */
  Instance.prototype._patchField = function (field, value) {
    this.s[field] = value;
    this._syncDerived();
    return this.s;
  };

  /** Write a field that belongs to this page's own view block. */
  Instance.prototype._setViewField = function (field, value) {
    var s = this.s;
    if (!s.views) s.views = {};
    if (!s.views[this.view]) s.views[this.view] = {};
    s.views[this.view][field] = value;
    this._syncDerived();
    return s;
  };

  Instance.prototype._setViewText = function (patch) {
    var txt = JSON.parse(JSON.stringify(this.textObject() || {}));
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) txt[k] = patch[k];
    return this._setViewField('text', txt);
  };

  Instance.prototype._setViewTextStyle = function (patch) {
    var txt = JSON.parse(JSON.stringify(this.textObject() || {}));
    txt.style = merge(txt.style || {}, patch);
    return this._setViewField('text', txt);
  };

  Instance.prototype.textStyle = function () {
    var t = this.textObject();
    return (t && t.style) || {};
  };

  /** Compact snapshot for `POST /state` and for `diag()`. */
  Instance.prototype.state = function () {
    var txt = this.textObject() || {};
    var textUp = !!(txt.enabled && this.modeIndex);
    // Effective look while the text is live: an explicit override if the send
    // named one (or the operator forced one), otherwise whatever look this view
    // is actually inheriting right now.  Resolved per call, never logged.
    var txtPreset = (typeof txt.preset === 'string' && PRESETS[txt.preset]) ? txt.preset : null;
    var txtPattern = (typeof txt.pattern === 'string' && SIM.PATTERN_INDEX[txt.pattern] !== undefined)
      ? txt.pattern : null;
    return {
      online: true,
      ratio: this.ratio,
      view: this.view,
      preset: this.label || null,
      pattern: (this.eff || this.s).pattern || null,
      mode: this.modeIndex ? 'text' : 'pattern',
      blackout: num(this.s.blackout, 0) >= 0.5,
      fps: Math.round(this.fps * 10) / 10,
      gpuMs: Math.round(this.gpuMs * 100) / 100,
      canvas: [this.W, this.H],
      cols: this.grid.cols,
      rows: this.grid.rows,
      text: {
        id: (txt.source && txt.source.id) || null,
        title: txt.title || '',
        enabled: !!txt.enabled,
        safeArea: txt.safeArea || 'off',
        // The look/pattern this text is *actually* rendering with, resolved
        // ('random' is gone by now): an explicit override if the send named
        // one, otherwise the live inherited look.  Null when no text is on air,
        // so a stale text block cannot report a look that is not being applied.
        // Derived from live state on every call, never from a one-shot log —
        // this is what the deck and the console show, so it must follow both an
        // inherited look and a mid-text `preset.set` / `pattern.set`.
        preset: textUp ? (txtPreset || this._currentLookName()) : null,
        pattern: textUp ? (txtPattern || this._currentPatternName()) : null
      },
      updated: Date.now()
    };
  };

  // ── Agent client (SSE in, /state out) ─────────────────────────────────────

  /**
   * Never blocks rendering and never throws: a dead agent only means the page
   * keeps looping and retrying.  Reconnect backoff 1 s → 10 s.
   * `?agent=off` (opts.agent === 'off') disables it entirely.
   *
   * A silent heartbeat paints nothing — the SSE events are the only thing that
   * reaches the wall, and if they stop arriving the last frame just keeps
   * rendering.  The canvas has no agent-status element by design.
   */
  function AgentClient(inst, base) {
    this.inst = inst;
    this.base = String(base || '').replace(/\/+$/, '');
    this.es = null;
    this.backoff = 1000;
    this.retryTimer = 0;
    this.stateTimer = 0;

    this.connected = false;
    this.lastEventAt = 0;
    this.seq = -1;
    this.received = 0;
    this.applied = 0;
    this.ignored = 0;
    this.errors = 0;
    this.lastError = '';
    this.closed = false;
    // State-posting counters.  The heartbeat used to fail silently (a `fetch`
    // that throws synchronously skipped the fallback, and `state()` throwing was
    // swallowed), which left the deck showing text that was no longer on the
    // wall with no way to see why.  Every attempt and every failure is counted
    // and exposed in `diag().agent`, so this cannot go quiet again.
    this.posts = 0;       // pushState attempts with a serialised body
    this.postOk = 0;      // 2xx responses
    this.postFail = 0;    // network / HTTP failure (all encodings tried)
    this.postThrew = 0;   // fetch() threw synchronously (quota, detached frame…)
    this.stateErr = '';   // last state()/JSON.stringify failure
    this.lastPostAt = 0;  // page clock, last attempt
    this.lastOkAt = 0;    // page clock, last 2xx
    this.beats = 0;       // heartbeat ticks, from the 2 s timer *or* the frame loop
    this.beatSrc = '';    // which clock ticked last: 'timer' | 'frame'
    this.snapshots = 0;   // state.snapshot frames applied (control pane changes)
    this.resets = 0;      // hub `reset` frames (our cursor was older than the hub's ring)
    this.lastRev = -1;    // last snapshot revision, so a replay cannot re-apply the same look
    this.lastBeatAt = 0;
  }

  AgentClient.prototype.start = function () {
    var self = this;
    this._connect();
    // 2 s /state heartbeat; the agent marks a silent page offline after 10 s.
    // Two independent clocks push it: this interval, and the render loop
    // (`_frame` → beat('frame')).  A browser source whose DOM timers are
    // throttled still renders, and a page whose rAF is paused still has timers,
    // so neither alone can leave the deck stale.
    this.stateTimer = setInterval(function () { self.beat('timer'); }, 2000);
    this.beat('timer');
  };

  /**
   * One heartbeat tick.  `beat()` — never `pushState()` — is what clocks call:
   * it refuses to run twice inside one 1.5 s window, so the frame loop and the
   * interval cannot double-post when both are healthy.
   */
  AgentClient.prototype.beat = function (src) {
    if (this.closed) return;
    this.beats++;
    this.lastBeatAt = Date.now();
    this.beatSrc = src || '';
    if (this.lastPostAt && Date.now() - this.lastPostAt < 1500) return;
    this.pushState();
  };

  AgentClient.prototype._connect = function () {
    var self = this;
    if (this.closed) return;
    // ShockBox: one SSE hub on /events, scoped with ?channels&view. The hub replays its ring and
    // sends a `reset` frame when our cursor is older than that ring (see core/events.mjs), which
    // is what the old agent lacked: a client could believe it was current while missing frames.
    var url = this.base + '/events?channels=wall&view=' + encodeURIComponent(this.inst.view);
    var es;
    try {
      // EventSource is a classic-script API, so a file:// page reaches it too.
      es = new EventSource(url);
    } catch (e) {
      this._scheduleRetry('EventSource threw: ' + (e && e.message ? e.message : e));
      return;
    }
    this.es = es;
    es.onopen = function () {
      self.connected = true;
      self.backoff = 1000;
      self.lastError = '';
      self.lastEventAt = Date.now();
    };
    es.onmessage = function (ev) {
      self.lastEventAt = Date.now();
      self.connected = true;
      self.backoff = 1000;
      self._dispatch(ev.data);
    };
    // ShockBox state frames: the control pane changed a setting. These carry the render look and
    // the fence, not an engine command, so they are handed to the page rather than applied by
    // applyCommand(). The page's snapshot handler merges them and no-ops an unchanged revision.
    // Every frame is typed with its *channel*, so the kind is the record's `event`, not the wire
    // event name; a command frame on this same channel carries `cmd` and is ignored here.
    es.addEventListener('wall', function (ev) {
      var rec = null;
      try { rec = JSON.parse(ev.data); } catch (e2) { return; }
      if (!rec || typeof rec !== 'object' || rec.event !== 'state.snapshot') return;
      // the record wraps the snapshot the page's handler has always been given
      var d = rec.data;
      if (!d || typeof d !== 'object') return;
      self.lastEventAt = Date.now();
      if (typeof d.rev === 'number' && d.rev === self.lastRev) return;
      if (typeof d.rev === 'number') self.lastRev = d.rev;
      self.snapshots++;
      try {
        window.dispatchEvent(new CustomEvent('ledwall:server-settings', { detail: d }));
      } catch (e3) {
        self.lastError = 'snapshot handler: ' + (e3 && e3.message ? e3.message : String(e3));
        self.errors++;
      }
      self.pushState();
    });
    // Hub control frames. `reset` means our seq is older than the hub's ring or the server
    // restarted (seq restarts at 1): drop the cursor and reconnect; the hub replays its ring.
    es.addEventListener('reset', function () {
      self.resets++;
      self.seq = -1;
      try { es.close(); } catch (e2) { /* ignore */ }
      self.es = null;
      self.connected = false;
      self._scheduleRetry('hub reset');
    });
    es.onerror = function () {
      self.connected = false;
      try { es.close(); } catch (e2) { /* ignore */ }
      self.es = null;
      self._scheduleRetry('sse error');
    };
  };

  AgentClient.prototype._dispatch = function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.cmd !== 'string') return;
    if (typeof msg.seq === 'number') {
      if (msg.seq <= this.seq) return;      // replay after a reconnect
      this.seq = msg.seq;
    }
    // What the server actually sent, kept for diag().agent.lastCmd. Recorded after the
    // replay guard so a reconnect cannot leave stale args behind a fresh command.
    this._lastArgs = msg.args || null;
    this.received++;
    var res;
    try {
      res = this.inst.applyCommand(msg.cmd, msg.args);
    } catch (e2) {
      this.errors++;
      this.lastError = 'apply threw: ' + (e2 && e2.message ? e2.message : String(e2));
      return;
    }
    if (res && res.ok) this.applied++; else this.ignored++;
    this.lastCmd = { cmd: msg.cmd, res: res, at: Date.now() };
    if (this._lastArgs) this.lastCmd.args = this._lastArgs;
    if (res && res.note && res.note.indexOf('error') === 0) this.errors++;
    this.pushState();
  };

  AgentClient.prototype._scheduleRetry = function (why) {
    var self = this;
    if (this.closed || this.retryTimer) return;
    this.lastError = why;
    var wait = this.backoff;
    this.backoff = Math.min(10000, Math.round(this.backoff * 1.7));
    this.retryTimer = setTimeout(function () {
      self.retryTimer = 0;
      self._connect();
    }, wait);
  };

  AgentClient.prototype.pushState = function () {
    if (this.closed) return;
    var body;
    try { body = JSON.stringify({ view: this.inst.view, state: this.inst.state() }); }
    catch (e) {
      // Swallowing this was a silent heartbeat killer: `state()` throws once
      // (bad paras, a throw inside a provider) and every later beat dies with
      // it while the wall keeps rendering.  Count it and keep the message.
      this.stateErr = 'state() threw: ' + (e && e.message ? e.message : String(e));
      this.postFail++;
      return;
    }
    this.stateErr = '';
    this.posts++;
    this.lastPostAt = Date.now();
    this._sendState(body, false);
  };

  /**
   * One POST attempt, then one retry in the other encoding.
   *
   * Plain `text/plain` goes first: a `file://` page has an opaque origin, so
   * `application/json` needs a preflight while a simple request does not — one
   * less thing that can be refused.  `keepalive` is not used: a beat that is
   * never unloaded does not need it, and it puts the request under Chrome's
   * keepalive accounting for no benefit.
   *
   * Retries are bounded (one per encoding, no loop), and every outcome is
   * counted: `postOk`, `postFail`, `postThrew`, `stateErr`.  Measured in the
   * lab: a fetch to a server that never answers neither resolves nor rejects,
   * so a beat can also be *in flight forever* — which is why `beats` and
   * `postOk` are separate numbers in `diag().agent`.
   */
  AgentClient.prototype._sendState = function (body, asJson) {
    var self = this;
    var p;
    try {
      p = fetch(this.base + (window.LEDWALL_SERVER_MODE ? '/api/wall/state' : '/state'), {
        method: 'POST',
        headers: { 'Content-Type': asJson ? 'application/json' : 'text/plain;charset=UTF-8' },
        body: body
      });
    } catch (e) {
      this.postThrew++;
      this.lastError = 'fetch threw: ' + (e && e.message ? e.message : String(e));
      if (!asJson) this._sendState(body, true);
      else this.postFail++;
      return;
    }
    p.then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      self.postOk++;
      self.lastOkAt = Date.now();
      self.lastError = '';
    }).catch(function (err) {
      // A network error and a CORS rejection are indistinguishable here; the
      // other encoding is the one that may be allowed, so try it once.
      self.lastError = err && err.message ? err.message : String(err);
      if (!asJson) self._sendState(body, true);
      else self.postFail++;
    });
  };

  AgentClient.prototype.status = function () {
    return {
      connected: this.connected,
      seq: this.seq,
      received: this.received,
      applied: this.applied,
      ignored: this.ignored,
      errors: this.errors,
      backoff: this.backoff,
      snapshots: this.snapshots,
      lastCmd: this.lastCmd || null,
      resets: this.resets,
      lastError: this.lastError || null,
      silentMs: this.lastEventAt ? (Date.now() - this.lastEventAt) : null,
      // State-post health: `beats` climbing while `postOk` is frozen is the
      // signature of a dead POST path with a live page.
      posts: this.posts,
      postOk: this.postOk,
      postFail: this.postFail,
      postThrew: this.postThrew,
      stateErr: this.stateErr || null,
      beats: this.beats,
      beatSrc: this.beatSrc || null,
      lastPostAt: this.lastPostAt || null,
      lastOkAt: this.lastOkAt || null,
      stateAgeMs: this.lastOkAt ? (Date.now() - this.lastOkAt) : null
    };
  };

  AgentClient.prototype.destroy = function () {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.es) { try { this.es.close(); } catch (e) { /* ignore */ } }
    this.es = null;
  };

  // ── Public API ───────────────────────────────────────────────────────────

  window.LEDWall = {
    version: '2.1',
    mount: function (canvas, settings, opts) {
      return new Instance(canvas, settings, opts);
    },
    patterns: SIM.PATTERNS,
    palettes: Object.keys(PALETTES),
    presets: savedPresetList,
    applySavedPresets: applySavedPresets,
    // The dimensions a preset carries, so a test can prove the page and the server agree.
    presetDims: PRESET_DIMS.slice()
  };
})();
