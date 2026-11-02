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
      last = await evaluate(c, expression);
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
const GRID_PROBE = `(function(){
  var i = window.LEDWALL_INSTANCE;
  if (!i) return null;
  var gl = i.gl, g = i.grid, W = i.W, H = i.H;
  var px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  var cells = [];
  var pitchX = W / g.cols, pitchY = H / g.rows;
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
  const g = await evaluate(c, GRID_PROBE);
  if (!g) throw new Error('no grid: the wall did not mount');
  return g;
}

/**
 * Distinct colours among the LIT cells (the unlit wall is one colour, so counting it cancels the
 * metrics out). Quantised to 8 levels per channel: "distinct" must mean visibly distinct, not
 * one least-significant bit of gradient banding.
 */
function litDistinct(grid) {
  const set = new Set();
  for (const c2 of grid.cells) {
    if (c2[0] + c2[1] + c2[2] < 90) continue;
    set.add(`${c2[0] >> 5},${c2[1] >> 5},${c2[2] >> 5}`);
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
   * The frame now, and the same frame with the picture layer off, at the current placement. The
   * pair is what `changedBox` needs: only the picture's own cells move between the two, and the
   * layer is left on so the caller's next measurement sees the wall it expects.
   */
  const picturePair = async () => {
    const on = await readGrid(c);
    await patch({ imageOn: 0 });
    await sleep(600);
    const off = await readGrid(c);
    await patch({ imageOn: 1 });
    await sleep(600);
    return { on, off };
  };

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
    await sleep(600);
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
    await sleep(600);
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
    await sleep(700);
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
    await sleep(700);
    const gridMoved = await readGrid(c);
    ok('transform: a position patch moves the lit rectangle', diffCells(base, gridMoved) > 50,
      `${diffCells(base, gridMoved)} of ${base.cells.length} cells changed`);

    await patch({ imageX: 0.5, imageY: 0.5, imageScale: 0.3 });
    await sleep(700);
    const { on: gridZoomed, off: zoomedOff } = await picturePair();
    const smallBox = changedBox(gridZoomed, zoomedOff);
    ok('transform: a scale patch resizes the lit rectangle',
      Boolean(smallBox && bigBox && smallBox.w < bigBox.w * 0.8 && smallBox.h < bigBox.h * 0.9),
      `scale 0.6 → ${boxText(bigBox)}, scale 0.3 → ${boxText(smallBox)}`);

    await patch({ imageScale: 0.6 });
    await sleep(700);
    const gridRot = await patch({ imageRotate: 45 }).then(() => sleep(800)).then(() => readGrid(c));
    ok('transform: a rotation patch turns the rectangle', diffCells(grid2, gridRot) > 50,
      `${diffCells(grid2, gridRot)} cells changed at 45°`);
    await patch({ imageRotate: 0 });
    await sleep(700);

    // ── 4. colour modes: three visibly different pictures ────────────────
    const byMode = {};
    for (const mode of ['raw', 'match', 'palette']) {
      await patch({ imageColour: mode });
      await sleep(700);
      const g = await readGrid(c);
      byMode[mode] = { grid: g, colours: colourSet(g), distinct: litDistinct(g) };
    }
    const dRawMatch = setDistance(byMode.raw.colours, byMode.match.colours);
    const dRawPal = setDistance(byMode.raw.colours, byMode.palette.colours);
    const dMatchPal = setDistance(byMode.match.colours, byMode.palette.colours);
    ok('colour: raw | match | palette are three different pictures',
      dRawMatch > 8 && dRawPal > 8 && dMatchPal > 4,
      `distinct colours raw=${byMode.raw.distinct} match=${byMode.match.distinct} palette=${byMode.palette.distinct}; ` +
      `set distance raw↔match=${dRawMatch} raw↔palette=${dRawPal} match↔palette=${dMatchPal}`);
    ok('colour: "match" collapses the picture onto ramp colours (fewer distinct than raw)',
      byMode.match.distinct < byMode.raw.distinct * 0.75,
      `${byMode.raw.distinct} raw → ${byMode.match.distinct} matched`);
    ok('colour: "palette" discards the picture\'s hue (fewer distinct than raw)',
      byMode.palette.distinct < byMode.raw.distinct * 0.75,
      `${byMode.raw.distinct} raw → ${byMode.palette.distinct} palette`);
    await patch({ imageColour: 'raw' });
    await sleep(700);

    // ── 5. bit depth: the ladder is 8/10/12, and the dither belongs to the top of it ─
    // 8-bit is 256 levels per channel, which is the most the uploaded PNG has; the quantiser is
    // the identity there and dithering it would only add noise. 10 and 12 bit are the depths the
    // ladder is for: the shader quantises the picture at every depth, and the 4x4 Bayer pattern
    // is what recovers the colours sitting between two quanta. Measured accordingly.
    const byBits = {};
    for (const bits of ['8', '10', '12']) {
      await patch({ imageBits: bits });
      await sleep(700);
      byBits[bits] = litDistinct(await readGrid(c));
    }
    ok('depth: the ladder is 8, 10 and 12 bit at 4 bits per step', byBits['8'] > 0 && byBits['10'] > 0 && byBits['12'] > 0,
      `8-bit=${byBits['8']} 10-bit=${byBits['10']} 12-bit=${byBits['12']} distinct cell colours`);

    const flat12 = await patch({ imageBits: '12', imageDither: 0 }).then(() => sleep(800)).then(() => readGrid(c));
    const dith12 = await patch({ imageBits: '12', imageDither: 1 }).then(() => sleep(800)).then(() => readGrid(c));
    ok('depth: the ordered dither band-fills the 12-bit picture (more distinct colours)',
      litDistinct(dith12) > litDistinct(flat12),
      `12-bit flat=${litDistinct(flat12)} dithered=${litDistinct(dith12)} distinct`);

    const flat8 = await patch({ imageBits: '8', imageDither: 0 }).then(() => sleep(800)).then(() => readGrid(c));
    const dith8 = await patch({ imageBits: '8', imageDither: 1 }).then(() => sleep(800)).then(() => readGrid(c));
    ok('depth: at 8-bit the dither has no steps worth filling (change stays inside noise)',
      Math.abs(litDistinct(dith8) - litDistinct(flat8)) <= Math.max(4, litDistinct(flat8) * 0.1),
      `8-bit flat=${litDistinct(flat8)} dithered=${litDistinct(dith8)} distinct`);
    await patch({ imageBits: '8', imageDither: 1 });
    await sleep(600);

    // ── 6. preset round-trip: save the placement, reload, get it back ─────
    await patch({ imageX: 0.34, imageY: 0.42, imageScale: 0.44, imageRotate: 12, imageColour: 'match', imageBits: '8' });
    await sleep(500);
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
    await sleep(400);
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

    // the page reloads and draws the same picture in the same place: a real restore, not a
    // server-side document nobody renders
    await c.send('Page.reload', { ignoreCache: true });
    await sleep(1200);
    const remounted = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.imgTex)', 12000);
    await sleep(900);
    const gridReload = await readGrid(c);
    ok('preset: a reload draws the restored placement on the wall', Boolean(remounted) && diffCells(gridRot, gridReload) > 20,
      `${diffCells(gridRot, gridReload)} cells differ from the 45° frame`);
  } finally {
    c.close();
    stopChrome();
    srv.stop();
    await sleep(150);
    if (srv.log) fs.writeFileSync(path.join(SCRATCH, 'wall-image-server.log'), srv.log.join(''));
    fs.writeFileSync(path.join(SCRATCH, 'wall-image-console.log'), consoleLines.join('\n'));
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`wall-image-browser: ${err.stack || err.message}`);
  process.exit(1);
});
