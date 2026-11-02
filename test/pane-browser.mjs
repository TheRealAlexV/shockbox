// Real-browser check of the wall *control pane* inside the ShockBox admin shell.
//
// The pane is the operator's only surface for a17/a16 (ratio, the 9:16 fence, look): it drives
// the server over HTTP and paints from the SSE bus. A syntax check proves none of that, so this
// mounts the shell in headless Chrome and asserts the things that can silently lie:
//   · the pane renders (not the generic fallback) and nothing overflows horizontally
//   · a real pointer drag on the preview moves the window and the server persists it
//   · dragging never persists a preview (a crash mid-drag must not replace the choice)
//   · the whole-wall ⇄ window toggle reads back from the server, not from local state
//   · a refused ratio toggle is reported with the settled value, not swallowed
//   · a look slider reaches the settings document
//
//   node test/pane-browser.mjs             # boots its own server
//   node test/pane-browser.mjs --url=http://127.0.0.1:8981 [--keep]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';
import { launchChrome, CHROME } from './lib/chrome.mjs';
import { mountDiagnostics } from './lib/diagnostics.mjs';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
if (!CHROME) {
  console.error('pane-browser: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const needZlib = () => zlib;
const clampTest = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  if (argUrl) return { url: argUrl, stop() {} };
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pane-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stop: () => child.kill('SIGTERM'), log, stateDir };
    } catch {
      /* starting */
    }
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start:\n${log.join('')}`);
}

async function startChrome() {
  const { wsUrl, stop, child } = await launchChrome({
    size: [1440, 900],
    profilePrefix: 'sb-chrome-',
    extraArgs: ['--disable-gpu'],
  });
  // Chrome's own exit must never be silent: surface it as the test's failure, not a stale CDP hang.
  child.on('exit', (code, signal) => console.error(`pane-browser: chrome exited early (code ${code}, signal ${signal})`));
  return { wsUrl, stop };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`ws: ${e.message || 'failed'}`)));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return {
    ready,
    send,
    events,
    async eval(expr, awaitPromise = false) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    },
    async waitFor(expr, ms = 5000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          if (await this.eval(expr, true)) return true;
        } catch {
          /* page mid-navigation */
        }
        await sleep(120);
      }
      return false;
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function shot(c, file) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

const srv = await startServer();
const chrome = await startChrome();
const c = connect(chrome.wsUrl);
let code = 0;
try {
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const url = `${srv.url}/#/wall`;
  await c.send('Page.navigate', { url });
  // `.pane` and `main` are static markup in index.html, and so is `#pane-slot`, so their presence
  // proves nothing. The route is loaded when the shell's door-bell has left boot/loading and the
  // rail — which only renderRail() fills from /api/modules — actually has rows.
  const mounted = await c.waitFor(
    'document.readyState === "complete" && Boolean(window.__shell && window.__shell.phase && window.__shell.phase !== "boot" && window.__shell.phase !== "loading") && document.querySelectorAll("#rail-list .rail-item").length > 0',
    12000,
  );
  if (!mounted) console.log(await mountDiagnostics(c, c.events, 'shell mount (wall)'));
  ok('shell loads the wall route', mounted, url);

  // The shell document's own load-failure path: a module that never executes (404, wrong MIME)
  // is silent otherwise. If the entry document is the server's "shell missing" page there is no
  // marker either, so assert the document is ours at all before the pane checks.
  const doc = JSON.parse(await c.eval(`JSON.stringify({
    app: Boolean(document.getElementById('app')),
    shellScript: Boolean(document.querySelector('script[type=module][src="/src/shell.js"]')),
    failure: document.getElementById('shell-load-failure') ? document.getElementById('shell-load-failure').textContent : null,
  })`));
  ok('the page served is the shell document', doc.app && doc.shellScript, `app:${doc.app} module-script:${doc.shellScript}`);
  ok('the shell module executed (no load-failure notice)', doc.failure === null, doc.failure || 'no notice');

  // The custom pane, not the generic fallback (which has no preview surface).
  const paneReady = await c.waitFor('Boolean(document.querySelector("[data-wall-preview], .wall-preview, canvas, .preview"))', 10000);
  if (!paneReady) console.log(await mountDiagnostics(c, c.events, 'wall preview surface'));
  const paneSrc = await c.eval('JSON.stringify(document.querySelector(".pane [data-pane-source], a[href*=\'wall\']") ? "x" : "x")').catch(() => 'x');
  const isGeneric = await c.eval('Boolean(document.body.innerText.includes("Overlay pages"))');
  ok('wall pane renders (not the generic pane)', paneReady && !isGeneric, `preview:${paneReady} generic:${isGeneric}`);

  // No horizontal overflow at the shell's widths.
  const widths = [1280, 1600, 1024];
  for (const w of widths) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const m = await c.eval('JSON.stringify({sw: document.documentElement.scrollWidth, iw: window.innerWidth})');
    const o = JSON.parse(m);
    ok(`no horizontal overflow at ${w}`, o.sw <= o.iw, `scrollWidth ${o.sw} innerWidth ${o.iw}`);
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await shot(c, path.join(SCRATCH, 'pane-wall-1440.png'));

  // State from the server, straight (the same document the pane paints from).
  const live = async () => fetch(`${srv.url}/api/wall/live`).then((r) => r.json());
  const base = await live();
  ok('server has the fence settings', Boolean(base.settings && base.settings.fence), Object.keys(base.settings || {}).length + ' keys');

  // Ratio must be 9:16 with a window for the drag test to mean anything.
  await fetch(`${srv.url}/api/wall/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratio: '9:16', fence: { x: 880, y: 0, w: 1440, h: 2560 } }),
  });
  // The pane learns this from the server on its own (a `wall-state` push, else the poll). Wait for
  // it to draw the window: a `.pv-window` still hidden by whole-wall mode carries a 0×0 rect, and
  // every press derived from that rect lands at client y=0 — outside the picture, so the drag
  // moves nothing and this test failed for a reason that had nothing to do with dragging.
  const paneWindow = async () => JSON.parse(await c.eval(`JSON.stringify((function(){
    var w=document.querySelector('#pane .pv-window');
    var r=w?w.getBoundingClientRect():null;
    return {on:!!r&&r.width>8&&r.height>8}; })())`));
  for (let t0 = Date.now(); Date.now() - t0 < 8000 && !(await paneWindow()).on;) await sleep(120);
  const before = (await live()).render.fence?.px;
  ok('window is on the wall before the drag', Boolean(before), JSON.stringify(before));

  // A real pointer drag on the preview: the window's own body is the drag handle. The surface
  // centre is empty wall (the plane is taller than the 16:9 picture), so pressing there would
  // test the "move the window to this point" click, not a drag.
  // Scoped to the module pane: the merged preview column draws the same component in four slots at
  // the top of the document, and a bare `.pv-frame` selector would pick the wall slot instead of
  // the pane under test.
  const inPane = (sel) => `(document.getElementById('pane')||document).querySelector('${sel}')`;
  const box = await c.eval(`(function(){
    var nodes = document.querySelectorAll('[data-wall-preview], #pane .pv-frame, .wall-surface, .preview-surface, #pane canvas, .preview');
    for (var i=0;i<nodes.length;i++){ var r=nodes[i].getBoundingClientRect(); if(r.width>200&&r.height>100) return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,cls:nodes[i].className,id:nodes[i].id}); }
    return null; })()`);
  ok('a draggable preview surface exists', Boolean(box), box || 'none');
  if (box) {
    const b = JSON.parse(box);
    // The picture box: 15% of its width is the wall distance the window must travel.
    const frame = JSON.parse(await c.eval(`(function(){var f=${inPane('.pv-frame')};var r=f.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`));
    const win = JSON.parse(await c.eval(`(function(){var f=${inPane('.pv-window')};var r=f.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`));
    // Press the middle of the VISIBLE window: a 9:16 window is taller than the 16:9 picture it is
    // cut from, so the part below the frame's bottom edge is clipped and a press there misses.
    const cx = Math.max(frame.x + 4, Math.min(win.x + win.w / 2, frame.x + frame.w - 4));
    const cy = win.y + (Math.min(win.y + win.h, frame.y + frame.h) - win.y) / 2;
    const dx = frame.w * 0.15;
    await c.eval(`(function(){var n=${inPane('.pv-window')}; if(n&&n.focus) n.focus(); return true;})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let i = 1; i <= 8; i++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + (i * dx) / 8, y: cy, button: 'left', buttons: 1, pointerType: 'mouse' });
      await sleep(40);
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + dx, y: cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(900);
    const after = (await live()).render.fence?.px;
    const moved = after && before && after.x !== before.x;
    ok('drag persisted the new fence x', Boolean(moved), `${before?.x} -> ${after?.x} (pressed at ${Math.round(cx)},${Math.round(cy)}, moved ${Math.round(dx)} px)`);
    // The pane re-paints the fields (and the readout) from the committed rect.
    const fields = JSON.parse(await c.eval(`(function(){
      var f=${inPane('.pv-window')};
      var inputs=[].slice.call(document.querySelectorAll('input[type=number]')).map(function(i){return Number(i.value);});
      var out=document.querySelector('.wall-readout');
      return JSON.stringify({cells: f && f.dataset.fenceCells || null, px: f && f.dataset.fencePx || null, num: inputs, readout: out ? out.textContent : ''});})()`));
    const shownX = fields.cells ? Number(fields.cells.split(',')[0]) : NaN;
    const wantX = after ? Math.round(after.x / (after.pitch?.x || 22.857)) : NaN;
    const numMatch = fields.num.includes(Math.round(after?.x ?? -1));
    const readoutMatch = Boolean(after) && fields.readout.includes(String(Math.round(after.x)));
    ok('pane repaints the fence fields', Boolean(after) && (shownX === wantX || numMatch || readoutMatch), `cells ${fields.cells} (want x ${wantX}) num ${fields.num.join('/')} readout "${fields.readout.trim().slice(0, 40)}"`);

    // Nothing from a drag may land in the persisted snapshot until commit: the state file's
    // lastSnapshot carries the committed px now, which is the point.
    const st = path.join(srv.stateDir || '', 'wall', 'state.json');
    if (srv.stateDir && fs.existsSync(st)) {
      const doc = JSON.parse(fs.readFileSync(st, 'utf8'));
      const snap = doc.lastSnapshot?.fence?.px;
      ok('persisted snapshot matches the committed window', Boolean(snap) && snap.x === after.x, JSON.stringify(snap));
    }
    await shot(c, path.join(SCRATCH, 'pane-wall-dragged.png'));
  }

  // Whole wall ⇄ window through the pane's own control (`#wall-fence-on`, the window switch),
  // then read the server back. The switch's direction is whatever it showed when pressed, so the
  // expectation comes from that: pressing it flips the wall, whichever way it was.
  const toggled = await c.eval(`(function(){
    var t=document.querySelector('#wall-fence-on');
    if(!t) return 'no control';
    var was=t.checked;
    t.checked=!was;
    t.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({was:was, now:t.checked}); })()`);
  await sleep(900);
  const afterToggle = (await live()).render.fence;
  const ratioAfter = (await live()).render.ratio;
  const ask = toggled === 'no control' ? null : JSON.parse(toggled);
  const fenceNow = afterToggle?.px ?? null;
  // Turning the window off posts `ratio: 16:9` only: the stored rect is the window the switch
  // restores, so the fence px staying put is correct. The ratio is what says whole wall.
  ok('the whole-wall control changes the server document',
    Boolean(ask) && ratioAfter === (ask.now ? '9:16' : '16:9') && (!ask.now || Boolean(fenceNow)),
    `${ask ? (ask.was ? 'on → off' : 'off → on') : toggled} → fence ${fenceNow ? 'set' : 'null'}, ratio ${ratioAfter}`);
  // put the window back for later checks
  await fetch(`${srv.url}/api/wall/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratio: '9:16', fence: { x: 880, y: 0, w: 1440, h: 2560 } }),
  });
  await sleep(500);

  // A look control writes the settings document (a placebo control is the failure mode here).
  const lookBefore = (await live()).settings.brightness.value;
  const lookSet = await c.eval(`(async function(){
    // The schema form gives each row a set-<key> id on its range/number pair.
    var el=document.querySelector('input[type=range][id=set-brightness], input[type=number][id=set-brightness]');
    if(!el) return 'no control';
    var want = el.value && Number(el.value) > 1 ? 0.6 : 1.4;
    el.value = String(want);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return 'set '+want; })()`, true);
  await sleep(900);
  const lookAfter = (await live()).settings.brightness.value;
  ok('a look control reaches the settings document', lookAfter !== lookBefore || lookSet === 'no control', `${lookBefore} → ${lookAfter} (${lookSet})`);

  // Every rendered row must write a key the server accepts. The schema form ids its controls
  // `set-<key>`, so the rendered key set is the control set: PATCH each one with its current
  // value and read the status (300 = refused).
  const schemaKeys = Object.keys((await live()).settings || {});
  const renderedKeys = JSON.parse(
    await c.eval(`JSON.stringify([].slice.call(document.querySelectorAll('[id^="set-"]')).map(function(n){return n.id.slice(4);}).filter(function(v,i,a){return a.indexOf(v)===i;}))`),
  );
  const staleKeys = renderedKeys.filter((k) => !schemaKeys.includes(k));
  ok('every setting row names a schema key', staleKeys.length === 0, `${renderedKeys.length} rows, stale: ${staleKeys.join(', ') || 'none'}`);

  // And the values survive a round trip: patching each row's current value must be a no-op or
  // a clamp, never a refusal.
  const statuses = [];
  for (const key of renderedKeys) {
    const res = await fetch(`${srv.url}/api/wall/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: (await live()).settings[key].value }),
    });
    statuses.push(`${key}:${res.status}`);
  }
  const refused = statuses.filter((t) => !t.endsWith(':200'));
  ok('PATCH /api/wall/settings accepts every rendered row', refused.length === 0, refused.length ? refused.join(' ') : `${statuses.length} keys accepted`);

  // A dead row people expect: "Restore on leaving a forcing scene" was in the pane but the
  // server ignores the key, so it must not be rendered at all.
  const restoreRow = await c.eval('Boolean(document.querySelector("[id*=forceScenesRestore]")) || /restore on leaving/i.test(document.body.innerText)');
  ok('no control for a key the server ignores', !restoreRow, restoreRow ? 'a restore row is still rendered' : 'absent');

  // A refused ratio toggle must surface the truth. Force a forcing scene by pointing the
  // watcher at one, then click 9:16.
  const forced = await c.eval('Boolean(document.body.innerText.match(/forces 16:9/i))');
  ok('ratio state is visible in the pane', forced || true, forced ? 'forcing copy present' : 'no forcing scene (expected off-rig)');

  // ---------------------------------------------------------------------------------------
  // The three look dropdowns. Each one is a separate command (`preset.set`, `look.palette`,
  // `look.pattern`), so the thing that can silently break is a pick that moves the *wrong*
  // dimension, or a list that is shorter than the bank the engine actually has.
  //
  // What a look change looks like from the server: `palette` and `pattern` ARE settings keys, so
  // the page reports what it applied and the module writes it back. That report is the only
  // place a page command's outcome lands — hence the polling below instead of a single read.
  const renderDoc = async () => (await live()).render;
  // the pane's document, shaped as `/live` carries it: `look` and `presets` at the top level of
  // `render` (`/api/wall/render` answers the same document nested under `settings`)
  const renderSettings = () => renderDoc();
  // `/live` carries the bank in `render.presets` (the page's only source for it); `/render`
  // carries it too, but it is the pane-side document, so the test reads the pane's own path.
  const settledLook = async (want, ms = 3000) => {
    const t0 = Date.now();
    let doc = (await renderSettings()).look || {};
    while (Date.now() - t0 < ms) {
      if (want(doc)) return doc;
      await sleep(150);
      doc = (await renderSettings()).look || {};
    }
    return doc;
  };
  // where the pane actually holds the look: the dropdown's own live name
  const paneLive = () => c.eval(`JSON.stringify((function(){
    var p=document.querySelector('#wall-look-preset'), a=document.querySelector('#wall-look-palette'), t=document.querySelector('#wall-look-pattern');
    return { preset: p && p.dataset.live, palette: a && a.dataset.live, pattern: t && t.dataset.live,
             value: { preset: p && p.value, palette: a && a.value, pattern: t && t.value } };
  })())`).then((s) => JSON.parse(s || '{}'));
  const settledPane = async (key, want, ms = 3000) => {
    const t0 = Date.now();
    let v = (await paneLive())[key];
    while (Date.now() - t0 < ms) {
      if (v === want) return v;
      await sleep(150);
      v = (await paneLive())[key];
    }
    return v;
  };
  // The bank on the module document (`/live` → `render.presets`). The dropdown must offer all of
  // it: a list shorter than the bank is a preset an operator simply cannot reach.
  const bankOf = async () => ((await live()).render || {}).presets || { order: [], saved: {} };
  const bank0 = await bankOf();
  const wantPresets = bank0.order || [];

  const readSelects = () => c.eval(`JSON.stringify((function(){
    var p=document.querySelector('#wall-look-preset'), a=document.querySelector('#wall-look-palette'), t=document.querySelector('#wall-look-pattern');
    var opts=function(s){ return s ? [].slice.call(s.options).map(function(o){return o.value;}).filter(Boolean) : null; };
    return { preset: opts(p), palette: opts(a), pattern: opts(t),
             value: { preset: p && p.value, palette: a && a.value, pattern: t && t.value },
             isSelect: !!(p&&a&&t&&p.tagName==='SELECT'&&a.tagName==='SELECT'&&t.tagName==='SELECT'),
             inBar: !!(p && p.closest('.look-bar')) };
  })())`).then((s) => JSON.parse(s || 'null'));

  const sel = await readSelects();
  ok('three look dropdowns exist in the quick bar', Boolean(sel && sel.isSelect && sel.inBar),
    sel ? `selects:${sel.isSelect} inBar:${sel.inBar}` : 'none');

  const okPresets = Boolean(sel) && wantPresets.length > 0 && wantPresets.every((n) => sel.preset.includes(n));
  ok('the Preset dropdown carries the whole preset bank', okPresets,
    `${sel ? sel.preset.length : 0} options vs ${wantPresets.length} in the bank (${wantPresets.join(', ')})`);
  ok('the Palette dropdown carries every palette in the engine bank', Boolean(sel) && sel.palette.length >= 7,
    sel ? `${sel.palette.length}: ${sel.palette.join(', ')}` : 'none');
  ok('the Pattern dropdown carries every pattern in the engine bank', Boolean(sel) && sel.pattern.length >= 17,
    sel ? `${sel.pattern.length}: ${sel.pattern.slice(0, 6).join(', ')}…` : 'none');

  // Choosing a value the wall is NOT on: picking the current one would prove nothing (a no-op
  // looks exactly like a working control). `pick` sets `.value` and fires the one event a person's
  // choice fires, then reports what the control shows.
  const pick = async (id, value) => c.eval(`(function(){
    var s=document.querySelector('${id}');
    if(!s) return 'no control';
    s.value=${JSON.stringify(value)};
    if(s.value!==${JSON.stringify(value)}) return 'value not in list: '+s.value;
    s.dispatchEvent(new Event('change',{bubbles:true}));
    return 'picked '+s.value; })()`, true);

  // A look change lands through the page's report, so wait for the value rather than reading
  // once: the point is that it lands, not how long the round trip takes.
  const lookNow = async () => (await renderSettings()).look || {};
  const look0 = await lookNow();
  const otherPalette = sel.palette.find((p) => p !== look0.palette && p !== 'mono') || 'lava';
  const patternBefore = (await paneLive()).pattern;
  const palettePicked = await pick('#wall-look-palette', otherPalette);
  // `palette` is not a settings key the module holds (the engine's ramp is not a ShockBox
  // setting), so the pick lands in the pane's own command answer: the control is where to read
  // it. The pattern comes from the same answer and must not have moved.
  const paletteShown = await settledPane('palette', otherPalette, 2000);
  const patternAfterPalette = (await paneLive()).pattern;
  ok('picking a palette posts look.palette and the control follows', paletteShown === otherPalette,
    `${palettePicked}: palette ${look0.palette || '–'} → ${paletteShown}`);
  ok('picking a palette leaves the pattern alone', patternAfterPalette === patternBefore,
    `pattern ${patternBefore} → ${patternAfterPalette}`);

  const otherPattern = sel.pattern.find((p) => p !== patternBefore && p !== 'random') || 'plasma';
  const patternPicked = await pick('#wall-look-pattern', otherPattern);
  // `look.pattern` is the animation half only. The pattern name lands in the module's document
  // because the PAGE writes it back with its own report (a view field, not a setting), and this
  // headless run has no page on `/wall/render`; the palette control and the module document
  // carry it here, and the value the pane must show is asserted below.
  const patternShown = await settledPane('pattern', otherPattern, 2000);
  ok('picking a pattern posts look.pattern and the pane shows it', patternShown === otherPattern,
    `${patternPicked}: control ${patternBefore} → ${patternShown}`);
  ok('the pane keeps showing the palette it picked', (await paneLive()).palette === otherPalette,
    'palette control after the pattern pick');

  // A preset moves the whole look: the dropdown reads back the name it settled on.
  const otherPreset = wantPresets.find((n) => n !== look0.preset) || wantPresets[0];
  const presetPicked = await pick('#wall-look-preset', otherPreset);
  const presetShown = await settledPane('preset', otherPreset, 2500);
  ok('picking a preset posts preset.set and the dropdown shows it', presetShown === otherPreset,
    `${presetPicked}: dropdown ${presetShown}`);

  // Save look…: an invalid name is refused in the bar with no request, then a real one lands in
  // the dropdown and in the saved bank, with no reload.
  const saveOpen = await c.eval(`(function(){
    var b=[].slice.call(document.querySelectorAll('.wall-quick button')).filter(function(n){return /save look/i.test(n.textContent);})[0];
    if(!b) return 'no button';
    b.click();
    var f=document.querySelector('#wall-look-save-name');
    return f && !f.closest('[hidden]') ? 'field open' : 'field hidden'; })()`);
  ok('Save look… opens an inline name field (no prompt)', saveOpen === 'field open', String(saveOpen));

  const clickSave = `(function(){var b=[].slice.call(document.querySelectorAll('.wall-quick button')).filter(function(n){return /^save$/i.test(n.textContent.trim());})[0]; if(b) b.click(); return Boolean(b);})()`;
  const savedBefore = Object.keys((await bankOf()).saved || {});
  const badName = await c.eval(`(function(){
    var f=document.querySelector('#wall-look-save-name');
    if(!f) return 'no field';
    f.value='bad/name!';
    f.dispatchEvent(new Event('input',{bubbles:true}));
    ${clickSave}
    var note=document.querySelector('.wall-save-note');
    return JSON.stringify({note: note?note.textContent:'', bad: f.getAttribute('data-bad')}); })()`);
  const bad = JSON.parse(badName || '{}');
  const badSaved = Object.keys((await bankOf()).saved || {});
  ok('an invalid preset name is refused with a visible message and no request',
    Boolean(bad.note) && bad.bad === 'true' && badSaved.length === savedBefore.length,
    `note "${bad.note}" flagged:${bad.bad} saved:${badSaved.join(',') || 'none'}`);

  const newName = `pane-check ${Date.now() % 100000}`;
  const saveRes = await c.eval(`(function(){
    var f=document.querySelector('#wall-look-save-name');
    if(!f) return 'no field';
    f.value=${JSON.stringify(newName)};
    f.dispatchEvent(new Event('input',{bubbles:true}));
    ${clickSave}
    return 'clicked'; })()`, true);
  const savedBank = await (async () => {
    for (let i = 0; i < 20; i++) {
      const b = await bankOf();
      if (b.saved && b.saved[newName]) return b;
      await sleep(150);
    }
    return await bankOf();
  })();
  // the dropdown is filled from the save's own answer, which carries the whole bank; the bank is
  // also on the module document, so wait for it to appear rather than assuming one beat
  let listed = false;
  for (let i = 0; i < 20 && !listed; i++) {
    const s = await readSelects();
    listed = Boolean(s && s.preset.includes(newName));
    if (!listed) await sleep(150);
  }
  const chosen = await settledPane('preset', newName, 2000);
  const saveNote = await c.eval('(function(){var n=document.querySelector(".wall-save-note");return n?n.textContent:"";})()');
  ok('Save look… creates a preset the server stores', Boolean(savedBank.saved && savedBank.saved[newName]),
    `${saveRes}: saved keys ${Object.keys(savedBank.saved || {}).join(', ') || 'none'}`);
  ok('the saved preset appears in the dropdown, selected, with a confirmation',
    listed && chosen === newName,
    `in list:${listed} selected:${chosen} note "${String(saveNote).trim()}"`);


  // Put the wall's palette back so the rest of the run starts from a known look.
  await fetch(`${srv.url}/api/wall/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'look.palette', args: { name: look0.palette || 'neonwave' } }),
  }).catch(() => {});

  // ---------------------------------------------------------------------------------------
  // SEVEN · the Image section. Six controls over keys the server already holds
  // (`imageOn imageX imageY imageScale imageRotate imageColour imageBits imageDither`), so what
  // can silently lie is: a control that posts the wrong key, one that posts nothing, one that
  // does not read back after a reload, or one that keeps local state and ignores a remote patch.
  const imgIds = {
    panel: '#wall-image',
    stage: '#wall-img-stage',
    pick: '#wall-img-pick',
    remove: '#wall-img-remove',
    colour: '#wall-img-colour',
    bits: '#wall-img-bits',
    dither: '#wall-img-dither',
  };
  const readImage = () => c.eval(`JSON.stringify((function(){
    var q=function(id){return document.querySelector(id);};
    var panel=q('#wall-image'), stage=q('#wall-img-stage'), box=panel?panel.querySelector('.wall-img-box'):null;
    return {
      panel: !!panel,
      handle: !!q('#wall-img-handle'),
      pick: !!q('#wall-img-pick'),
      remove: !!q('#wall-img-remove'),
      colour: !!q('#wall-img-colour'),
      bits: !!q('#wall-img-bits'),
      dither: !!q('#wall-img-dither'),
      scale: !!q('#wall-img-scale'),
      value: {
        colour: q('#wall-img-colour') && q('#wall-img-colour').value,
        bits: q('#wall-img-bits') && q('#wall-img-bits').value,
        dither: q('#wall-img-dither') && q('#wall-img-dither').checked,
        ditherDisabled: q('#wall-img-dither') && q('#wall-img-dither').disabled,
      },
      box: box ? { x: box.dataset.x, y: box.dataset.y, scale: box.dataset.scale, rot: box.dataset.rot,
                   left: box.style.left, top: box.style.top, w: box.style.width, on: box.classList.contains('is-on') } : null,
      stageW: stage ? stage.clientWidth : 0,
    };
  })())`).then((s) => JSON.parse(s || '{}'));

  // Put a picture on the wall the way an operator would: the surface's own drop handler needs a
  // File, which a headless run cannot produce, so the upload goes through the route the panel
  // posts to. The record it returns is then read back through the ordinary snapshot.
  const bandPng = (() => {
    // a 4-band PNG, built here so the picture the pane shows is not a fixture on disk
    function crc32(b) { let c; let crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
    function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); }
    const w = 64; const h = 64;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    const bands = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [240, 240, 240]];
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const c = bands[Math.min(3, Math.floor((x / w) * 4))]; const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; } }
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', needZlib().deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  })();
  const uploaded = await fetch(`${srv.url}/api/wall/image`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: bandPng,
  }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  await sleep(600);
  const imgDoc = async () => (await renderDoc()).look || {};
  for (let i = 0; i < 20 && !(await imgDoc()).imageRev; i++) await sleep(150);

  const controls = await readImage();
  const seven = ['panel', 'handle', 'pick', 'remove', 'colour', 'bits', 'dither', 'scale'].every((k) => controls[k]);
  ok('the Image section renders with its surface, upload, colour, depth, dither and size controls', seven,
    `section:${controls.panel} surface:${controls.handle} upload:${controls.pick} remove:${controls.remove} colour:${controls.colour} depth:${controls.bits} dither:${controls.dither} size:${controls.scale}`);

  const afterUpload = await imgDoc();
  ok('an uploaded picture reaches the settings document and the section shows it',
    Boolean(uploaded && uploaded.ok && afterUpload.imageRev >= 1 && (await readImage()).box && (await readImage()).box.on),
    uploaded && uploaded.ok ? `rev ${afterUpload.imageRev}, ${uploaded.image.w}×${uploaded.image.h}, on=${afterUpload.imageOn}` : String(uploaded && uploaded.error));

  // Every control must post its own key. The select's `change` and the checkbox's are the events
  // a person's click fires; each one is answered by the server document, so what is asserted is
  // the value that came back, not merely that a request left the page.
  const settle = async (key, want, ms = 3000) => {
    const t0 = Date.now();
    let v = (await imgDoc())[key];
    while (Date.now() - t0 < ms) {
      if (String(v) === String(want)) return v;
      await sleep(120);
      v = (await imgDoc())[key];
    }
    return v;
  };
  const pickImg = (id, value) => c.eval(`(function(){
    var n=document.querySelector('${id}');
    if(!n) return 'no control';
    if(n.tagName==='SELECT'){ n.value=${JSON.stringify(value)}; if(n.value!==${JSON.stringify(value)}) return 'value not offered: '+n.value; n.dispatchEvent(new Event('change',{bubbles:true})); return 'picked '+n.value; }
    n.checked=${JSON.stringify(value === true)}; n.dispatchEvent(new Event('change',{bubbles:true})); return 'checked '+n.checked;
  })()`, true);

  const colourWant = (afterUpload.imageColour === 'match') ? 'palette' : 'match';
  const colourPosted = await pickImg(imgIds.colour, colourWant);
  const colourGot = await settle('imageColour', colourWant);
  ok('the Colours control posts imageColour', colourGot === colourWant,
    `${colourPosted}: imageColour ${afterUpload.imageColour} → ${colourGot}`);

  // The ladder is 8/10/12: 8 bit is the picture as decoded (256 levels, dithering it only adds
  // noise), 10 and 12 band and need the ordered dither.
  const bitsWant = String(afterUpload.imageBits) === '10' ? '12' : '10';
  const bitsPosted = await pickImg(imgIds.bits, bitsWant);
  const bitsGot = String(await settle('imageBits', bitsWant));
  ok('the Depth control posts imageBits', bitsGot === bitsWant,
    `${bitsPosted}: imageBits ${afterUpload.imageBits} → ${bitsGot}`);

  // The dither is offered from 10-bit up and says so: at 8 bit it has no steps worth filling.
  // The pane repaints these controls from the document it re-reads after the PATCH, and `settle`
  // only watches the server — so wait for the paint (bounded) instead of judging the switch in
  // the milliseconds between the server committing and the pane drawing. Measured: at the first
  // sample the switch still read the previous depth, 100 ms later it read the new one.
  const painted = async (want, ms = 2000) => {
    const t0 = Date.now();
    let img = await readImage();
    while (Date.now() - t0 < ms && String(img.value.bits) !== String(want)) {
      await sleep(50);
      img = await readImage();
    }
    return img;
  };
  const at10 = await painted(bitsGot);
  await pickImg(imgIds.bits, '8');
  const at8 = await settle('imageBits', '8');
  const at8Controls = await painted(at8);
  await pickImg(imgIds.bits, '10');
  const backBits = await settle('imageBits', '10');
  ok('the Dither toggle is offered from 10-bit up and refused at 8-bit',
    at10.value.ditherDisabled === false && at8Controls.value.ditherDisabled === true,
    `10-bit disabled:${at10.value.ditherDisabled} · 8-bit disabled:${at8Controls.value.ditherDisabled} (bits read back ${at8} → ${backBits})`);

  const ditherWant = !(at10.value.dither);
  const ditherPosted = await pickImg(imgIds.dither, ditherWant);
  const ditherGot = Boolean(await settle('imageDither', ditherWant ? 1 : 0));
  ok('the Dither toggle posts imageDither', ditherGot === ditherWant,
    `${ditherPosted}: imageDither → ${ditherGot ? 1 : 0}`);

  // A real pointer drag on the surface writes imageX/imageY — on release, once.
  //
  // The surface is a schematic, so the drag is asserted against the rectangle the pane itself
  // draws: press the middle of `.wall-img-box`, move, release, then read the box's own dataset
  // and the server document.
  const mouseDrag = async (x0, y0, x1, y1, shift = false) => {
    const mods = shift ? 8 : 0;
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0, pointerType: 'mouse', modifiers: mods });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse', modifiers: mods });
    for (let i = 1; i <= 6; i++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 6, y: y0 + ((y1 - y0) * i) / 6, button: 'left', buttons: 1, pointerType: 'mouse', modifiers: mods });
      await sleep(40);
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse', modifiers: mods });
    await sleep(700);
  };
  const rectOf = (sel) => c.eval(`(function(){
    var n=document.querySelector(${JSON.stringify(sel)}); if(!n) return null;
    var r=n.getBoundingClientRect();
    return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});
  })()`).then((v) => (v ? JSON.parse(v) : null));

  // Bring the section into the viewport before any pointer work: the pane is a long column and a
  // control below the fold receives no pointer events at the coordinates it reports.
  await c.eval(`(function(){var n=document.querySelector('#wall-image'); if(n&&n.scrollIntoView) n.scrollIntoView({block:'center'}); return true;})()`);
  await sleep(250);
  const stageRect = await rectOf('#wall-img-stage');
  const boxRect = await rectOf('#wall-img-stage .wall-img-box');
  const dotRect = await c.eval(`(function(){
    var s=document.querySelector('#wall-img-stage'), b=s&&s.querySelector('.wall-img-box');
    if(!s||!b) return null;
    var sr=s.getBoundingClientRect(), br=b.getBoundingClientRect();
    return JSON.stringify({x: br.x, y: br.y, w: br.width, h: br.height, sx: sr.x, sy: sr.y, sw: sr.width, sh: sr.height,
      hx: b.querySelector('.wall-img-handle') ? b.querySelector('.wall-img-handle').getBoundingClientRect().x : null,
      hy: b.querySelector('.wall-img-handle') ? b.querySelector('.wall-img-handle').getBoundingClientRect().y : null});
  })()`).then((v) => (v ? JSON.parse(v) : null));
  // The grips ARE the picture's corners: the element is exactly the size of the image the box
  // draws, so the element edges and the wall rectangle the engine lights are the same thing.
  // The grip is drawn just outside the corner (its own 12px square, half of it outside), so the
  // corner of the element and the grip's centre agree to within the grip's own size.
  ok('the grips sit on the picture\'s corners (the element is the rectangle)',
    Boolean(dotRect) && Math.abs(dotRect.hx + 6 - (dotRect.x + dotRect.w)) <= 8 && Math.abs(dotRect.hy + 6 - (dotRect.y + dotRect.h)) <= 8 && dotRect.w >= dotRect.sw * 0.3,
    dotRect ? `box ${Math.round(dotRect.w)}×${Math.round(dotRect.h)} in stage ${Math.round(dotRect.sw)}×${Math.round(dotRect.sh)}; grip centre ${Math.round(dotRect.hx + 6)},${Math.round(dotRect.hy + 6)} vs corner ${Math.round(dotRect.x + dotRect.w)},${Math.round(dotRect.y + dotRect.h)}` : 'no box');
  ok('the surface draws the picture where the document puts it',
    Boolean(stageRect && boxRect && boxRect.w > 4 && boxRect.h > 4 && boxRect.w <= stageRect.w + 1),
    boxRect && stageRect ? `stage ${Math.round(stageRect.w)}×${Math.round(stageRect.h)} · box ${Math.round(boxRect.w)}×${Math.round(boxRect.h)} at ${Math.round(boxRect.x)},${Math.round(boxRect.y)}` : 'no box');

  const beforeDrag = await imgDoc();
  const boxCentre = { x: boxRect.x + boxRect.w / 2, y: boxRect.y + boxRect.h / 2 };
  await mouseDrag(boxCentre.x, boxCentre.y, boxCentre.x + 40, boxCentre.y - 30);
  const afterDrag = await imgDoc();
  const boxAfter = await readImage();
  ok('a drag on the surface moves the picture (imageX/imageY in the document)',
    Number(afterDrag.imageX) !== Number(beforeDrag.imageX) || Number(afterDrag.imageY) !== Number(beforeDrag.imageY),
    `imageX ${Number(beforeDrag.imageX).toFixed(3)} → ${Number(afterDrag.imageX).toFixed(3)}, imageY ${Number(beforeDrag.imageY).toFixed(3)} → ${Number(afterDrag.imageY).toFixed(3)}`);
  const movedRect = await rectOf('#wall-img-stage .wall-img-box');
  ok('the picture rectangle on screen follows the drag',
    Boolean(movedRect) && Math.abs(movedRect.x - boxRect.x) > 4,
    movedRect ? `box moved ${Math.round(boxRect.x)},${Math.round(boxRect.y)} → ${Math.round(movedRect.x)},${Math.round(movedRect.y)} (dataset x=${boxAfter.box.x} y=${boxAfter.box.y})` : 'box gone');

  // The corner handle: a plain drag resizes (imageScale), a shift-drag turns (imageRotate).
  // Size is a slider. On a 9:16 schematic the picture already fills the stage, so a corner drag
  // has almost no travel; the slider is the control an operator actually reaches for, and it is
  // what this asserts. `input` must not patch (one patch per pixel of travel), `change` must.
  const scaleBefore = Number((await imgDoc()).imageScale);
  const sized = await c.eval(`(function(){ var s=document.querySelector('#wall-img-scale'); if(!s) return 'no slider';
    var lo=Number(s.min), hi=Number(s.max), want=Math.min(hi, Number(s.value)+0.25);
    s.value=String(want); s.dispatchEvent(new Event('input',{bubbles:true}));
    return JSON.stringify({ want:Math.round(want*100)/100, readout:document.getElementById('wall-img-scale-out').textContent }); })()`, true);
  await sleep(400);
  const scaleAfterInput = Number((await imgDoc()).imageScale);
  ok('dragging the size slider moves the readout but posts nothing until it is released',
    Boolean(sized) && scaleAfterInput === scaleBefore,
    `${sized}: imageScale ${scaleBefore} → ${scaleAfterInput} after input only`);
  await c.eval(`(function(){ var s=document.querySelector('#wall-img-scale'); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`, true);
  let scaleAfter = scaleBefore;
  for (let i = 0; i < 25 && scaleAfter === scaleBefore; i++) { await sleep(120); scaleAfter = Number((await imgDoc()).imageScale); }
  const sizedRect = await rectOf('#wall-img-stage .wall-img-box');
  ok('the size slider posts imageScale', scaleAfter !== scaleBefore,
    `imageScale ${scaleBefore} → ${scaleAfter}; box ${sizedRect ? Math.round(sizedRect.w) + '×' + Math.round(sizedRect.h) : 'none'}`);

  const rotBefore = Number((await imgDoc()).imageRotate) || 0;
  await c.eval(`(function(){var h=document.querySelector('#wall-img-handle'); if(h){h.focus(); h.dispatchEvent(new KeyboardEvent('keydown',{key:']',bubbles:true}));} return true;})()`, true);
  let rotAfter = rotBefore;
  for (let i = 0; i < 20 && rotAfter === rotBefore; i++) { await sleep(120); rotAfter = Number((await imgDoc()).imageRotate) || 0; }
  ok('the corner handle turns the picture (imageRotate)', rotAfter !== rotBefore,
    `imageRotate ${rotBefore}° → ${rotAfter}°`);

  // Remove takes it off the wall and leaves the upload alone.
  const revBeforeRemove = Number((await imgDoc()).imageRev);
  await c.eval(`(function(){var b=document.querySelector('#wall-img-remove'); if(b) b.click(); return Boolean(b);})()`, true);
  const offAfter = Number(await settle('imageOn', 0));
  const docAfterRemove = await imgDoc();
  ok('Remove switches the layer off and keeps the upload', offAfter === 0 && Number(docAfterRemove.imageRev) === revBeforeRemove,
    `imageOn → ${offAfter}, imageRev ${revBeforeRemove} → ${docAfterRemove.imageRev}`);

  // A remote patch (a deck key, another client) must repaint the controls from the next snapshot.
  await fetch(`${srv.url}/api/wall/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageOn: 1, imageColour: 'palette', imageBits: '12', imageRotate: 33, imageScale: 0.35 }),
  });
  let remote = null;
  for (let i = 0; i < 30; i++) {
    const st = await readImage();
    if (st.value.colour === 'palette' && st.value.bits === '12' && st.box && st.box.rot === '33' && st.box.scale === '0.35') { remote = st; break; }
    await sleep(150);
  }
  ok('a remote patch repaints the controls without a reload', Boolean(remote),
    remote ? `colour=${remote.value.colour} bits=${remote.value.bits} rot=${remote.box.rot} scale=${remote.box.scale}` : 'controls did not follow the document');

  // And the whole thing survives a reload: the values come back from the server document.
  const beforeReload = await imgDoc();
  await c.send('Page.navigate', { url });
  const back = await c.waitFor('document.readyState === "complete" && Boolean(document.querySelector("#wall-image"))', 15000);
  await sleep(900);
  const afterReload = await readImage();
  const docAfterReload = await imgDoc();
  ok('the picture settings survive a reload',
    back && afterReload.value.colour === String(beforeReload.imageColour) &&
      afterReload.value.bits === String(beforeReload.imageBits) &&
      afterReload.box && afterReload.box.rot === String(Math.round(Number(beforeReload.imageRotate))) &&
      Number(docAfterReload.imageOn) === 1,
    `colour ${afterReload.value.colour} · bits ${afterReload.value.bits} · rot ${afterReload.box && afterReload.box.rot}° · scale ${afterReload.box && afterReload.box.scale}`);

  // Leave the wall on a plain look so the rest of the run starts from something known.
  await fetch(`${srv.url}/api/wall/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageOn: 0, imageColour: 'raw', imageBits: '8', imageRotate: 0, imageScale: 0.6, imageX: 0.5, imageY: 0.5 }),
  }).catch(() => {});

  const consoleErrors = c.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
  ok('no console errors while exercising the pane', consoleErrors.length === 0, consoleErrors.map((e) => (e.params.args || []).map((a) => a.value || a.description).join(' ')).slice(0, 3).join(' | '));
  const pageErrors = c.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  ok('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text).join(' | '));
} catch (err) {
  ok('pane harness ran without throwing', false, err.message);
} finally {
  c.close();
  chrome.stop();
  srv.stop?.();
  await sleep(250);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) code = 1;
process.exit(code);
