/**
 * LED Wall v2 — pattern simulation (sim.js)
 * =========================================
 * One fragment shader pass at cols × rows.  Each texel holds one LED:
 *
 *   RGBA = ( current brightness, target brightness, palette coord, cooldown )
 *
 * The previous frame's texture is sampled and the next state written into the
 * ping-pong target.  Nothing is computed per LED on the CPU, nothing is uploaded
 * per frame: the CPU only pushes ~24 scalar uniforms.
 *
 * Patterns (index order is the contract with config.js/control.html):
 *   0 random       v1 port — per-LED flash, centre-biased, cooldown re-roll
 *   1 wave         v1 port — diagonal sine field
 *   2 bottomCenter v1 port — rings from bottom centre with distance fade
 *   3 sweep        v1 port — horizontal palette gradient scrolling sideways
 *   4 bars         v1 port — vertical bars, per-column colour
 *   5 ripple       v1 port — concentric rings from centre
 *   6 plasma       new — three-counter sine field, smoothly cycling hue
 *   7 chase        new — segmented ring travelling around the border
 *   8 sweepMirror  new — symmetric wavefronts from the centre outward
 *   9 comet        new — bright head with an exponential trail
 *  10 matrix       new — vertical rain streams with a bright head (stateless)
 *  11 spectrum     new — full-height equaliser bins, two-phase sine heights
 *  12 orbits       new — three phase-offset Lissajous heads on a dim grid
 *  13 rain         new — sparse falling drops, hashed per column (stateless)
 *  14 equalizer    new — mirrored bars from the vertical centre, beat pulse
 *  15 static       new — TV snow / interference over a rolling band
 *  16 heartbeat    new — ECG trace that sweeps in and out, with a glow
 * Mode 1 = text: samples the rasterised text bitmap instead of a pattern.
 *
 * Timing: u_time is already speed-scaled (t += dt * speed) exactly like v1's
 * `self.time`, so ported maths keeps its original rates.  u_dt is real seconds.
 */
(function () {
  'use strict';

  var PATTERNS = ['random', 'wave', 'bottomCenter', 'sweep', 'bars', 'ripple',
                  'plasma', 'chase', 'sweepMirror', 'comet',
                  'matrix', 'spectrum', 'orbits', 'rain', 'equalizer', 'static',
                  'heartbeat'];

  var PATTERN_INDEX = {};
  PATTERNS.forEach(function (name, i) { PATTERN_INDEX[name] = i; });

  // ── Vertex stage: generated fullscreen quad, no attribute buffers ───────────

  var SIM_VERT = [
    '#version 300 es',
    'precision highp float;',
    'out vec2 v_uv;',
    'void main() {',
    ['// Fullscreen triangle: uv (0,0) (2,0) (0,2) → clip (-1,-1) (3,-1) (-1,3)'].join('\n'),
    '  vec2 uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  v_uv = uv;',
    '  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // ── Fragment stage ─────────────────────────────────────────────────────────

  var SIM_FRAG = [
    '#version 300 es',
    'precision highp float;',
    '',
    'uniform sampler2D u_prev;',
    'uniform sampler2D u_text;',
    'uniform vec2  u_grid;        // cols, rows',
    'uniform vec2  u_textSize;    // text bitmap size in texels',
    'uniform float u_time;        // speed-scaled seconds (v1 self.time)',
    'uniform float u_dt;          // real seconds since last sim step',
    'uniform float u_speed;',
    'uniform float u_transition;',
    'uniform float u_flash;',
    'uniform float u_waveFreq;',
    'uniform float u_persistence;',
    'uniform float u_textScroll;  // horizontal offset in grid cells',
    'uniform float u_reveal;      // 0..1 type-on progress; 1 = fully revealed',
    'uniform float u_textHex;     // 1 = per-cell palette coord is -1 (hex colour)',
    'uniform float u_textScrollRate; // palette-scroll rate from the live pattern (text mode)',
    'uniform float u_cdScale;     // cooldown storage scale (1 float CB, .25 RGBA8)',
    'uniform int   u_pattern;',
    'uniform float u_bright;      // intensity for the eyecandy patterns (ctl: waveFreq)',
    'uniform int   u_mode;        // 0 pattern, 1 text',
    '// ── the 9:16 fence ─────────────────────────────────────────────────────',
    '// The wall is one 16:9 grid; a 9:16 window can be carved out of it.  The window is in',
    '// WHOLE CELLS (x, y, w, h), never pixels: every pattern is computed from nx/ny against the',
    '// window\'s own cols×rows, so a chase frame runs along the window\'s edge instead of the',
    '// 16:9 border, and nothing is clipped at a fractional cell edge.',
    'uniform vec2  u_fence;       // window x, y (cells)',
    'uniform vec2  u_fenceSize;   // window w, h (cells); w<=0 means no fence',
    'uniform float u_fenceOn;     // 0 = whole wall, 1 = inside the window',
    'uniform float u_fenceLight;  // ring brightness on the window edge (0 = off)',
    'uniform float u_outDim;      // what the wall does outside the window: 0 dark, 1 full',
    '',
    'out vec4 outState;',
    '',
    '// Cheap hash.  Two calls with different offsets decorrelate the streams.',
    'float hash21(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float hash11(float p) {',
    '  return hash21(vec2(p, p * 1.618));',
    '}',
    '',
    'void main() {',
    '  vec2 cell = floor(gl_FragCoord.xy);',
    '// Where this cell sits *for the pattern*: inside the window it is the window\'s own',
    '// coordinate; outside, the same coordinate extrapolated from the window\'s grid, so the',
    '// pattern continues across the whole wall with no seam at the frame.',
    '  float t  = u_time;',
    '  vec2  fx = u_fenceOn > 0.5 ? u_fence : vec2(0.0);',
    '  vec2  fs = u_fenceOn > 0.5 ? u_fenceSize : u_grid;',
    '  vec2  p  = cell - fx;',
    '  float cols = fs.x;',
    '  float rows = fs.y;',
    '  float col = p.x;',
    '  float row = p.y;',
    '  float nx = col / max(cols, 1.0);',
    '  float ny = row / max(rows, 1.0);',
    '// Ring light on the window edge: inside its last cell, dark one cell out. `u_fenceLight`',
    '// is the operator\'s brightness for it; the pattern still shows through at `fenceMix`.',
    '  float fenceOn = u_fenceOn > 0.5 ? 1.0 : 0.0;',
    '  vec4  prev   = texelFetch(u_prev, ivec2(cell), 0);',
    '  float cur    = prev.r;',
    '  float target = prev.g;',
    '  float pal    = prev.b;',
    '  float cd     = prev.a;',
    '',
    '  float rate = 6.0;',
    '  float br = target;',
    '  float ph = pal;',
    '',
    '  if (u_mode == 1) {',
    '// ── text ───────────────────────────────────────────────────────────────',
    '// The rasteriser writes four channels per cell: r = coverage, g = that cell\'s',
    '// place in the type-on order, b/a = the cell\'s colour override.  Dividing g',
    '// by r recovers the order where the glyph is partly covered, so `reveal`',
    '// needs one uniform and no re-raster.  A per-run colour rides in b (a LUT',
    '// index) and a (its mode), both 0 for a run that inherits the block\'s.',
    '    rate = 5.0;',
    '    float sx = mod(col + u_textScroll, u_textSize.x);',
    '    vec4 tx = texelFetch(u_text, ivec2(int(sx), int(row)), 0);',
    '    float cov = tx.r;',
    '    float ord = cov > 0.004 ? clamp(tx.g / cov, 0.0, 1.0) : 0.0;',
    '    float vis = u_reveal >= 1.0 ? 1.0',
    '              : smoothstep(ord - 0.015, ord + 0.015, u_reveal);',
    '    float a = cov * vis;',
    '// At the 5-row fit floor a glyph stroke covers only a few percent of a cell;',
    '// a hard 0.31 cut-off would make those samples vanish entirely.  Keep a low',
    '// gate and lift the gain so a thin stroke still reads as a lit cell.',
    '    if (a > 0.04) {',
    '// The cell is a LIT LED, not a pixel: it is drawn with the same bloom, flare, streak and',
    '// grade as a pattern cell, and its colour comes out of the live palette LUT.  What the',
    '// *pattern* selector controls here is only the motion of the palette scroll, so a new',
    '// pattern re-animates live text instead of being masked by the send\'s look.',
    '      br = clamp(a * 2.2 + 0.10, 0.22, 1.0);',
    '// Per-run colour.  cm is the run\'s colour mode from the bitmap\'s alpha',
    '// channel: 0 = inherit (the block\'s own treatment, byte-for-byte the old',
    '// path), 1 = follow the block\'s palette scroll, 2 = a fixed LUT sample',
    '// carried in the blue channel.  The wall\'s LED shader takes ONE colour',
    '// index per cell (v_pal: < -0.5 = the literal u_textColor, else a sample of',
    '// the palette LUT), so a run colour is expressed in that same space — see',
    '// ENGINE-API §TEXT.',
    '      float cb = floor(tx.b * 255.0 + 0.5);',
    '// u_textScrollRate is the live pattern scroll: wave sweeps slowly, chase kicks across,',
    '// static holds still. The palette *ramp* is whatever is selected now, because ph is read',
    '// through the LUT below, so `look.palette` recolours live text with no re-send.',
    '      if (cb > 254.5) ph = fract(nx + t * u_textScrollRate);',            // 'palette' run
    '      else if (cb > 0.5) ph = (cb - 1.0 + 0.5) / 256.0;',                 // run colour sample
    '      else ph = u_textHex > 0.5 ? -1.0 : fract(nx + t * u_textScrollRate);', // inherit block
    '    } else {',
    '      br = 0.0;',
    '    }',
    '  } else if (u_pattern == 0) {',
    '// ── random (v1) ────────────────────────────────────────────────────────',
    '    rate = 4.0;',
    '    cd -= u_dt * u_cdScale;',
    '    if (cd <= 0.0) {',
    '      float dc = abs(col - cols * 0.5) / (cols * 0.5);',
    '      float chance = u_flash + (1.0 - dc) * 0.1;',
    '      float r1 = hash21(cell + vec2(t * 13.13, t * 7.77));',
    '      float r2 = hash21(cell + vec2(31.7, t * 3.31));',
    '      float r3 = hash21(cell + vec2(11.3, t * 5.19));',
    '      if (r1 < chance) {',
    '        target = 0.5 + r2 * 0.5;',
    '        pal    = r3;',
    '      } else {',
    '        target = r2 * 0.15;',
    '      }',
    '      cd = (0.3 + r3 * 1.2) / max(u_speed, 0.05) * u_cdScale;',
    '    }',
    '    br = target; ph = pal;',
    '  } else if (u_pattern == 1) {',
    '// ── wave (v1) ──────────────────────────────────────────────────────────',
    '    rate = 8.0;',
    '    float fx = u_waveFreq;',
    '    float fy = fx * 0.67;',
    '    float angle = nx * fx * 6.28318530718 + ny * fy * 3.14159265359 + t;',
    '    float s = sin(angle);',
    '    br = (s + 1.0) * 0.5;',
    '    ph = br;',
    '  } else if (u_pattern == 2) {',
    '// ── bottomCenter (v1) ──────────────────────────────────────────────────',
    '    rate = 6.0;',
    '    float cx = (cols - 1.0) * 0.5;',
    '    float cy = rows - 1.0;',
    '    float dx = col - cx;',
    '    float dy = row - cy;',
    '    float dist = sqrt(dx * dx + dy * dy);',
    '    float maxDist = max(sqrt(cx * cx + cy * cy), 1.0);',
    '    float freq = u_waveFreq * 0.04;',
    '    float s = sin(dist * freq - t * 2.5);',
    '    float fade = 1.0 - min(dist / maxDist, 1.0);',
    '    br = max(0.0, (s + 1.0) * 0.5 * fade);',
    '    ph = fract((s + 1.0) * 0.5 + t * 0.3);',
    '  } else if (u_pattern == 3) {',
    '// ── sweep (v1) ─────────────────────────────────────────────────────────',
    '    rate = 8.0;',
    '    float phase = fract(nx + t * 0.15);',
    '    ph = phase;',
    '    br = 0.4 + 0.3 * sin(phase * 3.14159265359);',
    '  } else if (u_pattern == 4) {',
    '// ── bars (v1) ──────────────────────────────────────────────────────────',
    '    rate = 6.0;',
    '    ph = fract(col / cols);',
    '    float bar = sin(ny * u_waveFreq * 2.0 + t * 1.5);',
    '    br = max(0.0, bar);',
    '  } else if (u_pattern == 5) {',
    '// ── ripple (v1) ────────────────────────────────────────────────────────',
    '    rate = 6.0;',
    '    float cx = (cols - 1.0) * 0.5;',
    '    float cy = (rows - 1.0) * 0.5;',
    '    float dx = col - cx;',
    '    float dy = row - cy;',
    '    float dist = sqrt(dx * dx + dy * dy);',
    '    float s = sin(dist * (u_waveFreq * 0.05) - t * 3.0);',
    '    br = max(0.0, (s + 0.7) / 1.7);',
    '    ph = abs(s);',
    '  } else if (u_pattern == 6) {',
    '// ── plasma (new) ───────────────────────────────────────────────────────',
    '    rate = 6.0;',
    '    float f = u_waveFreq;',
    '    float a = sin(nx * f * 2.2 + t * 0.9);',
    '    float b = sin(ny * f * 1.6 - t * 1.1 + nx * 2.0);',
    '    float c = sin((nx * 1.5 + ny * 1.2) * f * 1.4 + t * 0.7);',
    '    float v = (a + b + c) * 0.3333;',
    '    br = smoothstep(-0.62, 0.72, v);',
    '    ph = fract(v * 0.5 + 0.5 + t * 0.05);',
    '  } else if (u_pattern == 7) {',
    '// ── chase (new) ────────────────────────────────────────────────────────',
    '    rate = 8.0;',
    '    float perim = 2.0 * (cols + rows);',
    '    float pos;',
    '    if (row < 0.5) {',
    '      pos = col;',
    '    } else if (col > cols - 1.5) {',
    '      pos = cols + row;',
    '    } else if (row > rows - 1.5) {',
    '      pos = cols + rows + (cols - 1.0 - col);',
    '    } else {',
    '      pos = 2.0 * cols + rows + (rows - 1.0 - row);',
    '    }',
    '    bool edge = (row < 0.5) || (row > rows - 1.5) || (col < 0.5) || (col > cols - 1.5);',
    '    float segLen = max(perim * 0.055, 3.0);',
    '    float d = abs(fract(pos / perim - fract(t * 0.22) + 0.5) - 0.5) * perim;',
    '    float head = exp(-d * d / (segLen * segLen * 1.6));',
    '    if (edge) {',
    '      float seg = mod(floor(pos / segLen), 3.0);',
    '      br = (seg > 1.5 ? 0.62 : 0.20) * u_bright + 1.30 * head;',
    '    } else {',
    '      br = 0.10 * u_bright + 0.40 * head;',
    '    }',
    '    ph = fract(pos / perim + t * 0.06);',
    '  } else if (u_pattern == 8) {',
    '// ── sweepMirror (new) ──────────────────────────────────────────────────',
    '    rate = 8.0;',
    '    float d = abs(nx - 0.5) * 2.0;',
    '    float phase = fract(d * 0.5 * u_waveFreq * 0.35 - t * 0.18);',
    '    br = 0.25 + 0.75 * pow(1.0 - abs(phase * 2.0 - 1.0), 2.6);',
    '    ph = fract(d * 1.2 + t * 0.05);',
    '  } else if (u_pattern == 9) {',
    '    rate = 6.0;',
    '    float travel = fract(t * 0.16);',
    '    float hx = travel * 1.36 - 0.18;',
    '    float hy = 0.5 + 0.16 * sin(t * 0.6);',
    '    float dx = col - hx * cols;',
    '    float dy = row - hy * rows;',
    '    float r = max(cols * 0.060, 1.5);',
    '    float headGlow = exp(-(dx * dx + dy * dy) / (r * r));',
    '    float behind = max(dx, 0.0);',
    '    float tail = exp(-behind / max(cols * 0.24, 1.0))',
    '               * exp(-(dy * dy) / max(cols * 0.040, 0.6));',
    '    br = clamp(headGlow * 1.3 + tail * 0.9, 0.0, 1.0);',
    '    ph = fract(t * 0.07 + behind * 0.006);',
    '  } else if (u_pattern == 10) {',
    '// ── matrix (new) ───────────────────────────────────────────────────────',
    '// Per-column stream: a head travels down at a per-column rate and a short,',
    '// fading tail above it.  Stateless (time is hashed, nothing accumulates)',
    '// so it survives a page reload mid-stream.',
    '    rate = 7.0;',
    '    float spd = 0.25 + hash11(col * 7.31) * 0.75;',
    '    float off = hash11(col * 3.17 + 1.7);',
    '    float headPos = fract(t * spd * 0.20 + off);',
    '    float tailLen = 0.08 + hash11(col * 5.53 + 3.1) * 0.22;',
    '    float d = headPos - ny;   // > 0 = above the head (the tail)',
    '    float lit = 0.0;',
    '    if (d > 0.0) lit = exp(-d / tailLen) * step(0.35, hash11(col * 11.3 + off * 51.0));',
    '    float head = exp(-pow((ny - headPos) * rows * 0.9, 2.0));',
    '    // occasional gaps so a column reads as symbols, not a solid streak',
    '    float gap = step(0.35, hash11(col * 2.7 + floor(ny * rows * 1.4)));',
    '    br = clamp((lit * gap * 0.85 + head * 1.4) * u_bright, 0.0, 1.0);',
    '    ph = fract(off + ny * 0.15);',
    '  } else if (u_pattern == 11) {',
    '// ── spectrum (new) ─────────────────────────────────────────────────────',
    '// Equaliser bins across the wall, filled from the bottom.  Two phases of',
    '// sine per bin give plausible movement without any real audio input.',
    '    rate = 6.0;',
    '    float binW = max(2.0, floor(cols / 14.0));',
    '    float bin = floor(col / binW);',
    '    float inBin = mod(col, binW) / binW;',
    '    float ph1 = t * (0.9 + hash11(bin * 1.7) * 1.4) + bin * 0.7;',
    '    float ph2 = t * (0.35 + hash11(bin * 4.3) * 0.8) + bin * 1.9;',
    '    float h = 0.30 + 0.55 * abs(sin(ph1)) * (0.6 + 0.4 * abs(sin(ph2)));',
    '    h = h * (1.0 - 0.15 * inBin);',
    '    float fill = 1.0 - ny;            // 0 at the bottom of the wall',
    '    float seg = mod(floor(fill * rows), 3.0);',
    '    float bar = smoothstep(h + 0.02, h - 0.02, fill) * (seg > 1.5 ? 0.55 : 1.0) * u_bright;',
    '    br = clamp(bar, 0.0, 1.0);',
    '    ph = fract(fill * 0.8 + t * 0.05);',
    '  } else if (u_pattern == 12) {',
    '// ── orbits (new) ───────────────────────────────────────────────────────',
    '// Three heads on phase-offset Lissajous paths, each with a soft halo; the',
    '// rest of the grid gets a faint lattice so the panel is never dead.',
    '    rate = 7.0;',
    '    float acc = 0.0;',
    '    float accPh = 0.0;',
    '    for (int k = 0; k < 3; k++) {',
    '      float fk = float(k);',
    '      vec2 c = vec2(0.5 + 0.36 * sin(t * (0.31 + fk * 0.07) + fk * 2.1),',
    '                    0.5 + 0.36 * sin(t * (0.43 + fk * 0.05) + fk * 1.3));',
    '      vec2 dv = (vec2(nx, ny) - c) * u_grid;',
    '      float r2 = dot(dv, dv);',
    '      float rad = max(min(cols, rows) * 0.10, 1.2);',
    '      float g = exp(-r2 / (rad * rad));',
    '      acc += g;',
    '      accPh += g * fract(fk * 0.31 + t * 0.06);',
    '    }',
    '    acc = clamp(acc, 0.0, 1.0);',
    '    float lattice = 0.06 * step(0.92, fract(nx * cols * 0.25)) * step(0.92, fract(ny * rows * 0.25));',
    '    br = clamp(acc * 1.15 + lattice, 0.0, 1.0);',
    '    ph = acc > 0.02 ? accPh / max(acc, 0.001) : 0.0;',
    '  } else if (u_pattern == 13) {',
    '// ── rain (new) ─────────────────────────────────────────────────────────',
    '// Sparse drops: each column re-rolls a drop every cycle; a short vertical',
    '// smear trails it.  Wider spacing than matrix, so it reads as weather.',
    '    rate = 7.0;',
    '    float cyc = 1.0 + hash11(col * 13.7) * 1.6;',
    '    float phase = fract(t / cyc + hash11(col * 2.9));',
    '    float dropY = 1.0 - phase;',
    '    float live = step(0.55, hash11(col * 7.1 + floor(t / cyc)));',
    '    float dy = ny - dropY;',
    '    float smear = (dy > 0.0) ? exp(-dy * rows * 0.55) : exp(-pow(dy * rows * 1.2, 2.0));',
    '    br = clamp(smear * live * 1.25 * u_bright, 0.0, 1.0);',
    '    ph = fract(hash11(col * 3.3) + ny * 0.2);',
    '  } else if (u_pattern == 14) {',
    '// ── equalizer (new) ────────────────────────────────────────────────────',
    '// Bars grow out of the vertical centre in both directions, with a beat',
    '// pulse that lifts the whole wall every ~2 s.',
    '    rate = 7.0;',
    '    float binW = max(2.0, floor(cols / 20.0));',
    '    float bin = floor(col / binW);',
    '    float ph1 = t * (1.2 + hash11(bin * 2.3) * 1.8) + bin * 0.9;',
    '    float h = abs(sin(ph1)) * 0.42 + 0.10;',
    '    float d = abs(ny - 0.5);',
    '    float bar = smoothstep(h + 0.015, h - 0.015, d);',
    '    float beat = pow(max(0.0, sin(t * 3.14159)), 8.0);',
    '    br = clamp(bar * (0.85 + beat * 0.6) * u_bright, 0.0, 1.0);',
    '    ph = fract(0.5 - d * 1.4 + t * 0.05);',
    '  } else if (u_pattern == 15) {',
    '// ── static (new) ───────────────────────────────────────────────────────',
    '// Snow with a horizontal interference band rolling through it; the band',
    '// splits the noise into two palettes so it never looks like flat grain.',
    '    rate = 14.0;',
    '    float n = hash21(cell + vec2(floor(t * 24.0) * 1.37, floor(t * 24.0) * 2.71));',
    '    float band = exp(-pow((ny - fract(t * 0.18)) * 6.0, 2.0));',
    '    float scan = 0.5 + 0.5 * sin(ny * rows * 1.3 + t * 9.0);',
    '    br = clamp(pow(n, 1.5) * (0.22 + 0.95 * band) * (0.70 + 0.45 * scan) * u_bright, 0.0, 1.0);',
    '    ph = fract(n * 0.8 + band * 0.4 + t * 0.03);',
    '  } else {',
    '// ── heartbeat (new) ────────────────────────────────────────────────────',
    '// An ECG sweep: the trace is a piecewise function of horizontal position,',
    '// the head travels left to right, and the lit part fades behind it.',
    '    rate = 9.0;',
    '    float u = nx;',
    '    float q = fract(u + t * 0.22);   // head sweeps L→R once per ~4.5 s',
    '    float ecg = 0.0;',
    '    if (q < 0.10) ecg = 0.0;',
    '    else if (q < 0.16) ecg = (q - 0.10) / 0.06 * 0.32;',
    '    else if (q < 0.20) ecg = 0.32 - (q - 0.16) / 0.04 * 1.10;',
    '    else if (q < 0.24) ecg = -0.78 + (q - 0.20) / 0.04 * 1.95;',
    '    else if (q < 0.29) ecg = 1.17 - (q - 0.24) / 0.05 * 1.50;',
    '    else if (q < 0.34) ecg = -0.33 + (q - 0.29) / 0.05 * 0.33;',
    '    else if (q < 0.50) ecg = (0.50 - q) / 0.16 * 0.10;',
    '    else ecg = 0.0;',
    '    float traceY = 0.5 - ecg * 0.36;',
    '    float dy = (ny - traceY) * rows;',
    '    float line = exp(-dy * dy * 2.2);',
    '    float head = exp(-pow(q * 40.0, 2.0)) * 0.5;',
    '    float gate = smoothstep(1.02, 0.96, q);',
    '    br = clamp((line * 1.15 + head) * gate * u_bright, 0.0, 1.0);',
    '    ph = fract(traceY * 0.6 + t * 0.05);',
    '  }',
    '',
    '  float k = 1.0 - exp(-max(u_dt, 0.0) * rate * u_transition);',
    '  cur += (br - cur) * k;',
    '  if (u_persistence > 0.001) cur = max(cur, prev.r * u_persistence);',
    '  cur = clamp(cur, 0.0, 1.0);',
    '',
    '// The fence is composited last, so it wins over any pattern: the ring marks the window',
    '// edge, and outside the window the wall holds `u_outDim` of its brightness.',
    '  if (fenceOn > 0.5) {',
    '    br *= u_outDim;',
    '    cur *= u_outDim;',
    '    if (u_fenceLight > 0.001) {',
    '// A one-cell ring just inside the window: the lit frame the operator asked for.',
    '      float ring = (p.x < 1.0 || p.y < 1.0 || p.x > cols - 2.0 || p.y > rows - 2.0) ? 1.0 : 0.0;',
    '      br = mix(br, 1.0, ring);',
    '      cur = mix(cur, u_fenceLight, ring);',
    '      ph = mix(ph, 0.08, ring);',
    '    }',
    '  }',
    '',
    '  outState = vec4(cur, br, ph, cd);',
    '}'
  ].join('\n');

  // ── Text bitmap (rich runs) ────────────────────────────────────────────────
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  function hexToRgb(s) {
    var h = String(s || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    if (!isFinite(v) || h.length !== 6) return null;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  // ── run colour: the palette space the wall's LED shader can carry ─────────
  // One cell carries ONE colour value: a sample index into the block's palette
  // LUT, or the literal block colour (`v_pal < -0.5`).  A run therefore cannot
  // carry an arbitrary literal — the LED fragment shader has no per-cell RGB —
  // so a hex run colour is snapped to the nearest of the palette's samples, and
  // 'palette' is the block's own scrolling gradient (no lookup at all).
  //
  // The cell's byte lives in the bitmap's blue channel (r/g are ink), so the
  // encoding is: 0 = inherit the block, 255 = the block's gradient, 1..254 =
  // LUT sample (byte - 1) — i.e. samples 0..253.  The two most extreme samples
  // are spent as sentinels; adjacent samples of a 256-step ramp differ by ~1/255
  // per channel, so nothing visible is lost and the snap search never has to
  // clamp silently.
  //
  // The LUT costs one 1 KB build per palette change and one 254-step scan per
  // distinct hex *per raster*; nothing here runs per frame.
  var COLOUR_INHERIT = 0, COLOUR_PALETTE = 255, COLOUR_MAX_SAMPLE = 253;
  var lutCache = { key: null, lut: null };
  function paletteLUT() {
    var gr = window.LEDWALL_GRADE;
    var inst = window.LEDWALL_INSTANCE;
    var eff = (inst && inst.eff) || window.LEDWALL_DEFAULTS || {};
    var name = eff.palette || 'neonwave';
    var weight = (eff.paletteWeight == null) ? 1 : eff.paletteWeight;
    var key = name + '|' + weight;
    if (lutCache.key !== key) {
      var hexes = (window.LEDWALL_PALETTES || {})[name];
      lutCache.lut = (gr && hexes) ? gr.buildLUT(hexes, weight) : null;
      lutCache.key = key;
    }
    return lutCache.lut;
  }
  /** Nearest sample of the block's palette ramp to an rgb triple (0..1). */
  function snapColour(rgb) {
    var lut = paletteLUT();
    if (!lut || !rgb) return null;
    var r = rgb[0] * 255, g2 = rgb[1] * 255, b = rgb[2] * 255;
    var best = 0, bd = Infinity;
    for (var i = 0; i <= COLOUR_MAX_SAMPLE; i++) {
      var dr = lut[i * 4] - r, dg = lut[i * 4 + 1] - g2, db = lut[i * 4 + 2] - b;
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return {
      i: best,
      rgb: [lut[best * 4], lut[best * 4 + 1], lut[best * 4 + 2]]
    };
  }

  function cssHex(rgb) {
    if (!rgb) return null;
    var h = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.max(0, Math.min(255, Math.round(rgb[i]))).toString(16);
      h += v.length < 2 ? '0' + v : v;
    }
    return h;
  }

  /**
   * Rasterise the ENGINE-API TEXT object into a 2*cols × rows bitmap — one texel
   * per LED cell.  Layout happens in *cell* units, so a block laid out for a
   * 9:16 safe-area column and the same block on the portrait page come out
   * proportional (both pages have a 22.86 px cell pitch at scale 2).
   *
   *   r = glyph coverage
   *   g = the cell's place in the type-on order, to be divided by r (see SIM_FRAG)
   *
   * The block is drawn twice (once per half) so a wrapping scroll offset stays
   * seamless.  Rasterised at 8× and box-filtered down so thin strokes survive.
   *
   * Called only when the text object / grid / ratio changes — never per frame.
   */
  // Scratch surfaces live for the page's lifetime: creating a canvas per
  // raster costs a surface allocation, and `willReadFrequently` keeps the 2D
  // context on the CPU path where a cell-sized bitmap belongs.
  var scratch = { out: null, octx: null, hi: null, g: null };

  function makeTextCanvas(text, cols, rows, opts) {
    opts = opts || {};
    var t = (typeof text === 'string')
      ? { paras: [{ align: 'center', runs: [{ t: text }] }], style: {} }
      : (text || {});
    var st = t.style || {};

    var W = Math.max(2, cols * 2);
    var H = Math.max(1, rows);
    if (!scratch.out) {
      scratch.out = document.createElement('canvas');
      scratch.octx = scratch.out.getContext('2d', { willReadFrequently: true });
      scratch.hi = document.createElement('canvas');
      scratch.g = scratch.hi.getContext('2d', { willReadFrequently: true });
    }
    var out = scratch.out;
    if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
    var octx = scratch.octx;
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, W, H);

    // ── families ────────────────────────────────────────────────────────────
    // `LEDWALL_DEFAULTS.text.fonts` is the key → CSS map (config.js).  A run
    // names a key in `f`; the block names one in `style.font`, and the block
    // keeps accepting a raw CSS family string (what every release before this
    // one shipped), so an unknown key at block level is still that string.
    var FONTS = (window.LEDWALL_DEFAULTS && LEDWALL_DEFAULTS.text &&
                 LEDWALL_DEFAULTS.text.fonts) || {};
    var MONO = FONTS.mono || '"Courier New", monospace';
    function familyKeyOf(css) {
      for (var fk in FONTS) if (FONTS[fk] === css) return fk;
      return null;
    }
    var family, blockFamilyKey;
    if (st.font == null || st.font === '') {
      family = MONO;
    } else if (FONTS[st.font]) {
      family = FONTS[st.font];
    } else {
      family = String(st.font);
    }
    blockFamilyKey = familyKeyOf(family) || String(st.font || 'mono');

    // ── collect paragraphs (uppercase applied at the run level) ─────────────
    var upper = !!st.uppercase;
    var ps = [];
    var src = (t.paras && t.paras.length) ? t.paras : [];
    var colourSeen = {};                             // hex → resolved sample, per raster
    function resolveColour(spec) {
      if (spec == null || spec === '') return { b: COLOUR_INHERIT, req: null, got: null };
      if (spec === 'palette') return { b: COLOUR_PALETTE, req: 'palette', got: null };
      var hex = String(spec).trim().toLowerCase();
      var hit = colourSeen[hex];
      if (!hit) {
        var rgb = hexToRgb(hex);
        if (!rgb) { hit = colourSeen[hex] = { b: COLOUR_INHERIT, req: String(spec), got: null }; }
        else {
          var snap = snapColour(rgb);
          hit = colourSeen[hex] = snap
            ? { b: snap.i + 1, req: hex, got: cssHex(snap.rgb) }
            : { b: COLOUR_INHERIT, req: hex, got: null };
        }
      }
      return hit;
    }
    for (var pi = 0; pi < src.length; pi++) {
      var p = src[pi] || {};
      var runs = [], any = false;
      var rin = (p.runs && p.runs.length) ? p.runs : [{ t: '' }];
      for (var ri = 0; ri < rin.length; ri++) {
        var r = rin[ri] || {};
        var str = String(r.t == null ? '' : r.t);
        if (upper) str = str.toUpperCase();
        if (str) any = any || /\S/.test(str);
        runs.push({
          t: str, b: !!r.b, i: !!r.i, u: !!r.u, rid: ri,
          // an unknown family key falls back to mono, not to the block
          fk: (r.f == null || r.f === '') ? null : (FONTS[r.f] ? String(r.f) : 'mono'),
          sz: sizeFor(r.s),
          c: resolveColour(r.c)
        });
      }
      if (any) ps.push({ align: p.align || 'center', runs: runs });
    }
    if (!ps.length) {
      out.charTotal = 0;
      out.fitInfo = {
        scale: 1, lines: 0, rows: [], overflow: false, fontCells: 0, box: [0, 0],
        underlineRows: 0, runSizes: [], runCells: [], families: [], colours: []
      };
      return out;                                     // all black
    }

    var SS = 4;
    var hi = scratch.hi;
    if (hi.width !== W * SS || hi.height !== H * SS) {
      hi.width = W * SS;
      hi.height = H * SS;
    }
    var g = scratch.g;
    g.fillStyle = '#000';
    g.fillRect(0, 0, hi.width, hi.height);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    // ── band: safe area confines the block before any glyph is drawn ────────
    var ratio = opts.ratio || '16:9';
    var safe = (t.safeArea === '9x16') ? '9x16' : 'off';
    var bandFrac = 1;
    if (safe === '9x16' && ratio === '16:9') bandFrac = (9 / 16) / (16 / 9); // 0.3164
    var halfCells = cols;                            // one half of the bitmap
    var bandCells = halfCells * bandFrac;
    var bandH = (safe === '9x16') ? bandCells * 16 / 9 : rows;

    var sizeScale = num(st.size, 0.8);
    var tracking = num(st.tracking, 0);
    var maxW = bandCells * 0.92;          // inner margin, 4 % a side
    var maxH = bandH * 0.88;
    var fitMode = (st.fit === 'none') ? 'none' : 'auto';
    var LINE = 1.18;                      // line height, as a multiple of the font height
    // Legibility floor.  A 3-row line turns long messages into mush at LED
    // scale (the owner has seen it): a 5-row line still resolves a glyph's
    // bowls.  Below this the block is ellipsised instead of shrunk further.
    // Both the font height and the line pitch are WHOLE CELLS: a fractional
    // font height (9.35 cells) puts every stem at a different sub-cell offset,
    // so the cell sampler averages the stroke across two cells and the whole
    // block renders as graded grey instead of lit cells.  The fit searches
    // integer heights only, and the pitch is rounded from the integer height.
    var MIN_FONT = 5;                     // floor: a glyph is never shorter than 5 cells
    function lineHFor(f) { return Math.max(1, Math.round(f * LINE)); }
    // ── per-run size ─────────────────────────────────────────────────────────
    // `s` is a multiplier of the block's fitted height on a fixed allowlist, so
    // a run cannot invent an off-grid glyph height (a fractional height puts
    // every stem at a different sub-cell offset — see the note above).
    var SIZE_STEPS = [0.8, 1, 1.25, 1.5];
    function sizeFor(v) {
      if (v == null || v === '') return 1;
      var x = Number(v);
      if (!isFinite(x) || x <= 0) return 1;
      var best = 1, bd = Infinity;
      for (var si = 0; si < SIZE_STEPS.length; si++) {
        var d = Math.abs(SIZE_STEPS[si] - x);
        if (d < bd - 1e-9) { bd = d; best = SIZE_STEPS[si]; }
      }
      return best;                        // nearest step; a tie keeps the smaller
    }
    // Binarisation is opt-in per message.  0 (the default) emits the graded
    // coverage the wall has always shipped: on a dot-matrix shader a partly-lit
    // cell is the dim dot that bridges two bright ones, so removing it reads as
    // a broken stroke at small cell heights (measured: 70 chars at 9 cells loses
    // 41 % of its ink to binarisation).  A value in (0.04, 1] lights a cell fully
    // when its area coverage reaches it, which is the crisper look at 10+ cells.
    // The block is laid out on integer cells either way.
    var cellThreshold = num(st.cellThreshold, 0);
    var gradedText = (cellThreshold === 0);
    if (!gradedText && !(cellThreshold > 0.04 && cellThreshold <= 1)) cellThreshold = 0;

    // ── atoms: words and the spaces between them, each carrying its style ───
    var atomsPerPara = [];
    for (var a = 0; a < ps.length; a++) {
      var atoms = [];
      for (var b = 0; b < ps[a].runs.length; b++) {
        var run = ps[a].runs[b];
        var parts = run.t.split(/(\s+)/);
        for (var c = 0; c < parts.length; c++) {
          if (!parts[c]) continue;
          atoms.push({
            s: parts[c], b: run.b, i: run.i, sp: /^\s+$/.test(parts[c]),
            u: run.u, fk: run.fk, sz: run.sz, c: run.c, rid: run.rid
          });
        }
      }
      atomsPerPara.push(atoms);
    }

    var measureCache = {};
    // A run's own family, or the block's when it names none.
    function familyFor(atom) {
      return (atom && atom.fk && FONTS[atom.fk]) ? FONTS[atom.fk] : family;
    }
    // The run's effective glyph height in whole cells: the block's fitted height
    // scaled by the run's size step, clamped to the legibility floor and to the
    // tallest height the box can hold (a 1.5x run must not grow past the fit).
    function cellsFor(atom, fontCells) {
      var sz = (atom && atom.sz) || 1;
      if (sz === 1) return fontCells;                  // the legacy path, exactly
      var h = Math.round(fontCells * sz);
      if (h < MIN_FONT) h = MIN_FONT;
      if (maxFont && h > maxFont) h = maxFont;
      return h;
    }
    function fontFor(atom, fontCells) {
      return (atom.i ? 'italic ' : '') + (atom.b ? '700 ' : '400 ') +
             (cellsFor(atom, fontCells) * SS).toFixed(2) + 'px ' + familyFor(atom);
    }
    function widthOf(atom, fontCells) {
      var f = fontFor(atom, fontCells);
      var key = f + '\u0000' + atom.s;
      var w = measureCache[key];
      if (w === undefined) {
        g.font = f;
        w = g.measureText(atom.s).width / SS;        // → cells
        measureCache[key] = w;
      }
      return w;
    }

    // Per-glyph advance, cached per font string: the marquee copy and repeated
    // letters cost nothing on the second pass.
    var charCache = {};
    function charWidth(ch, f) {
      var k = f + '\u0000' + ch;
      var w = charCache[k];
      if (w === undefined) { w = g.measureText(ch).width / SS; charCache[k] = w; }
      return w;
    }

    // The ellipsis stays regular weight (as it always has) but follows the run
    // it replaces in family and size, so a 1.5x line does not end in a tiny dot.
    function ellAtom(tail) {
      return {
        s: '\u2026', b: false, i: false, sp: false, ell: true, u: false,
        fk: tail ? tail.fk : null, sz: tail ? (tail.sz || 1) : 1,
        c: tail ? tail.c : null, rid: tail ? tail.rid : -1
      };
    }
    function atomW(at, fontCells) {
      return widthOf(at, fontCells) + (at.sp ? 0 : tracking);
    }
    function lineWidth(line, fontCells) {
      var w = 0;
      for (var i2 = 0; i2 < line.atoms.length; i2++) w += atomW(line.atoms[i2], fontCells);
      return w;
    }
    function trimTrailingSpace(line) {
      while (line.atoms.length && line.atoms[line.atoms.length - 1].sp) line.atoms.pop();
    }
    function wordsIn(line) {
      var n = 0;
      for (var i3 = 0; i3 < line.atoms.length; i3++) if (!line.atoms[i3].sp) n++;
      return n;
    }

    /** Greedy wrap of one paragraph; a paragraph is one entry in `ps`. */
    function wrapPara(atomsIn, p, fontCells) {
      var outL = [];
      var line = { atoms: [], w: 0, p: p };
      var tooWide = false;
      for (var m = 0; m < atomsIn.length; m++) {
        var at = atomsIn[m];
        var aw = atomW(at, fontCells);
        if (!at.sp && line.atoms.length && line.w + aw > maxW) {
          trimTrailingSpace(line);
          line.w = lineWidth(line, fontCells);
          outL.push(line);
          line = { atoms: [], w: 0, p: p };
        }
        if (!line.atoms.length && at.sp) continue;    // no leading space after a wrap
        line.atoms.push(at);
        line.w += aw;
        // A word wider than the box cannot be wrapped: it is *tested here*, on a
        // line of its own.  Testing only at a wrap point (the old place) missed a
        // message that is one word, so a single word "fit" at the top rung and
        // overran the box.  The line is kept (not discarded) so the floor can
        // still show a truncated prefix plus an ellipsis.
        if (!at.sp && aw > maxW) {
          tooWide = true;
          trimTrailingSpace(line);
          line.w = lineWidth(line, fontCells);
          outL.push(line);
          break;
        }
      }
      if (!tooWide) { trimTrailingSpace(line); line.w = lineWidth(line, fontCells); outL.push(line); }

      // A one-word last line next to a multi-word line above it reads as a
      // mis-wrap at LED scale: pull the previous word down instead.
      if (!tooWide && outL.length > 1) {
        var last = outL[outL.length - 1], prev = outL[outL.length - 2];
        if (wordsIn(last) === 1 && wordsIn(prev) >= 2) {
          var moved = [];
          while (prev.atoms.length) {
            var a2 = prev.atoms.pop();
            moved.unshift(a2);
            if (!a2.sp) break;
          }
          trimTrailingSpace(prev);
          prev.w = lineWidth(prev, fontCells);
          var rebuilt = moved.concat([{ s: ' ', b: false, i: false, sp: true }], last.atoms);
          var rw = lineWidth({ atoms: rebuilt }, fontCells);
          if (rw <= maxW) { last.atoms = rebuilt; last.w = rw; }
          else { prev.atoms = prev.atoms.concat(moved); prev.w = lineWidth(prev, fontCells); }
        }
      }
      return { lines: outL, tooWide: tooWide };
    }

    /** Full layout at a trial font size. */
    function wrapAll(fontCells) {
      var lines = [], tooWide = false;
      for (var q = 0; q < atomsPerPara.length; q++) {
        var r = wrapPara(atomsPerPara[q], q, fontCells);
        tooWide = tooWide || r.tooWide;
        for (var k = 0; k < r.lines.length; k++) lines.push(r.lines[k]);
      }
      // Per line: the tallest glyph on it and whether it carries a rule.  A line
      // with a 1.5x run is pitched for that run, so mixed sizes stay on the grid
      // (legacy: every run is 1x, so every height is lineHFor(fontCells)).
      var lineH = lineHFor(fontCells);
      var heights = [], blockH = 0;
      for (var w = 0; w < lines.length; w++) {
        var mx = 0, rule = false;
        for (var ai = 0; ai < lines[w].atoms.length; ai++) {
          var at2 = lines[w].atoms[ai];
          var hh = cellsFor(at2, fontCells);
          if (hh > mx) mx = hh;
          if (at2.u && !at2.sp && !at2.ell) rule = true;
        }
        if (!mx) mx = fontCells;
        var lh = lineHFor(mx);
        // A rule sits at baseline+1 — one row below the last glyph row.  At the
        // 5-cell floor that row is the next line's first row, so an underlined
        // line takes one extra cell of pitch: the room the rule needs is inside
        // the block, never outside the box.
        if (rule && Math.round(lh * 0.5 + mx * 0.34) + 1 >= lh) lh += 1;
        heights.push(lh);
        blockH += lh;
        if (lh > lineH) lineH = lh;
      }
      // Width is a fit condition in its own right.  `w` is the drawn advance of
      // the line (glyph advances + tracking), so a line wider than maxW is
      // clipped by the box edge; height alone must never certify a fit.
      var widest = 0;
      for (var w2 = 0; w2 < lines.length; w2++) if (lines[w2].w > widest) widest = lines[w2].w;
      return {
        lines: lines, tooWide: tooWide, lineH: lineH, heights: heights,
        blockH: blockH, widest: widest,
        fits: !tooWide && widest <= maxW + 1e-6 && blockH <= maxH
      };
    }

    // ── fit ─────────────────────────────────────────────────────────────────
    // `size` is the requested size; in 'auto' it is a maximum and the whole
    // block scales down until it fits the box.  The search is over WHOLE CELL
    // font heights, so the block always lands on the LED grid: 9 cells means
    // exactly 9, never 9.35.
    var sizeMax = (maxH / LINE) * sizeScale;    // size = one line filling the box
    var fontCells, lay, scaleUsed = 1, overflow = false, ellipsised = false;
    var maxFont = Math.floor(sizeMax);
    if (maxFont < 1) maxFont = 1;

    if (fitMode === 'none') {
      fontCells = Math.max(1, Math.round(sizeMax / Math.max(1, ps.length) * 0.82));
      lay = wrapAll(fontCells);
      overflow = !lay.fits;
      scaleUsed = Math.min(1, fontCells / sizeMax);
    } else {
      // `fits` is monotone in font height, so binary-search the integers
      // [MIN_FONT .. maxFont]: ~6 layout passes instead of 50 rungs.
      lay = null;
      var trace = opts.debug ? [] : null;
      var lo = MIN_FONT, hiIdx = maxFont, best = 0;
      while (lo <= hiIdx) {
        var mid = (lo + hiIdx) >> 1;
        var tM = wrapAll(mid);
        if (trace) trace.push({ font: mid, fits: tM.fits, tooWide: tM.tooWide, lines: tM.lines.length, h: tM.lines.length * tM.lineH });
        if (tM.fits) { best = mid; lo = mid + 1; } else { hiIdx = mid - 1; }
      }
      if (best > 0) {
        fontCells = best;
        lay = wrapAll(fontCells);
        scaleUsed = Math.min(1, fontCells / sizeMax);
      }
      if (!lay) {
        // No integer height fits.  The contract's last resort is the legibility
        // floor: lay out at the floor, and only ellipsise if *that* overflows.
        fontCells = MIN_FONT;
        lay = wrapAll(fontCells);
        overflow = !lay.fits;
        if (lay.fits) {
          scaleUsed = Math.min(1, MIN_FONT / sizeMax);
        } else {
          scaleUsed = Math.min(1, MIN_FONT / sizeMax);
          var maxLines = Math.max(1, Math.floor(maxH / lay.lineH));
          var cutTail = lay.lines.length > maxLines;
          if (cutTail) lay.lines = lay.lines.slice(0, maxLines);
          // A line that is still wider than the box at the floor would be drawn
          // past the edge (clipped).  Ellipsise those too, so overflow:true and
          // the picture agree: every visible line ends inside maxW.  The last
          // line only earns an ellipsis when content was actually dropped —
          // either lines beyond maxLines or its own tail — so a complete last
          // line is never marked as truncated.
          for (var oi = 0; oi < lay.lines.length; oi++) {
            var ol = lay.lines[oi];
            var olLast = (oi === lay.lines.length - 1);
            if (ol.w <= maxW && !(olLast && cutTail)) continue;
            trimTrailingSpace(ol);
            // Shed whole atoms first: a word boundary is the cheapest cut.
            while (ol.atoms.length > 1 &&
                   lineWidth({ atoms: ol.atoms.concat([ellAtom(ol.atoms[ol.atoms.length - 1])]) }, fontCells) > maxW) {
              ol.atoms.pop();
              trimTrailingSpace(ol);
            }
            if (ol.atoms.length &&
                lineWidth({ atoms: ol.atoms.concat([ellAtom(ol.atoms[ol.atoms.length - 1])]) }, fontCells) > maxW) {
              // The one remaining atom is itself wider than the box, so trim it
              // character by character: an unbreakable word that is still too
              // wide at the floor keeps a visible prefix and an ellipsis instead
              // of vanishing from the wall.
              var tail = ol.atoms[ol.atoms.length - 1];
              var head = ol.atoms.slice(0, ol.atoms.length - 1);
              var keep = tail.sp ? '' : tail.s;
              function keptTail(str) {
                return {
                  s: str, b: tail.b, i: tail.i, sp: false, u: tail.u,
                  fk: tail.fk, sz: tail.sz, c: tail.c, rid: tail.rid
                };
              }
              while (keep.length > 0 &&
                     lineWidth({
                       atoms: head.concat([keptTail(keep), ellAtom(tail)])
                     }, fontCells) > maxW) {
                keep = keep.slice(0, keep.length - 1);
              }
              ol.atoms = keep.length
                ? head.concat([keptTail(keep), ellAtom(tail)])
                : head.concat([ellAtom(tail)]);
            } else {
              ol.atoms = ol.atoms.concat([ellAtom(ol.atoms[ol.atoms.length - 1])]);
            }
            ol.w = lineWidth(ol, fontCells);
            ellipsised = true;
          }
        }
      }
      if (trace) out.fitTrace = trace;
    }

    var lines = lay.lines, lineH = lay.lineH;

    // ── final metrics: the floor path above may have rewritten the lines ─────
    // Same rule as wrapAll's fit: a line is pitched for its tallest run, and an
    // underlined line whose rule would land on the next line's first row takes
    // one extra cell of pitch, so the rule is always inside the block.
    var lineTops = [], blockH = 0;
    lineH = 0;
    for (var lm = 0; lm < lines.length; lm++) {
      var Lm = lines[lm], mxm = 0, rlm = false;
      for (var am = 0; am < Lm.atoms.length; am++) {
        var atm = Lm.atoms[am];
        var hm = cellsFor(atm, fontCells);
        if (hm > mxm) mxm = hm;
        if (atm.u && !atm.sp && !atm.ell) rlm = true;
      }
      if (!mxm) mxm = fontCells;
      var lhm = lineHFor(mxm);
      if (rlm && Math.round(lhm * 0.5 + mxm * 0.34) + 1 >= lhm) lhm += 1;
      Lm.h = lhm; Lm.mx = mxm; Lm.rule = rlm;
      lineTops.push(blockH);
      blockH += lhm;
      if (lhm > lineH) lineH = lhm;
    }

    // ── draw, twice, with per-character reveal order in the green channel ───
    var total = 0;
    for (var tl = 0; tl < lines.length; tl++) {
      for (var ta = 0; ta < lines[tl].atoms.length; ta++) {
        total += lines[tl].atoms[ta].sp ? 0 : lines[tl].atoms[ta].s.length;
      }
    }
    if (!total) return out;

    // Whole-cell block origin: a fractional top edge shifts every glyph row by
    // a fraction of a cell, which the sampler then averages across two rows.
    var topCell = Math.round((bandH - blockH) * 0.5);  // cells from the band top
    var charIdx = 0;
    var alignF = { left: 0, center: 0.5, right: 1 };
    // Glyphs drawn on copy 0, kept so the anti-dropout pass can re-render any
    // single glyph in isolation.  Copy 1 is identical by construction (same
    // glyphs at x + halfCells), so it gets the same cells patched.
    var glyphs = [];
    // One rule per (line, run) segment, so a run that wraps gets one rule per
    // line instead of a bar across the block.
    var rules = [];
    // Cells that carry a run colour, in copy-0 cell coordinates: {x0,x1,y0,y1,m,b}.
    var colourRects = [];

    for (var copy = 0; copy < 2; copy++) {
      var bandX = (halfCells - bandCells) * 0.5 + copy * halfCells;
      for (var li = 0; li < lines.length; li++) {
        var L = lines[li];
        var align = (ps[L.p] && ps[L.p].align) || 'center';
        var af = alignF[align] === undefined ? 0.5 : alignF[align];
        // Round the line's origin to a whole cell so its stems share one grid
        // phase; the ±0.5 cell shift is well inside the 4 % side margin.
        var x = Math.round(bandX + (bandCells - L.w) * af);
        var lineTopCell = topCell + lineTops[li];
        var baseYcell = Math.round(lineTopCell + L.h * 0.5 + L.mx * 0.34);
        var baseY = baseYcell * SS;
        for (var ai = 0; ai < L.atoms.length; ai++) {
          var atom = L.atoms[ai];
          var f = fontFor(atom, fontCells);
          g.font = f;
          var atomX0 = Math.round(x);
          for (var ci = 0; ci < atom.s.length; ci++) {
            var ch = atom.s[ci];
            var w = charWidth(ch, f);
            var ord = 0;
            // Every glyph is drawn at a WHOLE-CELL pen position.  A fractional
            // pen (`x += w` accumulated) is what put glyph n+1 at a different
            // sub-cell phase from glyph n: at 10 cells the stem of one letter
            // straddled two cells (0.55 / 0.45) and the next letter's stem
            // landed inside one (1.00), so binarised strokes alternated between
            // solid and broken.  Quantising the pen keeps one phase for the
            // whole line; the ≤0.5 cell snap is well inside the side margin and
            // never changes `L.w`, so the fit and the wrap are untouched.
            var penCell = Math.round(x);
            if (!atom.sp) {
              charIdx++;
              ord = Math.round(255 * (charIdx / total));
              g.fillStyle = 'rgb(255,' + ord + ',0)';
              if (copy === 0 && /\S/.test(ch)) {
                glyphs.push({
                  ch: ch, f: f, x: penCell, adv: w, ord: ord,
                  y0: lineTopCell, y1: lineTopCell + L.h, baseY: baseYcell
                });
              }
            }
            g.fillText(ch, penCell * SS, baseY);
            x += w + (atom.sp ? 0 : tracking);
          }
          if (copy === 0 && atom.u && !atom.sp && !atom.ell) {
            var segEnd = Math.round(x);
            if (segEnd > atomX0) {
              var prevSeg = rules.length ? rules[rules.length - 1] : null;
              if (prevSeg && prevSeg.li === li && prevSeg.rid === atom.rid) {
                prevSeg.x1 = Math.max(prevSeg.x1, segEnd);   // interior space
              } else {
                rules.push({
                  li: li, rid: atom.rid, x0: atomX0, x1: segEnd,
                  row: baseYcell + 1, c: atom.c
                });
              }
            }
          }
          if (copy === 0 && atom.c && !atom.sp && !atom.ell) {
            var cEnd = Math.round(x);
            if (cEnd > atomX0) {
              colourRects.push({
                x0: atomX0, x1: cEnd, y0: lineTopCell, y1: lineTopCell + L.h,
                b: atom.c.b
              });
            }
          }
        }
      }
    }

    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, W, H);
    octx.drawImage(hi, 0, 0, W, H);

    // ── binarise: one cell is either lit or dark ────────────────────────────
    // The supersampled composite above is a *measurement* of how much of each
    // cell the glyphs cover; a cell is lit when that coverage reaches
    // `cellThreshold`.  Emitting the graded value instead is what made 50–70
    // char blocks look washed: nearly every stroke cell was partly lit, so the
    // stroke weight wandered cell to cell and the counters greyed out.
    // "Inked" is coverage >= INK, not >= any antialias fringe: a fringe cell is
    // a by-product of the sampler, and lighting fringes would fatten every
    // stroke to two cells (measured: 1582 cells "recovered" out of 1646 with a
    // 0.04 fringe bar, i.e. patch-everything).  Measured per glyph, not assumed.
    var INK = 0.25;
    var cellStats = { saturated: 0, partial: 0, dark: 0 };
    var inkCells = 0;                                 // coverage >= INK, pre-threshold
    var img = null;
    try { img = octx.getImageData(0, 0, W, H); } catch (eCov) { img = null; }
    // The pre-threshold coverage, kept whole: the gap repair and the debug hook
    // both need it, and it is one byte per texel (a 63x112 bitmap is 14 KB).
    var covSnap = img ? new Uint8Array(W * H) : null;
    if (img) {
      var px = img.data;
      for (var pI = 0, nC = W * H; pI < nC; pI++) {
        var o4 = pI * 4;
        var rV = px[o4];
        if (rV >= 250) cellStats.saturated++;
        else if (rV > 0) cellStats.partial++;
        else cellStats.dark++;
        if (rV >= INK * 255) inkCells++;
        if (covSnap) covSnap[pI] = rV;
        var lit = gradedText || rV >= cellThreshold * 255;
        px[o4] = gradedText ? rV : (lit ? 255 : 0);
        // Ord is stored coverage-weighted (see the shader): divide it back out
        // so `reveal` keeps its per-character order on a binarised cell.
        px[o4 + 1] = lit ? Math.min(255, Math.round((px[o4 + 1] * 255) / (rV || 1))) : 0;
      }
      octx.putImageData(img, 0, 0);
    }

    // ── anti-dropout: no glyph may lose a stroke to the threshold ───────────
    // A 1-cell stem is fine; a stem that lands on a cell boundary can split
    // into two sub-threshold halves and vanish.  Each glyph is re-rendered in
    // isolation and its inked cells counted: if the threshold drops more than
    // 8 % of them, that glyph is patched back with its own coverage-ranked
    // cut-off (its strongest cells), so the number of strokes is preserved.
    var dropoutGlyphs = 0, recoveredCells = 0, glyphCells = 0, glyphLit = 0;
    var worstLoss = 0;                                // worst per-glyph stroke loss, %
    if (img && glyphs.length && !gradedText) {
      if (!scratch.gch) {
        scratch.gch = document.createElement('canvas');
        scratch.gctx = scratch.gch.getContext('2d', { willReadFrequently: true });
        scratch.gcv = document.createElement('canvas');
        scratch.gcvx = scratch.gcv.getContext('2d', { willReadFrequently: true });
      }
      var gch = scratch.gch, gctx = scratch.gctx, gcv = scratch.gcv, gcvx = scratch.gcvx;
      for (var gi = 0; gi < glyphs.length; gi++) {
        var G = glyphs[gi];
        var gx0 = Math.floor(G.x), gx1 = Math.max(gx0 + 1, Math.ceil(G.x + G.adv));
        var gy0 = G.y0, gy1 = G.y1;
        var cw = gx1 - gx0, chh = gy1 - gy0;
        if (cw > 64 || chh > 160) continue;              // absurd: skip the check
        if (gch.width < cw * SS || gch.height < chh * SS) {
          gch.width = Math.max(gch.width, cw * SS);
          gch.height = Math.max(gch.height, chh * SS);
        }
        gctx.fillStyle = '#000';
        gctx.fillRect(0, 0, gch.width, gch.height);
        gctx.font = G.f;
        gctx.textAlign = 'left';
        gctx.textBaseline = 'alphabetic';
        gctx.fillStyle = '#fff';
        gctx.fillText(G.ch, (G.x - gx0) * SS, (G.baseY - gy0) * SS);
        if (gcv.width !== cw || gcv.height !== chh) { gcv.width = cw; gcv.height = chh; }
        gcvx.imageSmoothingEnabled = true;
        gcvx.imageSmoothingQuality = 'high';
        gcvx.fillStyle = '#000';
        gcvx.fillRect(0, 0, cw, chh);
        gcvx.drawImage(gch, 0, 0, cw * SS, chh * SS, 0, 0, cw, chh);
        var gdata;
        try { gdata = gcvx.getImageData(0, 0, cw, chh).data; } catch (eG) { continue; }
        var covs = [], covered = 0, litT = 0;
        for (var q2 = 0; q2 < cw * chh; q2++) {
          var cv2 = gdata[q2 * 4] / 255;
          covs.push(cv2);
          if (cv2 >= INK) covered++;
          if (cv2 >= cellThreshold) litT++;
        }
        glyphCells += covered;
        glyphLit += litT;
        var need = Math.ceil(covered * 0.92 - 1e-9);
        if (!covered) continue;
        if (litT >= need) {
          // Loss after the pass for a glyph left alone: at most 8 %, by the
          // condition above.  Tracked so the bound is measured, not asserted.
          worstLoss = Math.max(worstLoss, (covered - litT) / covered);
          continue;
        }
        // This glyph would lose strokes.  Light its strongest `need` cells.
        var sorted = covs.slice().sort(function (a2, b2) { return b2 - a2; });
        var cut = sorted[Math.min(sorted.length, need) - 1];
        if (!(cut >= INK)) cut = INK;
        dropoutGlyphs++;
        var cutLit = 0;
        for (var cy2 = 0; cy2 < chh; cy2++) {
          for (var cx2 = 0; cx2 < cw; cx2++) {
            if (covs[cy2 * cw + cx2] < cut) continue;
            cutLit++;
            var pxX = gx0 + cx2, pxY = gy0 + cy2;
            for (var half = 0; half < 2; half++) {
              var pxX2 = pxX + half * halfCells;
              if (pxX2 < 0 || pxX2 >= W || pxY < 0 || pxY >= H) continue;
              var oo = (pxY * W + pxX2) * 4;
              if (px[oo] < 255) recoveredCells++;
              px[oo] = 255;
              px[oo + 1] = G.ord;
            }
          }
        }
        worstLoss = Math.max(worstLoss, (covered - cutLit) / covered);
      }
      octx.putImageData(img, 0, 0);
    }

    // ── gap repair: a stem may not break into separated dots ────────────────
    // The dropout pass counts cells, and a count cannot see *continuity*: two
    // stems that each keep all their cells can still leave a sub-threshold cell
    // BETWEEN two lit ones, so a vertical stroke reads as dashes.  Measured on
    // the 65-char 9:16 block at 10 cells: 9 horizontal and 1 vertical such gaps,
    // each a cell with 0.26–0.49 coverage whose neighbours on both sides are
    // lit.  Any cell that carries real ink (>= GAPINK) and is flanked by lit
    // cells on both sides of one axis is lit.  Additive only — it can never
    // remove a cell the threshold or the dropout pass lit.
    var GAPINK = 0.22;
    var gapsRepaired = 0, gapsMeasured = 0;
    if (img && covSnap && !gradedText) {
      var cellAt = function (cx, cy) { return cy * W + cx; };
      var isLit = function (i) { return px[i * 4] >= 128; };
      // Two copies sit side by side in one bitmap; repair each on its own so a
      // patch cannot leap the seam between them.
      for (var cp = 0; cp < 2; cp++) {
        var x0 = cp * cols, x1 = x0 + cols;
        var adds = [];
        for (var cy = 1; cy < H - 1; cy++) {
          for (var cx = x0 + 1; cx < x1 - 1; cx++) {
            var ii = cellAt(cx, cy);
            if (isLit(ii)) continue;
            if (covSnap[ii] < GAPINK * 255) continue;
            var hGap = isLit(ii - 1) && isLit(ii + 1);
            var vGap = isLit(ii - W) && isLit(ii + W);
            if (!hGap && !vGap) continue;
            gapsMeasured++;
            adds.push(ii);
          }
        }
        for (var ad = 0; ad < adds.length; ad++) {
          var ja = adds[ad] * 4;
          px[ja] = 255;
          px[ja + 1] = 255;              // full reveal order: it is already late
          gapsRepaired++;
        }
      }
      octx.putImageData(img, 0, 0);
    }

    // ── run colour + underline: one readback for both ───────────────────────
    // r/g are ink (coverage, reveal order); the blue channel is the cell's
    // colour byte (see `resolveColour`), read by SIM_FRAG.  Nothing is written to
    // the alpha channel: a canvas stores premultiplied alpha, so a=0 would
    // destroy the very RGB the sample needs.
    //
    // The underline is a *cell*, not ink coverage: painted straight into the
    // bitmap, one row, at baseline + 1, across the run's drawn advance (glyph to
    // glyph, so trailing whitespace is not underlined while interior spaces,
    // being their own atoms of the same run, merge into one continuous rule).
    // Painted after the glyph passes so a descender cannot punch a hole in it:
    // the rule stays continuous and the descender sits on the same cell.
    var underlineRows = 0;
    if (colourRects.length || rules.length) {
      try {
        var fImg = octx.getImageData(0, 0, W, H);
        var fPx = fImg.data;
        for (var cr = 0; cr < colourRects.length; cr++) {
          var CR = colourRects[cr];
          var cx0 = Math.max(0, CR.x0), cx1 = Math.min(halfCells, CR.x1);
          for (var cy2 = Math.max(0, CR.y0); cy2 < Math.min(H, CR.y1); cy2++) {
            for (var hfc = 0; hfc < 2; hfc++) {
              for (var cx2 = cx0; cx2 < cx1; cx2++) {
                fPx[(cy2 * W + cx2 + hfc * halfCells) * 4 + 2] = CR.b;
              }
            }
          }
        }
        for (var rr = 0; rr < rules.length; rr++) {
          var R = rules[rr];
          if (R.row < 0 || R.row >= H) continue;
          var ux0 = Math.max(0, R.x0), ux1 = Math.min(halfCells, R.x1);
          if (ux1 <= ux0) continue;
          for (var xx = ux0; xx < ux1; xx++) {
            for (var hf = 0; hf < 2; hf++) {
              var oo2 = (R.row * W + xx + hf * halfCells) * 4;
              fPx[oo2] = 255;                   // full ink: one solid cell
              fPx[oo2 + 1] = 255;               // already revealed
              fPx[oo2 + 2] = R.c ? R.c.b : COLOUR_INHERIT;
            }
          }
          underlineRows = 1;
        }
        octx.putImageData(fImg, 0, 0);
      } catch (eU) { underlineRows = 0; }        // no readback: no rule, no colour
    }

    out.charTotal = total;                            // for reveal timing (ms/char)
    // Counters for the bitmap actually handed to the shader (after binarising
    // and after the dropout patches).  `cellStats` above is the *coverage*
    // measurement taken before the threshold; these are what the wall shows, so
    // `partial` can be compared directly: emitted should be lit + dark only.
    var emitted = { lit: 0, dark: 0 };
    try {
      var imgE = octx.getImageData(0, 0, W, H);
      for (var eI = 0, eN = W * H; eI < eN; eI++) {
        if (imgE.data[eI * 4] >= 128) emitted.lit++; else emitted.dark++;
      }
    } catch (eE) { emitted = null; }
    // ── run-attribute diagnostics (the numbers an operator can check) ───────
    var sizeSeen = {}, cellSeen = {}, famSeen = {}, colourSeenOut = {};
    var runSizes = [], runCells = [], famList = [], colours = [];
    for (var dl = 0; dl < lines.length; dl++) {
      for (var da = 0; da < lines[dl].atoms.length; da++) {
        var dAt = lines[dl].atoms[da];
        var dSz = dAt.sz || 1, dCell = cellsFor(dAt, fontCells);
        var dFam = familyKeyOf(familyFor(dAt)) || dAt.fk || blockFamilyKey;
        if (!sizeSeen[dSz]) { sizeSeen[dSz] = 1; runSizes.push(dSz); }
        if (!cellSeen[dCell]) { cellSeen[dCell] = 1; runCells.push(dCell); }
        if (!famSeen[dFam]) { famSeen[dFam] = 1; famList.push(dFam); }
        if (dAt.c && dAt.c.req && !dAt.sp && !dAt.ell && !colourSeenOut[dAt.c.req]) {
          colourSeenOut[dAt.c.req] = 1;
          colours.push({
            c: dAt.c.req,
            sample: dAt.c.req === 'palette' ? null : dAt.c.b - 1,
            rgb: dAt.c.got
          });
        }
      }
    }
    runSizes.sort(function (x, y) { return x - y; });
    runCells.sort(function (x, y) { return x - y; });
    famList.sort();
    // Debug only: the pre-threshold coverage map, so a stroke that survives as
    // *cells* but breaks as a *line* can be measured (see strokeContinuity).
    if (opts.debug && covSnap) out.covMap = covSnap;
    out.fitInfo = {
      scale: Math.round(scaleUsed * 1000) / 1000,
      lines: lines.length,
      rows: lines.map(function (l) { return Math.round(l.h || lineH); }),
      overflow: overflow,
      // True only when a visible line was actually shortened: the picture then
      // ends in an ellipsis, so the admin UI can say "truncated" honestly.
      ellipsis: ellipsised,
      fontCells: Math.round(fontCells * 100) / 100,
      box: [Math.round(maxW), Math.round(maxH)],      // widest drawn line advance vs the box width, in cells: the fit's width
      // side, reported so a clipped line is visible in diag() rather than guessed
      widest: Math.round(lines.reduce(function (mx, l) { return l.w > mx ? l.w : mx; }, 0) * 100) / 100,
      // Cell quantisation, reported so diag() can be checked against the wall:
      // a binarised block has partial = 0 and lit + dark = cells in the bitmap.
      cellThreshold: cellThreshold,
      cellStats: cellStats,
      emitted: emitted,
      // ── rich runs ─────────────────────────────────────────────────────────
      // underlineRows: 0/1 — the rule occupies exactly one cell row.
      // runSizes: distinct `s` multipliers in use, ascending.
      // runCells: their effective glyph heights in cells, ascending (a legacy
      //           block is [fontCells]); families: distinct family keys.
      underlineRows: underlineRows,
      runSizes: runSizes,
      runCells: runCells,
      families: famList,
      // A run's `c` lives in the palette's colour space: 'palette' is the block's
      // own gradient (mode 1, no index), a hex is the nearest of the 256 LUT
      // samples (mode 2, index) — rgb is what that sample actually is on the wall.
      colours: colours,
      // Anti-dropout, measured per glyph: how many glyphs would have lost
      // strokes at the threshold, how many cells were patched back, and the
      // inked/lit totals the comparison ran on (ink = coverage >= 0.25).
      dropout: {
        glyphs: dropoutGlyphs, cells: recoveredCells,
        glyphCells: glyphCells, glyphLit: glyphLit, ink: INK,
        // worst per-glyph stroke loss after the pass, as a fraction: the pass
        // patches any glyph that would lose more than 8 %, so this stays <= .08
        worstLoss: Math.round(worstLoss * 1000) / 1000,
        // stroke mass: cells with real coverage before the threshold, vs cells
        // the shader actually gets.  emitted.lit >= inkCells means no stroke
        // was lost; the surplus is the patched boundary stems.
        inkCells: inkCells,
        // sub-threshold cells that sat BETWEEN two lit cells (a dashed stem)
        // and how many the gap repair lit.  Counted before patching, in cells.
        gapInk: GAPINK,
        gaps: gapsMeasured,
        gapFixed: gapsRepaired
      }
    };
    return out;
  }

  window.LEDWALL_SIM = {
    PATTERNS: PATTERNS,
    PATTERN_INDEX: PATTERN_INDEX,
    vert: SIM_VERT,
    frag: SIM_FRAG,
    makeTextCanvas: makeTextCanvas,
    hexToRgb: hexToRgb
  };
})();
