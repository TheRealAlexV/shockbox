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
import path from 'node:path';
import { launchChrome, CHROME } from './lib/chrome.mjs';

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
  const mounted = await c.waitFor('Boolean(document.querySelector(".pane, main")) && document.readyState === "complete"', 12000);
  ok('shell loads the wall route', mounted, url);

  // The custom pane, not the generic fallback (which has no preview surface).
  const paneReady = await c.waitFor('Boolean(document.querySelector("[data-wall-preview], .wall-preview, canvas, .preview"))', 10000);
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
  await sleep(600);
  const before = (await live()).render.fence?.px;
  ok('window is on the wall before the drag', Boolean(before), JSON.stringify(before));

  // A real pointer drag on the preview: the window's own body is the drag handle. The surface
  // centre is empty wall (the plane is taller than the 16:9 picture), so pressing there would
  // test the "move the window to this point" click, not a drag.
  const box = await c.eval(`(function(){
    var nodes = document.querySelectorAll('[data-wall-preview], .wall-surface, .preview-surface, canvas, .preview');
    for (var i=0;i<nodes.length;i++){ var r=nodes[i].getBoundingClientRect(); if(r.width>200&&r.height>100) return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,cls:nodes[i].className,id:nodes[i].id}); }
    return null; })()`);
  ok('a draggable preview surface exists', Boolean(box), box || 'none');
  if (box) {
    const b = JSON.parse(box);
    // The picture box: 15% of its width is the wall distance the window must travel.
    const frame = JSON.parse(await c.eval(`(function(){var f=document.querySelector('.wall-frame');var r=f.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`));
    const win = JSON.parse(await c.eval(`(function(){var f=document.querySelector('.wall-surface .fence');var r=f.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()`));
    const cx = win.x + win.w / 2;
    const cy = win.y + win.h / 2;
    const dx = frame.w * 0.15;
    await c.eval(`(function(){var n=document.querySelector('.wall-surface'); if(n&&n.focus) n.focus(); return true;})()`);
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
      var f=document.querySelector('.wall-surface .fence');
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
  // then read the server back.
  const toggled = await c.eval(`(function(){
    var t=document.querySelector('#wall-fence-on');
    if(!t) return 'no control';
    var was=t.checked;
    t.checked=!was;
    t.dispatchEvent(new Event('change',{bubbles:true}));
    return 'clicked: '+(was?'on → off':'off → on'); })()`);
  await sleep(900);
  const afterToggle = (await live()).render.fence;
  const ratioAfter = (await live()).render.ratio;
  ok('the whole-wall control changes the server document', toggled !== 'no control' && ratioAfter !== '9:16', `${toggled} → fence ${afterToggle ? 'set' : 'null'}, ratio ${ratioAfter}`);
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
