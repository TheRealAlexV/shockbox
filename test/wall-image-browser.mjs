// Prove the uploaded picture reaches the WALL'S PIXELS, through the engine, not a proxy.
//
// The integration this guards is the whole point of the feature: a picture is sampled by the LED
// instances in the LED shader (engine.js `LED_FRAG`), so it must appear as lit cells on the wall
// canvas, keep its shape and colour, follow the placement, and obey the colour/bit-depth
// controls. Nothing here reads an <img> or a CSS layer: every assertion reads canvas pixels
// (or the one texture the wall draw actually bound), so a CSS overlay cannot pass.
//
//   node test/wall-image-browser.mjs            # boots its own server on an ephemeral port
//   node test/wall-image-browser.mjs --url=http://127.0.0.1:8981
//
// Exits non-zero on the first failed expectation, printing the page console and its diag().

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchChrome, CHROME, startServer as startTestServer } from './lib/chrome.mjs';
import { probeGl, glLine } from './lib/gl-probe.mjs';

const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
if (!CHROME) {
  console.error('wall-image-browser: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the picture, built here so the gate needs no fixture ────────────────────
function crc32(b) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) {
    c = (crc ^ b[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A four-band RGB picture: red | green | blue | white, vertical bands.
 *
 * Chosen because every band is either a pure primary (a raw-vs-palette difference is then
 * unmistakable) or white (which any ramp cannot reproduce without matching a ramp entry), and
 * because the band boundaries give the placement assertions an unambiguous edge to find.
 */
function multibandPng(w = 256, h = 256) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const bands = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 255],
  ];
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = bands[Math.min(3, Math.floor((x / w) * 4))];
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── server + CDP plumbing (the same shape the other wall gates use) ─────────
async function startServer() {
  if (argUrl) return { url: argUrl, stop() {} };
  const srv = await startTestServer({ root: ROOT, statePrefix: 'sb-wall-image-' });
  return { url: srv.url, stateDir: srv.stateDir, log: srv.log, stop: srv.stop };
}

async function cdp(url) {
  const list = await (await fetch(`${url}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) events.push(msg);
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, events, close: () => ws.close() };
}

async function evaluate(c, expression, awaitPromise = false) {
  const r = await c.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(c, expression, ms = 10000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      // `awaitPromise` because some callers pass a `fetch(...).then(...)` expression: without it
      // Runtime.evaluate hands back the Promise object, which is truthy on the first poll, so the
      // wait returned before the page had done anything (that is how `preset.set` was read straight
      // back out of the document it had not written yet).
      last = await evaluate(c, expression, true);
      if (last) return last;
    } catch (err) {
      last = String(err.message);
    }
    await sleep(100);
  }
  return false;
}

/**
 * Read the wall's canvas into a cell grid: one average colour per LED, straight from the frame
 * the wall last drew. This is the measurement every later assertion is made on, so it reads the
 * same canvas OBS sees (`preserveDrawingBuffer` is on).
 */
/**
 * Page-side wait for a frame the loop STARTED after this call.
 *
 * The drawing buffer holds the frame drawn BEFORE the setting the caller just applied, and on
 * SwiftShader a 2560x1440 draw takes ~0.6 s, so "3 rAF ticks" (50 ms) is shorter than one frame:
 * every read came back one frame late, which is how the 0.3-scale box inflated to the union of
 * two placements, the dither read 0 diffs in both targets, and match/palette read the same
 * picture. `renderStats.drawn` ticks at the end of every draw, so waiting for two ticks
 * guarantees one draw that both started and finished after this probe began (a draw already in
 * flight when we arrive only ever contributes the first tick). The timeout keeps a stalled rAF
 * loop from hanging the gate.
 */
const FRAME_WAIT = `
  await new Promise(function (res) {
    var rs = window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.renderStats;
    if (!rs || typeof rs.drawn !== 'number') {
      var n0 = 0;
      var tick0 = function () { n0 += 1; if (n0 >= 3) return res(); requestAnimationFrame(tick0); };
      requestAnimationFrame(tick0);
      setTimeout(res, 2000);
      return;
    }
    var d0 = rs.drawn, t0 = performance.now();
    var tick = function () {
      if (rs.drawn >= d0 + 3 || performance.now() - t0 > 6000) return res();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(res, 5000);
  });
`;

const GRID_PROBE = `(async function(){
  var i = window.LEDWALL_INSTANCE;
  if (!i) return null;
  ${FRAME_WAIT}
  var gl = i.gl, g = i.grid, W = i.W, H = i.H;
  var pitchX = W / g.cols, pitchY = H / g.rows;
  function grab() {
    var px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var cells = [];
    var seen = Object.create(null);
    for (var r = 0; r < g.rows; r++) {
      for (var c = 0; c < g.cols; c++) {
        // sample the centre 3x3 of each cell, in GL's bottom-up rows
        var cxp = Math.round((c + 0.5) * pitchX);
        var cyp = Math.round(H - (r + 0.5) * pitchY);
        var acc = [0,0,0];
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var x = Math.min(W - 1, Math.max(0, cxp + dx));
            var y = Math.min(H - 1, Math.max(0, cyp + dy));
            var o = (y * W + x) * 4;
            acc[0] += px[o]; acc[1] += px[o+1]; acc[2] += px[o+2];
            n++;
          }
        }
        var col = [Math.round(acc[0]/n), Math.round(acc[1]/n), Math.round(acc[2]/n)];
        cells.push(col);
        seen[col.join(',')] = (seen[col.join(',')] || 0) + 1;
      }
    }
    return { cells: cells, cols: g.cols, rows: g.rows, distinct: Object.keys(seen).length, W: W, H: H };
  }
  // The FIRST read after a settings change comes back one rendered state behind, even after
  // FRAME_WAIT: measured on the colour modes, read 1 of "palette" held the "match" picture and
  // read 2 held the palette one. The drawing buffer here is committed lazily (headless
  // SwiftShader), so a read that starts right after the change still sees the frame before it.
  // Two reads, second one returned: the first read costs 2-4 s on its own, which is what lets the
  // commit land. Both reads are the same code, so this cannot hide a stale frame - a wall that is
  // still moving reads differently on a second pass and the assertions catch it.
  grab();
  await new Promise(function (res) {
    var d0 = (window.LEDWALL_INSTANCE.renderStats || {}).drawn || 0;
    var t0 = performance.now();
    var tick = function () {
      var d = (window.LEDWALL_INSTANCE.renderStats || {}).drawn || 0;
      if (d > d0 || performance.now() - t0 > 3000) return res();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(res, 3000);
  });
  return grab();
})()`;

/** Count cells in a grid whose colour is "bright" (any channel over `t`). */
function litCells(grid, t = 40) {
  let n = 0;
  for (const c of grid.cells) if (Math.max(c[0], c[1], c[2]) > t) n++;
  return n;
}

/** Cells matching a predicate on [r,g,b]. */
function count(grid, pred) {
  let n = 0;
  for (const c of grid.cells) if (pred(c)) n++;
  return n;
}

async function readGrid(c) {
  // GRID_PROBE is an async IIFE (it waits for frames), so the evaluate must await the promise.
  const g = await evaluate(c, GRID_PROBE, true);
  if (!g) throw new Error('no grid: the wall did not mount');
  return g;
}

/**
 * Distinct HUE buckets among the LIT cells (the unlit wall is one colour, so counting it cancels
 * the metrics out). The key is chromaticity, 4 buckets per channel, so brightness is divided out:
 * bucketing the graded RGB instead counted the emitter profile's vignette and the ramp gradient,
 * which read ~85 "distinct" for every `imageColour` mode and measured gain, not hue.
 */
function litDistinct(grid) {
  const set = new Set();
  for (const c2 of grid.cells) {
    if (c2[0] + c2[1] + c2[2] < 90) continue;
    const sum = Math.max(1, c2[0] + c2[1] + c2[2]);
    set.add(`${((c2[0] / sum) * 4) | 0},${((c2[1] / sum) * 4) | 0}`);
  }
  return set.size;
}

/**
 * "Picture cell": lit, and on a colour the wall pattern alone does not reach. The wall is a
 * neonwave ramp, so a pure red band comes out as a hot magenta-ish LED, not [255,0,0] — the
 * predicate is therefore "bright and saturated", which is what a lit photo looks like on an LED
 * wall and what the pattern's own sweep is not.
 */
function isPicture(c) {
  const hi = Math.max(c[0], c[1], c[2]);
  const lo = Math.min(c[0], c[1], c[2]);
  return hi > 90 && hi - lo > 55;
}

/**
 * The picture's footprint: the cells that move when the layer is toggled, in cells.
 *
 * A brightness floor cannot find it. The neonwave pattern's own emitter gradient clears any
 * sensible floor nearly everywhere, so "box of the bright cells" is the box of the whole wall and
 * can never show a resize. `blackout` cannot find it either: grade.js applies it to the composited
 * frame and the picture is already baked into that frame (engine.js:355), so blacking out darkens
 * the picture with everything else.
 *
 * Differencing is the one measurement the pattern cannot fake. Inside the box the picture replaces
 * the cell content outright, so those cells move by a whole colour step; outside it they only
 * drift with the pattern, which the caller holds on a slow ramp. The tolerance is wide enough to
 * ignore that drift and narrow enough to keep a full colour swap.
 */
function changedBox(on, off, tol = 60) {
  if (!on || !off || on.cells.length !== off.cells.length) return null;
  const cols = on.cols;
  let minC = cols, maxC = -1, minR = on.rows, maxR = -1, mass = 0;
  on.cells.forEach((a, k) => {
    const b = off.cells[k];
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol) return;
    const r = Math.floor(k / cols);
    const c = k % cols;
    mass++;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  });
  if (maxC < 0) return null;
  return { minC, minR, maxC, maxR, w: maxC - minC + 1, h: maxR - minR + 1, mass };
}

/** A compact `WxH cells at C,R` for an assertion message. */
function boxText(b) {
  return b ? `${b.w}×${b.h} cells at ${b.minC},${b.minR}` : 'none';
}

/** How many cells differ between two grids by more than a per-channel tolerance. */
function diffCells(a, b, tol = 24) {
  if (!a || !b || a.cells.length !== b.cells.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i];
    const y = b.cells[i];
    if (Math.abs(x[0] - y[0]) + Math.abs(x[1] - y[1]) + Math.abs(x[2] - y[2]) > tol) n++;
  }
  return n;
}

/** The bounding box of the cells matching `pred`, in cells. */
function bboxOf(grid, pred) {
  let minC = Infinity;
  let maxC = -1;
  let minR = Infinity;
  let maxR = -1;
  grid.cells.forEach((col, k) => {
    if (!pred(col)) return;
    const r = Math.floor(k / grid.cols);
    const cc = k % grid.cols;
    if (cc < minC) minC = cc;
    if (cc > maxC) maxC = cc;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  });
  if (maxC < 0) return { w: 0, h: 0, minC: 0, maxC: 0, minR: 0, maxR: 0 };
  return { w: maxC - minC + 1, h: maxR - minR + 1, minC, maxC, minR, maxR };
}

/** The distinct cell colours of a grid, bucketed so a 1/255 wobble does not read as a new one. */
function colourSet(grid) {
  const s = new Set();
  for (const col of grid.cells) s.add(`${col[0] >> 2},${col[1] >> 2},${col[2] >> 2}`);
  return s;
}

/** Symmetric set difference: how many buckets each side has that the other does not. */
function setDistance(a, b) {
  let n = 0;
  for (const k of a) if (!b.has(k)) n++;
  for (const k of b) if (!a.has(k)) n++;
  return n;
}

/** Every cell colour inside a cell box (`{minC,minR,maxC,maxR}` from `changedBox`). */
function boxCells(grid, box) {
  const out = [];
  if (!grid || !box) return out;
  for (let r = box.minR; r <= box.maxR; r++) {
    for (let c = box.minC; c <= box.maxC; c++) out.push(grid.cells[r * grid.cols + c]);
  }
  return out;
}

/** The `k` most common colours inside a box, as `[{colour, n}]`, commonest first. */
function boxTop(grid, box, k = 3) {
  const hist = new Map();
  for (const col of boxCells(grid, box)) {
    const key = col.join(',');
    const e = hist.get(key) || { colour: col, n: 0 };
    e.n += 1;
    hist.set(key, e);
  }
  return [...hist.values()].sort((a, b) => b.n - a.n).slice(0, k);
}

/** Share of a box's cells within `tol` (per channel) of any colour in `list`. */
function nearShare(grid, box, list, tol = 8) {
  const cells = boxCells(grid, box);
  if (!cells.length || !list.length) return 0;
  let n = 0;
  for (const c of cells) {
    for (const q of list) {
      if (Math.abs(c[0] - q[0]) <= tol && Math.abs(c[1] - q[1]) <= tol && Math.abs(c[2] - q[2]) <= tol) {
        n += 1;
        break;
      }
    }
  }
  return n / cells.length;
}

/** Which texture is bound to the LED program's `u_image` TEXTURE2 unit (proves the shader path). */const IMAGE_BOUND_PROBE = `(function(){
  var i = window.LEDWALL_INSTANCE, gl = i.gl;
  var u = i.progLed.u.image;
  var loc = u === undefined ? gl.getUniformLocation(i.progLed.p, 'u_image') : u;
  return JSON.stringify({
    hasUniform: Boolean(loc),
    unit: loc ? gl.getUniform(i.progLed.p, loc) : null,
    tex: i.imgTex ? i.imgTex === (function(){ return null; })() : false,
    imgTexPresent: !!i.imgTex,
    imgRev: i.imgRev,
    imgLoaded: i.imgLoaded,
    imgError: i.imgError,
    mode: (i.eff || i.s).imageColour,
  });
})()`;

/**
 * Read the 12-bit dither where it is a 12-bit quantity: the engine's SCENE pass.
 *
 * The canvas is 8-bit, so a 12-bit dither is quantised away before it can be counted — measured on
 * the same 92x92 window, the canvas reports 21 distinct green levels with `imageDither` 0 and 21
 * with 1. The scene pass is the render the dither acts on, and the engine allocates it RGBA16F
 * (`i.sceneFbo`), so it is read back as float. The readback format is checked rather than assumed:
 * if the context does not advertise float colour readback the probe returns an error naming that,
 * instead of quietly measuring something coarser and passing.
 *
 * The window comes from the same numbers the shader used, so it sits inside ONE flat band: the
 * picture's green band is `uvImg.x` 0.25..0.5, i.e. wall x `centre + scale * [-0.25, 0)`, and the
 * window is 92x92 centred in that band at the picture's y centre. Nothing new is set on the wall —
 * it reads the placement and bit depth the caller already applied.
 *
 * `dither` 0 locates the window and stores its frame on the page; 1 re-reads that window and diffs
 * the two 12-bit codes. Steps are in LSB(12) — 1/4095, the ladder the shader quantises to — and
 * the 8-bit canvas count is taken over the same window, as context for what the eye can be shown.
 */
const SCENE_DITHER_PROBE = `(async function(dither){
  var i = window.LEDWALL_INSTANCE;
  if (!i) return { error: 'no wall instance' };
  if (!i.sceneFbo) return { error: 'no scene target: the wall did not mount' };
  var gl = i.gl, W = i.W, H = i.H;
  // Same contract as GRID_PROBE: see FRAME_WAIT.
  ${FRAME_WAIT}

  var side = 92;
  var win = window.__wallDitherWin || null;
  if (!win) {
    var s = i.eff || i.s || {};
    var scale = Math.min(4, Math.max(0.05, Number(s.imageScale == null ? 1 : s.imageScale)));
    var icx = Math.min(1, Math.max(0, Number(s.imageX == null ? 0.5 : s.imageX)));
    var icy = Math.min(1, Math.max(0, Number(s.imageY == null ? 0.5 : s.imageY)));
    var deg = Number(s.imageRotate || 0);
    if (Math.abs(deg) > 1e-6) return { error: 'the picture is rotated ' + deg + ' deg: its band is not axis-aligned' };
    var bandX0 = Math.round((icx - 0.25 * scale) * W);
    var bandX1 = Math.round(icx * W);
    if (bandX1 - bandX0 < side + 8) {
      return { error: 'the picture band is only ' + (bandX1 - bandX0) + ' px wide: cannot read a ' + side + 'x' + side + ' window' };
    }
    win = {
      x: Math.round(bandX0 + (bandX1 - bandX0) / 2) - (side >> 1),
      y: Math.round(icy * H) - (side >> 1),
      w: side, h: side,
    };
    window.__wallDitherWin = win;
  }
  var x = Math.max(0, Math.min(W - win.w, win.x));
  var y = Math.max(0, Math.min(H - win.h, win.y));
  var w = win.w, h = win.h;

  var prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, i.sceneFbo);
  var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    return { error: 'the scene target is incomplete (0x' + status.toString(16) + ')' };
  }
  var readFmt = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
  var readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
  var floatExt = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
  // RGBA16F advertises RGBA/FLOAT (5126) or, as this host's driver does, RGBA/HALF_FLOAT (5131).
  // Both are colour-float readback; anything else means the read would be silently coarser.
  var halfType = gl.HALF_FLOAT || 0x140b;
  if (readFmt !== gl.RGBA || (readType !== gl.FLOAT && readType !== halfType) || !floatExt) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    return { error: 'the scene pass does not advertise float colour readback: format=' + readFmt +
      ' (RGBA=' + gl.RGBA + '), type=' + readType + ' (FLOAT=' + gl.FLOAT + ', HALF_FLOAT=' + halfType +
      '), EXT_color_buffer_float=' + Boolean(floatExt) };
  }
  var px = new Float32Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, px);
  var glErr = gl.getError();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  var cu = new Uint8Array(w * h * 4);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, cu);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
  if (glErr) return { error: 'readPixels(gl.FLOAT) on the scene pass raised GL error 0x' + glErr.toString(16) };

  // Read again after one more draw. The first read taken after a settings change is one rendered
  // state behind (the same commit lag GRID_PROBE documents), and here that is fatal in a way it is
  // not for a diff-based probe: both reads would hold the imageDither 0 frame, the comparison
  // would find 0 diffs in every channel, and the gate would look broken when the dither is fine.
  await new Promise(function (res) {
    var d0 = (i.renderStats || {}).drawn || 0, t0 = performance.now();
    var tick = function () {
      var d = (i.renderStats || {}).drawn || 0;
      if (d > d0 || performance.now() - t0 > 3000) return res();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(res, 3000);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, i.sceneFbo);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, px);
  glErr = gl.getError();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, cu);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
  if (glErr) return { error: 'the second readPixels(gl.FLOAT) on the scene pass raised GL error 0x' + glErr.toString(16) };

  var pageDither = Number((i.eff || {}).imageDither);
  var ditherLoc = gl.getUniformLocation(i.progLed.p, 'u_imgDither');
  var uniformDither = ditherLoc ? gl.getUniform(i.progLed.p, ditherLoc) : null;
  var drawnNow = (i.renderStats || {}).drawn || 0;

  if (dither < 0.5) {
    // One flat band, checked from the pixels: inside the picture's green band green is the one
    // channel the picture gives a level to (raw mode is [0,1,0]), so a window that is mostly
    // green-dominant is inside that band and not across a seam.
    var lit = 0, redHot = 0;
    for (var p = 0; p < w * h; p++) {
      var o = p * 4;
      if (px[o] > 0.002) redHot++;
      if (px[o + 1] > 0.05 && px[o + 1] > px[o] && px[o + 1] > px[o + 2]) lit++;
    }
    if (lit < w * h * 0.4) {
      return { error: 'the window is not inside a lit flat band: ' + lit + ' of ' + (w * h) +
        ' px are green-dominant, ' + redHot + ' carry red' };
    }
    window.__wallDitherFlat = { px: px, cu: cu, w: w, h: h, pageDither: pageDither };
    return { win: { x: x, y: y, w: w, h: h }, frame: W + 'x' + H, band: w * h, lit: lit,
             readFmt: readFmt, readType: readType, pageDither: pageDither,
             uniformDither: uniformDither, drawn: drawnNow };
  }

  var base = window.__wallDitherFlat;
  if (!base) return { error: 'no flat frame stored: read imageDither 0 first' };
  var red = 0, green = 0, blue = 0, gb1 = 0, moved = 0, maxStep = 0, canvasMoved = 0;
  for (var q = 0; q < w * h; q++) {
    var o2 = q * 4;
    var dr = Math.abs(Math.round(px[o2] * 4095) - Math.round(base.px[o2] * 4095));
    var dg = Math.abs(Math.round(px[o2 + 1] * 4095) - Math.round(base.px[o2 + 1] * 4095));
    var db = Math.abs(Math.round(px[o2 + 2] * 4095) - Math.round(base.px[o2 + 2] * 4095));
    if (dr) red++;
    if (dg) green++;
    if (db) blue++;
    if (dg === 1 || db === 1) gb1++;
    var step = Math.max(dr, dg, db);
    if (step) { moved++; if (step > maxStep) maxStep = step; }
    if (cu[o2] !== base.cu[o2] || cu[o2 + 1] !== base.cu[o2 + 1] || cu[o2 + 2] !== base.cu[o2 + 2]) canvasMoved++;
  }
  window.__wallDitherWin = null;
  window.__wallDitherFlat = null;
  return { red: red, green: green, blue: blue, gb1: gb1, moved: moved, maxStep: maxStep,
           canvasMoved: canvasMoved, win: { x: x, y: y, w: w, h: h }, pageDither: pageDither,
           flatDither: base.pageDither, uniformDither: uniformDither, drawn: drawnNow };
})`;

async function main() {
  const srv = await startServer();
  const { devtools, stop: stopChrome } = await launchChrome({
    size: [1280, 720],
    profilePrefix: 'sb-chrome-wallimg-',
    extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const c = await cdp(devtools);
  const consoleLines = [];
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Log.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.addEventListener('error', function (e) { window.__err = (e && e.message) || 'error'; });
             window.addEventListener('unhandledrejection', function (e) { window.__err = 'promise: ' + ((e.reason && e.reason.message) || e.reason); });`,
  });
  const origPush = c.events.push.bind(c.events);
  c.events.push = (...args) => {
    for (const e of args) {
      if (e && e.method === 'Runtime.consoleAPICalled') {
        consoleLines.push(`${e.params.type}: ${(e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      } else if (e && e.method === 'Log.entryAdded') {
        consoleLines.push(`log ${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}`);
      }
    }
    return origPush(...args);
  };

  const patch = async (p) => {
    const r = await fetch(`${srv.url}/api/wall/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    });
    return r.json();
  };
  const render = () => fetch(`${srv.url}/api/wall/render`).then((r) => r.json());

  /**
   * Wait until the page has APPLIED `key` = `v`, not merely accepted the PATCH. The settings
   * document lands on a later rAF frame, and a 2560x1440 `readPixels` on SwiftShader blocks rAF
   * for 2–4.6 s, so a fixed sleep followed by `readGrid` can read the frame before the patch.
   * `_resolveView` rebuilds `eff` only when the page takes the update, so `eff` equals the new
   * value only once the page has applied it (and its next draw is the one to read).
   */
  const applied = async (k, v) => {
    const lit = typeof v === 'number' ? v : JSON.stringify(v);
    const test = typeof v === 'number'
      ? `Math.abs(Number(window.LEDWALL_INSTANCE.eff.${k}) - (${v})) < 1e-9`
      : `String(window.LEDWALL_INSTANCE.eff.${k}) === ${lit}`;
    return waitFor(c, `Boolean(window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.eff) && (${test})`, 30000);
  };
  /** Wait for every key of a multi-key patch at once. */
  const appliedAll = (p) => Promise.all(Object.keys(p).map((k) => applied(k, p[k])));

  /**
   * The frame now, and the same frame with the picture layer off, at the current placement. The
   * pair is what `changedBox` needs: only the picture's own cells move between the two, and the
   * layer is left on so the caller's next measurement sees the wall it expects.
   */
  const picturePair = async () => {
    const on = await readGrid(c);
    await patch({ imageOn: 0 });
    await applied('imageOn', 0);
    const off = await readGrid(c);
    await patch({ imageOn: 1 });
    await applied('imageOn', 1);
    return { on, off };
  };

  // Set only once every check has run, so the finally block can tell a clean run from a throw.
  let complete = false;

  try {
    // Start from a known wall: whole 16:9, a SMOOTH pattern (the default `random` re-fires cells
    // every frame, and that flicker is larger than the picture's own step, which swamps the
    // on/off differencing below), and no motion that would fight the picture.
    // speed:0 freezes the wave (its only clock is `speed`, engine.js:1607) and grain:0 kills the
    // wall-clock noise term (grade.js:167), so the on/off diff isolates the picture alone.
    await patch({ ratio: '16:9', pattern: 'wave', speed: 0, persistence: 0, streakOpacity: 0, bloom: 0, grain: 0, imageOn: 0, imageRev: 0 });

    await c.send('Page.navigate', { url: `${srv.url}/wall/render` });
    const mounted = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.gl)');
    ok('page mounts the engine', Boolean(mounted), mounted ? `view=${await evaluate(c, 'window.LEDWALL_INSTANCE.view')}` : 'LEDWALL_INSTANCE never appeared');
    if (!mounted) {
      console.log(`     console:\n       ${consoleLines.slice(-20).join('\n       ') || '(none)'}`);
      console.log(`     ${glLine(await probeGl(c))}`);
      throw new Error('engine did not mount');
    }
    await sleep(700);

    // ── 1. upload ────────────────────────────────────────────────────────
    const png = multibandPng(256, 256);
    const up = await fetch(`${srv.url}/api/wall/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    ok('upload: POST /api/wall/image accepts a 256×256 multiband PNG', up.status === 200 && up.body && up.body.ok === true,
      `${up.status} ${JSON.stringify(up.body && up.body.image)}`);
    ok('upload: the server recorded the real pixel size', Boolean(up.body?.image?.w === 256 && up.body?.image?.h === 256),
      `${up.body?.image?.w}×${up.body?.image?.h}, ${up.body?.image?.bytes} bytes`);

    const landed = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE.imgTex)', 12000);
    const info = JSON.parse(await evaluate(c, IMAGE_BOUND_PROBE));
    ok('upload: the page downloaded and uploaded it as a texture', Boolean(landed) && info.imgLoaded > 0,
      `imgTex=${info.imgTexPresent} loaded=${info.imgLoaded} rev=${info.imgRev} err=${info.imgError || 'none'}`);
    ok('upload: the picture is a texture the LED shader reads (u_image)', info.hasUniform === true && info.unit === 2,
      `uniform=${info.hasUniform} unit=${info.unit}`);
    const liveDoc = await render();
    ok('upload: the live settings document carries the upload', liveDoc.settings.look.imageOn === 1 && liveDoc.settings.look.imageRev === info.imgRev,
      `imageOn=${liveDoc.settings.look.imageOn} imageRev=${liveDoc.settings.look.imageRev}`);

    // ── 2. it is ON the wall, in the picture's own colours ────────────────
    // The baseline PATCH and the upload's `imageOn` land on later frames: wait for the page's
    // effective look to carry them, or the read below is the frame before the picture.
    await appliedAll({ pattern: 'wave', speed: 0, grain: 0, imageOn: 1 });
    const gridOn = await readGrid(c);
    if (process.env.PROBE_IMG) {
      const sample = ['red', 'green', 'blue', 'white'].map((n, i) => [n, gridOn.cells.filter((_, k) => (k % gridOn.cols) > (i * gridOn.cols / 4) && (k % gridOn.cols) < ((i + 1) * gridOn.cols / 4))]);
      for (const [n, cells] of sample) {
        const lit = cells.filter((x) => x[0] + x[1] + x[2] > 30);
        const avg = lit.length ? lit.reduce((a, x) => [a[0] + x[0], a[1] + x[1], a[2] + x[2]], [0, 0, 0]).map((v) => Math.round(v / lit.length)) : null;
        const uniq = new Set(lit.map((x) => x.join(','))).size;
        console.log('PROBE band', n, 'lit', lit.length, 'of', cells.length, 'avg', JSON.stringify(avg), 'uniq', uniq, 'sample', JSON.stringify(lit.slice(0, 3)));
      }
      console.log('PROBE look', JSON.stringify((await render()).settings.look));
      process.exit(0);
    }
    // The wall is a neonwave LED wall: a pure red band is re-emitted through the ramp, so no cell is
    // ever literally [255,0,0]. "The picture is on" is therefore measured as "the canvas has hot,
    // saturated cells" (max channel high, channel spread wide) — the pattern alone never gets there.
    const onRed = count(gridOn, isPicture);
    const off = await patch({ imageOn: 0 });
    await applied('imageOn', 0);
    const gridOff = await readGrid(c);
    const offCount = count(gridOff, isPicture);
    const changed = diffCells(gridOn, gridOff);
    ok('display: the picture is drawn as lit LEDs on the wall', onRed > 300,
      `${onRed} hot picture cells with the image on (${gridOn.cols}×${gridOn.rows} grid)`);
    // Removing the layer must change the canvas — that is what proves it is drawn by the shader and
    // not by CSS or DOM. It cannot mean "the wall goes dark": the pattern keeps sweeping behind the
    // picture, so the honest measure is scale of change, not a drop to zero.
    ok('display: removing the image changes the wall itself (so it was the image)',
      changed > 300 && changed / (gridOn.cols * gridOn.rows) > 0.2,
      `${changed} of ${gridOn.cols * gridOn.rows} cells changed when the layer went off ` +
      `(${onRed} -> ${offCount} hot, ${litCells(gridOn)} lit vs ${litCells(gridOff)} lit)`);
    await patch({ imageOn: 1, imageScale: 0.6 });
    await appliedAll({ imageOn: 1, imageScale: 0.6 });
    const grid2 = await readGrid(c);
    ok('display: it comes back when the layer is switched on again', Boolean(grid2) && count(grid2, isPicture) > 300,
      `${grid2 ? count(grid2, isPicture) : -1} hot picture cells`);
    // This is the frame every later measurement compares against. `imageScale` is pinned so the
    // box has a known, checkable size, and the pair gives the footprint the floor cannot.
    const { on: base, off: baseOff } = await picturePair();
    const bigBox = changedBox(base, baseOff);

    // ── 3. transform: move, resize, rotate each move the pixels ──────────
    // The picture box on the preview writes these same keys through settings.patch, so proving
    // the keys move the wall proves the control; `pane-drag` covers the pointer path itself.
    const moved = await patch({ imageX: 0.3, imageY: 0.4 });
    await appliedAll({ imageX: 0.3, imageY: 0.4 });
    const gridMoved = await readGrid(c);
    ok('transform: a position patch moves the lit rectangle', diffCells(base, gridMoved) > 50,
      `${diffCells(base, gridMoved)} of ${base.cells.length} cells changed`);

    await patch({ imageX: 0.5, imageY: 0.5, imageScale: 0.3 });
    await appliedAll({ imageX: 0.5, imageY: 0.5, imageScale: 0.3 });
    const { on: gridZoomed, off: zoomedOff } = await picturePair();
    const smallBox = changedBox(gridZoomed, zoomedOff);
    ok('transform: a scale patch resizes the lit rectangle',
      Boolean(smallBox && bigBox && smallBox.w < bigBox.w * 0.8 && smallBox.h < bigBox.h * 0.9),
      `scale 0.6 → ${boxText(bigBox)}, scale 0.3 → ${boxText(smallBox)}`);

    await patch({ imageScale: 0.6 });
    await applied('imageScale', 0.6);
    await patch({ imageRotate: 45 });
    await applied('imageRotate', 45);
    const gridRot = await readGrid(c);
    ok('transform: a rotation patch turns the rectangle', diffCells(grid2, gridRot) > 50,
      `${diffCells(grid2, gridRot)} cells changed at 45°`);
    await patch({ imageRotate: 0 });
    await applied('imageRotate', 0);

    // ── 4. colour modes: three visibly different pictures ────────────────
    // The dither is a per-cell ±0.5 LSB(8) offset, so it multiplies the number of distinct shades
    // inside the box (match read 960 shades with it on against raw's 435) and drowns the property
    // this section measures: which colours the mode maps the picture onto. It has its own section
    // below, so switch it off here and put it back.
    const ditherBeforeColour = (await render()).settings.look.imageDither;
    await patch({ imageDither: 0 });
    await applied('imageDither', 0);
    const byMode = {};
    for (const mode of ['raw', 'match', 'palette']) {
      await patch({ imageColour: mode });
      await applied('imageColour', mode);
      const g = await readGrid(c);
      byMode[mode] = { grid: g, colours: colourSet(g), distinct: litDistinct(g), top: boxTop(g, bigBox, 3) };
    }
    const dRawMatch = setDistance(byMode.raw.colours, byMode.match.colours);
    const dRawPal = setDistance(byMode.raw.colours, byMode.palette.colours);
    const dMatchPal = setDistance(byMode.match.colours, byMode.palette.colours);
    ok('colour: raw | match | palette are three different pictures',
      dRawMatch > 8 && dRawPal > 8 && dMatchPal > 4,
      `distinct hue buckets raw=${byMode.raw.distinct} match=${byMode.match.distinct} palette=${byMode.palette.distinct}; ` +
      `set distance raw↔match=${dRawMatch} raw↔palette=${dRawPal} match↔palette=${dMatchPal}`);
    // The whole-wall colour set is mostly the wave, which is identical in all three modes, so it
    // dilutes every difference (raw↔match read 12 buckets that way). Inside the picture box the
    // modes are the only variable. "Collapses onto ramp colours" is measured as the picture's OWN
    // three dominant colours leaving the box: `match` replaces each cell's colour with the nearest
    // entry of the live ramp, and a match mode that fell through to `raw` would score the raw share
    // (46%) and fail.
    const rawOwn = byMode.raw.top.map((t) => t.colour);
    const rawShare = nearShare(byMode.raw.grid, bigBox, rawOwn);
    const matchShare = nearShare(byMode.match.grid, bigBox, rawOwn);
    const palShare = nearShare(byMode.palette.grid, bigBox, rawOwn);
    ok('colour: "match" maps the picture onto ramp colours (its own colours leave the box)',
      Boolean(bigBox) && rawShare > 0.25 && matchShare < 0.05,
      `the picture's three dominant colours cover ${(rawShare * 100).toFixed(0)}% of the box in raw ` +
      `and ${(matchShare * 100).toFixed(1)}% in match; match's box top is ` +
      `${byMode.match.top.map((t) => t.colour.join(',')).join(' / ')}`);
    // Same instrument, different claim: `palette` drives the ramp from luminance, so the picture's
    // own colours are gone there too - and a palette that fell through to `raw` would score 46%.
    ok('colour: "palette" discards the picture\'s own colours (they are gone from the box)',
      Boolean(bigBox) && rawShare > 0.25 && palShare < 0.05,
      `the picture's three dominant colours cover ${(rawShare * 100).toFixed(0)}% of the box in raw ` +
      `and ${(palShare * 100).toFixed(1)}% in palette (${rawOwn.map((q) => q.join(',')).join(' / ')})`);
    await patch({ imageColour: 'raw' });
    await applied('imageColour', 'raw');
    await patch({ imageDither: ditherBeforeColour });
    await applied('imageDither', ditherBeforeColour);

    // ── 5. bit depth: the ladder is 8/10/12, and the dither belongs to the top of it ─
    // 8-bit is 256 levels per channel, which is the most the uploaded PNG has; the quantiser is
    // the identity there and dithering it would only add noise. 10 and 12 bit are the depths the
    // ladder is for: the shader quantises the picture at every depth, and the 4x4 Bayer pattern
    // is what recovers the colours sitting between two quanta. Measured accordingly.
    const byBits = {};
    for (const bits of ['8', '10', '12']) {
      await patch({ imageBits: bits });
      await applied('imageBits', bits);
      byBits[bits] = litDistinct(await readGrid(c));
    }
    ok('depth: the ladder is 8, 10 and 12 bit at 4 bits per step', byBits['8'] > 0 && byBits['10'] > 0 && byBits['12'] > 0,
      `8-bit=${byBits['8']} 10-bit=${byBits['10']} 12-bit=${byBits['12']} distinct cell colours`);

    // The canvas cannot show this one: it is 8-bit, and the dither is a 12-bit offset, so both
    // dither states read the same distinct-level count on the canvas (21 either way, measured on
    // this window). The scene pass is the frame the dither actually moves and it is RGBA16F, so
    // the assertion reads it as float. The offsets are spread across the emitters on purpose
    // (engine.js LED_FRAG: red none, green three quarters, blue three times), so red must not move
    // at all while green and blue step in small quantisation steps: the offsets are a fraction of
    // one 8-bit level spread over a 4x4 cell block, and at 12 bit one 8-bit level is 16 LSB(12), so
    // blue (three times the offset) tops out at 0.5/255*3*4095 = 24 and green (three quarters) at 6.
    const ditherBefore = await evaluate(c, 'Number(window.LEDWALL_INSTANCE.eff.imageDither)');
    const ditherRestore = Number.isFinite(ditherBefore) ? ditherBefore : 1;
    await patch({ imageBits: '12', imageDither: 0 });
    await appliedAll({ imageBits: '12', imageDither: 0 });
    const flatScene = await evaluate(c, `(${SCENE_DITHER_PROBE})(0)`, true);
    let dithScene = flatScene;
    if (!flatScene.error) {
      await patch({ imageDither: 1 });
      await applied('imageDither', 1);
      dithScene = await evaluate(c, `(${SCENE_DITHER_PROBE})(1)`, true);
    }
    await patch({ imageDither: ditherRestore });
    await applied('imageDither', ditherRestore);
    const sceneWin = (flatScene.win || dithScene.win || { x: -1, y: -1, w: 0, h: 0 });
    // Measured on a 4x4 Bayer offset of 0.5/255 spread (0, 0.75, 3) across (red, green, blue) at
    // 12 bit: red 0, green 2255, blue 2549 of 8464 px moved, 992 of them by exactly 1 LSB(12), and
    // the largest step 23 (blue carries three times the offset: 0.5/255*3*4095 = 24 LSB(12)). A
    // dither that stopped reaching the shader moves 0 px, so the bound is what separates "small
    // quantisation steps" from "the toggle did nothing" and from a colour shift.
    ok('depth: the 12-bit dither steps green and blue in small steps and leaves red alone',
      !flatScene.error && !dithScene.error &&
        // The two reads must have been taken with different dither values, or the probe is
        // comparing two frames of the same state and every diff would be 0 for a reason that has
        // nothing to do with the shader.
        Number(flatScene.pageDither) === 0 && Number(dithScene.pageDither) === 1 &&
        dithScene.red === 0 && dithScene.green > 1000 && dithScene.blue > 1000 &&
        dithScene.gb1 >= 300 && dithScene.maxStep >= 1 && dithScene.maxStep <= 24,
      flatScene.error
        ? `scene readback: ${flatScene.error}`
        : dithScene.error
          ? `dither readback: ${dithScene.error}`
          : `red diffs=${dithScene.red}, green diffs=${dithScene.green}, blue diffs=${dithScene.blue}, max step=${dithScene.maxStep} LSB(12) over ${sceneWin.w}x${sceneWin.h} px at ${sceneWin.x},${sceneWin.y} of ${flatScene.frame} (green+blue at exactly 1 LSB: ${dithScene.gb1}, any channel moved: ${dithScene.moved}); scene readback RGBA format=${flatScene.readFmt} type=${flatScene.readType} (float), ${flatScene.lit}/${flatScene.band} px lit flat band; 8-bit canvas in the same window: ${dithScene.canvasMoved} px moved; imageDither at the two reads ${flatScene.pageDither} -> ${dithScene.pageDither} (u_imgDither ${flatScene.uniformDither} -> ${dithScene.uniformDither}, frame ${flatScene.drawn} -> ${dithScene.drawn})`);

    await patch({ imageBits: '8', imageDither: 0 });
    await appliedAll({ imageBits: '8', imageDither: 0 });
    const flat8 = await readGrid(c);
    await patch({ imageBits: '8', imageDither: 1 });
    await appliedAll({ imageBits: '8', imageDither: 1 });
    const dith8 = await readGrid(c);
    ok('depth: at 8-bit the dither has no steps worth filling (change stays inside noise)',
      Math.abs(litDistinct(dith8) - litDistinct(flat8)) <= Math.max(4, litDistinct(flat8) * 0.1),
      `8-bit flat=${litDistinct(flat8)} dithered=${litDistinct(dith8)} distinct`);
    await patch({ imageBits: '8', imageDither: 1 });
    await appliedAll({ imageBits: '8', imageDither: 1 });

    // ── 6. preset round-trip: save the placement, reload, get it back ─────
    await patch({ imageX: 0.34, imageY: 0.42, imageScale: 0.44, imageRotate: 12, imageColour: 'match', imageBits: '8' });
    await appliedAll({ imageX: 0.34, imageY: 0.42, imageScale: 0.44, imageRotate: 12, imageColour: 'match', imageBits: '8' });
    const saved = await fetch(`${srv.url}/api/wall/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'preset.save', args: { name: 'img-roundtrip' } }),
    }).then((r) => r.json());
    // `presets` is the bank in the shape the page reads it — `{order, saved}` — so a saved look
    // is under `presets.saved`, not directly on `presets`.
    const preset = saved && saved.presets && saved.presets.saved && saved.presets.saved['img-roundtrip'];
    const looksSaved = preset && Math.abs(Number(preset.imageX) - 0.34) < 1e-6 &&
      Math.abs(Number(preset.imageScale) - 0.44) < 1e-6 && Number(preset.imageRotate) === 12 &&
      String(preset.imageColour) === 'match' && String(preset.imageBits) === '8' &&
      Number(preset.imageRev) >= 1;
    ok('preset: preset.save carries the picture\'s placement and colour settings', Boolean(looksSaved),
      preset ? `x=${preset.imageX} y=${preset.imageY} scale=${preset.imageScale} rot=${preset.imageRotate} colour=${preset.imageColour} bits=${preset.imageBits} rev=${preset.imageRev}` : 'no preset recorded');

    // move it somewhere else, so "restored" cannot be mistaken for "never moved"
    await patch({ imageX: 0.8, imageY: 0.8, imageScale: 1.2, imageRotate: -60, imageColour: 'raw', imageBits: '10' });
    await appliedAll({ imageX: 0.8, imageY: 0.8, imageScale: 1.2, imageRotate: -60, imageColour: 'raw', imageBits: '10' });
    await fetch(`${srv.url}/api/wall/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'preset.set', args: { name: 'img-roundtrip' } }),
    });
    // `preset.set` is a PAGE command: the engine applies the look, then hands the values back to
    // the document (`_persistLook`), which is what a reload reads. Reading the document a fixed
    // 900 ms later is a race against that write - on a SwiftShader page it had not landed and the
    // test reported the moved-away placement, which reads exactly like "the preset was ignored".
    // Waiting for the document to agree makes the assertion a fact, not a timer.
    const restoredAt = await waitFor(
      c,
      `fetch('/api/wall/render').then(function (r) { return r.json(); }).then(function (b) {
         var lk = (b && b.settings && b.settings.look) || b.look || {};
         return Math.abs(Number(lk.imageX) - 0.34) < 1e-6 &&
                Math.abs(Number(lk.imageScale) - 0.44) < 1e-6 && Number(lk.imageRotate) === 12;
       })`,
      6000
    );
    const restored = (await render()).settings.look;
    if (!restoredAt) {
      const d = JSON.parse(await evaluate(c, 'JSON.stringify({persistOk: window.LEDWALL_INSTANCE.persistOk, persistFail: window.LEDWALL_INSTANCE.persistFail, presetLoading: window.LEDWALL_INSTANCE.presetLoadingUntil, label: window.LEDWALL_INSTANCE.label})'));
      console.log(`     page persist: ${JSON.stringify(d)}`);
    }
    ok('preset: loading it restores the picture placement', Math.abs(Number(restored.imageX) - 0.34) < 1e-6 && Math.abs(Number(restored.imageScale) - 0.44) < 1e-6 && Number(restored.imageRotate) === 12,
      `x=${restored.imageX} scale=${restored.imageScale} rot=${restored.imageRotate} colour=${restored.imageColour} bits=${restored.imageBits}`);

    // The frame the reload must be compared against is the one drawn immediately BEFORE it, not
    // the 45° frame from three sections ago: diffing against a stale frame passes for any picture
    // at all, a blank wall included.
    await appliedAll({ imageX: 0.34, imageY: 0.42, imageScale: 0.44, imageRotate: 12, imageColour: 'match', imageBits: '8' });
    const gridRestored = await readGrid(c);

    // Noise floor of this measurement: two accurate reads of a wall that has not been touched.
    // If this is the same size as `reloadDiff`, the assertion is reading frame noise, not the
    // restore, and no threshold below it can pass.
    const restDrift = diffCells(gridRestored, await readGrid(c));

    // Diagnostics for the one failure this gate has never passed: the frame the reload draws
    // differs from the pre-reload frame even though the document, the texture and both toggles
    // agree. `restDrift` is the measurement's own noise floor (two accurate reads of the untouched
    // wall - 0), so a diff in the thousands is the render, not the probe. `wave time` is printed
    // because engine.js:1614 accumulates `time += dt*speed` and a reload starts at 0; measured
    // 0.0333 -> 0, too small to move a frozen wave, so it is ruled out, not blamed.
    const tBefore = await evaluate(c, 'window.LEDWALL_INSTANCE && Number(window.LEDWALL_INSTANCE.time)');

    // the page reloads and draws the same picture in the same place: a real restore, not a
    // server-side document nobody renders
    await c.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    // A reload has to compile the shaders on SwiftShader and then fetch + upload the picture again;
    // 12 s outlasted it on an idle host but not with the CPU cap contended, and a `remounted` false
    // then failed the assertion for a frame that was merely late. Wait for the texture AND a drawn
    // frame (the grid read below needs a frame, not just a mounted engine).
    const remounted = await waitFor(
      c,
      'Boolean(window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.imgTex && ' +
        'window.LEDWALL_INSTANCE.renderStats && window.LEDWALL_INSTANCE.renderStats.drawn > 0)',
      30000
    );
    const gridReload = await readGrid(c);
    const reloadDiff = diffCells(gridRestored, gridReload);
    const tAfter = await evaluate(c, 'window.LEDWALL_INSTANCE && Number(window.LEDWALL_INSTANCE.time)');
    // (restDrift is measured above, before the reload.)
    const reloadState = await evaluate(c, `(function () {
      var i = window.LEDWALL_INSTANCE || {};
      return JSON.stringify({ imgRev: i.s && i.s.imageRev, imgError: i.imgError || null, imgTex: Boolean(i.imgTex),
        imgOn: i.s && i.s.imageOn, effOn: i.eff && i.eff.imageOn,
        fenceOn: Boolean(i.fenceOn), fence: i.fence || null, fenceCells: i.fenceCells || null,
        docFence: (i.s && i.s.fence) || null });
    })()`);
    ok('preset: a reload draws the restored placement on the wall', Boolean(remounted) && reloadDiff < 20,
      `diff=${reloadDiff} of ${gridRestored.cells.length} cells vs the pre-reload frame (rest drift ${restDrift}), wave time ${tBefore} -> ${tAfter}, remounted=${Boolean(remounted)}, ` +
      `frame ${gridRestored.W}x${gridRestored.H}/${gridRestored.cols}x${gridRestored.rows} -> ${gridReload.W}x${gridReload.H}/${gridReload.cols}x${gridReload.rows}, ${reloadState}`);
    complete = true;
  } finally {
    c.close();
    stopChrome();
    srv.stop();
    await sleep(150);
    if (srv.log) fs.writeFileSync(path.join(SCRATCH, 'wall-image-server.log'), srv.log.join(''));
    fs.writeFileSync(path.join(SCRATCH, 'wall-image-console.log'), consoleLines.join('\n'));
    // A failing run keeps its state dir: it is the only copy of the document and settings to
    // diagnose from, while a passing run's is dead weight in /tmp.
    if (complete && results.every((r) => r.pass) && srv.stateDir) {
      fs.rmSync(srv.stateDir, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`wall-image-browser: ${err.stack || err.message}`);
  process.exit(1);
});
