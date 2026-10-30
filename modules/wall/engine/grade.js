/**
 * LED Wall v2 — colour LUT + post chain (grade.js)
 * ===============================================
 * Everything here is a shader string plus small helpers; engine.js owns the GL
 * objects.  Split of work:
 *
 *   engine.js  LED/streak draws, sim ping-pong, pass orchestration, timing
 *   grade.js   palette LUT, bright pass, 5-mip dual-Kawase-style bloom,
 *              composite: exposure → lift → contrast → saturation → ACES →
 *              vignette → grain → ordered dither
 *
 * Colour space note: the palette hexes and all brightness maths stay in
 * *display* space (what the hex looks like in a browser), exactly like v1.
 * Headroom above 1.0 comes from hdrGain on hot LEDs; bloom and the tonemap
 * operate on that display-space value.  No sRGB decode anywhere, so a palette
 * stop at full brightness lands on the same pixel colour v1 produced.
 */
(function () {
  'use strict';

  // ── Fullscreen triangle ────────────────────────────────────────────────────

  var FS_VERT = [
    '#version 300 es',
    'precision highp float;',
    'out vec2 v_uv;',
    'void main() {',
    // Fullscreen triangle: uv (0,0) (2,0) (0,2) → clip (-1,-1) (3,-1) (-1,3)
    '  vec2 uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  v_uv = uv;',
    '  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // ── Bright pass + first downsample (scene → bloom mip 0) ───────────────────

  var BRIGHT_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_src;',
    'uniform vec2  u_texel;      // 1 / src size',
    'uniform float u_threshold;',
    'uniform float u_knee;',
    'in vec2 v_uv;',
    'out vec4 o;',
    'void main() {',
    '  vec2 t = u_texel;',
    // 4-tap box, rotated 45° on the half-res grid: kills fireflies without blur cost
    '  vec3 c = texture(u_src, v_uv + t * vec2(-0.5, -0.5)).rgb;',
    '  c += texture(u_src, v_uv + t * vec2( 0.5, -0.5)).rgb;',
    '  c += texture(u_src, v_uv + t * vec2(-0.5,  0.5)).rgb;',
    '  c += texture(u_src, v_uv + t * vec2( 0.5,  0.5)).rgb;',
    '  c *= 0.25;',
    '  float br = max(c.r, max(c.g, c.b));',
    '  float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);',
    '  soft = soft * soft / (4.0 * u_knee + 1e-4);',
    '  float contrib = max(soft, br - u_threshold) / max(br, 1e-4);',
    '  o = vec4(c * contrib, 1.0);',
    '}'
  ].join('\n');

  // ── Plain 4-tap downsample ────────────────────────────────────────────────

  var DOWN_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_src;',
    'uniform vec2 u_texel;',
    'in vec2 v_uv;',
    'out vec4 o;',
    'void main() {',
    '  vec2 t = u_texel;',
    '  vec3 c = texture(u_src, v_uv + t * vec2(-0.5, -0.5)).rgb;',
    '  c += texture(u_src, v_uv + t * vec2( 0.5, -0.5)).rgb;',
    '  c += texture(u_src, v_uv + t * vec2(-0.5,  0.5)).rgb;',
    '  c += texture(u_src, v_uv + t * vec2( 0.5,  0.5)).rgb;',
    '  o = vec4(c * 0.25, 1.0);',
    '}'
  ].join('\n');

  // ── 9-tap tent upsample (drawn with additive blending) ────────────────────

  var UP_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_src;',
    'uniform vec2  u_texel;   // 1 / src size',
    'uniform float u_radius;  // mip offset multiplier',
    'in vec2 v_uv;',
    'out vec4 o;',
    'void main() {',
    '  vec2 t = u_texel * u_radius;',
    '  vec3 c = texture(u_src, v_uv).rgb * 4.0;',
    '  c += texture(u_src, v_uv + vec2(-t.x, 0.0)).rgb * 2.0;',
    '  c += texture(u_src, v_uv + vec2( t.x, 0.0)).rgb * 2.0;',
    '  c += texture(u_src, v_uv + vec2(0.0, -t.y)).rgb * 2.0;',
    '  c += texture(u_src, v_uv + vec2(0.0,  t.y)).rgb * 2.0;',
    '  c += texture(u_src, v_uv + vec2(-t.x, -t.y)).rgb;',
    '  c += texture(u_src, v_uv + vec2( t.x, -t.y)).rgb;',
    '  c += texture(u_src, v_uv + vec2(-t.x,  t.y)).rgb;',
    '  c += texture(u_src, v_uv + vec2( t.x,  t.y)).rgb;',
    '  o = vec4(c / 16.0, 1.0);',
    '}'
  ].join('\n');

  // ── Composite: bloom add, grade, tonemap, vignette, grain, dither ─────────

  var COMPOSITE_FRAG = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D u_scene;',
    'uniform sampler2D u_bloom;',
    'uniform vec2  u_res;',
    'uniform float u_bloomStrength;',
    'uniform float u_exposure;',
    'uniform float u_saturation;',
    'uniform float u_contrast;',
    'uniform float u_lift;',
    'uniform float u_vignette;',
    'uniform float u_grain;',
    'uniform float u_dither;',
    'uniform float u_aces;',
    'uniform float u_blackout;   // 1 = LEDs and background go dark, page keeps running',
    'uniform float u_time;',
    'in vec2 v_uv;',
    'out vec4 o;',
    '',
    'vec3 aces(vec3 x) {',
    '  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;',
    '  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);',
    '}',
    '',
    'float hash12(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    '',
    // 8×8 ordered Bayer, computed — no texture, no allocation
    'float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }',
    'float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }',
    'float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }',
    '',
    'void main() {',
    '  vec3 col = texture(u_scene, v_uv).rgb;',
    '  vec3 bloom = texture(u_bloom, v_uv).rgb;',
    '  col += bloom * u_bloomStrength * 0.28;',
    '',
    '  col *= u_exposure;',
    '  col += u_lift * (1.0 - col);',
    '',
    // contrast pivots on mid grey, then saturation around luma
    '  col = (col - 0.5) * u_contrast + 0.5;',
    '  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = mix(vec3(luma), col, u_saturation);',
    '  col = max(col, 0.0);',
    '',
    '  if (u_aces > 0.5) col = aces(col);',
    '  else col = clamp(col, 0.0, 1.0);',
    '',
    // vignette: smooth, aspect-correct, no hard edge
    '  vec2 q = v_uv - 0.5;',
    '  q.x *= u_res.x / u_res.y;',
    '  float vig = 1.0 - u_vignette * 0.85 * smoothstep(0.25, 0.95, dot(q, q) * 2.2);',
    '  col *= vig;',
    '',
    '  if (u_grain > 0.0005) {',
    '    float g = hash12(gl_FragCoord.xy + fract(u_time) * 137.0) - 0.5;',
    '    col += g * u_grain * 0.09;',
    '  }',
    '',
    '  if (u_dither > 0.5) {',
    '    float d = (bayer8(gl_FragCoord.xy) - 0.5) / 255.0;',
    '    col += d * u_dither;',
    '  }',
    '',
    // blackout is last so it also kills bloom, grain and background: the canvas
    // goes to true black while the sim, the clock and the reporting keep running.
    '  col *= (1.0 - u_blackout);',
    '',
    '  o = vec4(clamp(col, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');

  // ── Palette → 256-stop LUT ────────────────────────────────────────────────
  /**
   * Palette entries are floats in hex order.  The LUT is built by walking the
   * stops around the hue circle (so a pattern's palette coordinate sweeps hue),
   * weighted by repetition, then smoothed with a small cyclic blur.
   *
   * paletteWeight 0 → muted (sat × 0.55); 1 → as authored (sat × 1.0, min 0.95
   * for stops that were already saturated) so high weight means "more neon".
   */
  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return [1, 0, 1];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function rgbToHsv(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var d = max - min;
    var h = 0;
    if (d > 1e-6) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    return [h, max > 1e-6 ? d / max : 0, max];
  }

  function hsvToRgb(h, s, v) {
    var i = Math.floor(h * 6), f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: return [v, t, p];
      case 1: return [q, v, p];
      case 2: return [p, v, t];
      case 3: return [p, q, v];
      case 4: return [t, p, v];
      default: return [v, p, q];
    }
  }

  function buildLUT(hexes, weight) {
    var w = (weight === undefined ? 1 : Math.max(0, Math.min(1, weight)));
    var stops = [];
    for (var i = 0; i < hexes.length; i++) {
      var rgb = hexToRgb(hexes[i]);
      var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      stops.push({ h: hsv[0], s: hsv[1], v: hsv[2] });
    }
    // Circular order by hue; equal hues keep their authored order.
    stops.sort(function (a, b) { return a.h - b.h; });

    var n = stops.length;
    var out = new Uint8Array(256 * 4);
    for (var k = 0; k < 256; k++) {
      var u = k / 256 * n;
      var i0 = Math.floor(u) % n;
      var i1 = (i0 + 1) % n;
      var f = u - Math.floor(u);
      var a = stops[i0], b = stops[i1];
      // shortest way around the hue circle
      var dh = b.h - a.h;
      if (dh > 0.5) dh -= 1;
      if (dh < -0.5) dh += 1;
      var hh = (a.h + dh * f + 1) % 1;
      var ss = a.s + (b.s - a.s) * f;
      var vv = a.v + (b.v - a.v) * f;
      var satMul = 0.55 + 0.45 * w;
      var valMul = 0.92 + 0.08 * w;
      var rgb2 = hsvToRgb(hh, Math.min(1, ss * satMul), Math.min(1, vv * valMul));
      out[k * 4 + 0] = Math.round(Math.max(0, Math.min(1, rgb2[0])) * 255);
      out[k * 4 + 1] = Math.round(Math.max(0, Math.min(1, rgb2[1])) * 255);
      out[k * 4 + 2] = Math.round(Math.max(0, Math.min(1, rgb2[2])) * 255);
      out[k * 4 + 3] = 255;
    }
    // Cyclic 3-tap smooth so the 256 stops read as a ramp, not bands.
    var sm = new Uint8Array(256 * 4);
    for (var j = 0; j < 256; j++) {
      var p0 = (j + 255) % 256, p1 = j, p2 = (j + 1) % 256;
      for (var c = 0; c < 3; c++) {
        sm[j * 4 + c] = Math.round(
          (out[p0 * 4 + c] + out[p1 * 4 + c] * 2 + out[p2 * 4 + c]) / 4);
      }
      sm[j * 4 + 3] = 255;
    }
    return sm;
  }

  window.LEDWALL_GRADE = {
    vert: FS_VERT,
    bright: BRIGHT_FRAG,
    down: DOWN_FRAG,
    up: UP_FRAG,
    composite: COMPOSITE_FRAG,
    buildLUT: buildLUT,
    hexToRgb: hexToRgb
  };
})();
