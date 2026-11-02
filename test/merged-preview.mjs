// The show preview column: ONE 9:16 strip between the rail and the pane, on every route, alive.
//
// What this gate proves, in a real headless Chrome against a real server:
//   · the column is in the layout on all five routes, right of the rail and left of the pane
//   · there is exactly one surface (`.mx-surface`), it is 9:16, and no per-module preview survives
//   · its four layers are the show's stack: wall, hand fx, notifications, dialogs
//   · it is live: a raised alert reaches the surface over the event bus
//   · it is interactive against the live widget: a real press at the alert button's coordinates
//     closes that alert server-side, and a real drag PATCHes its position to /api/dialogs/live
//   · a press on empty strip space creates nothing — no alert may be born from the preview
//   · no console errors, no horizontal overflow at 1024 / 1280 / 1600
//
//   node test/merged-preview.mjs

import path from 'node:path';
import { launchChrome, startServer, CHROME } from './lib/chrome.mjs';
import { mountDiagnostics } from './lib/diagnostics.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
if (!CHROME) {
  console.error('merged-preview: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (base, p, body) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const getJson = (base, p) => fetch(`${base}${p}`).then((r) => r.json());

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws failed')));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method) {
      events.push(m);
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
    async json(expr, awaitPromise = false) {
      return JSON.parse((await this.eval(expr, awaitPromise)) || 'null');
    },
    async waitFor(expr, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          if (await this.eval(expr, true)) return true;
        } catch {
          /* navigating */
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

/* ------------------------------------------------------------------ the run */

const srv = await startServer({ root: ROOT, statePrefix: 'sb-merged-' });
const chrome = await launchChrome({ size: [1440, 900], profilePrefix: 'sb-chrome-merged-', extraArgs: ['--disable-gpu'] });
const c = connect(chrome.wsUrl);
const errors = [];
let exitCode = 0;

try {
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // one listener for the whole run: a Log error or an uncaught exception fails the last check
  const drain = () => {
    for (const m of c.events.splice(0)) {
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text || 'exception');
    }
  };

  /* ---------------------------------------------------------- 1. it exists, everywhere */

  const ROUTES = ['wall', 'handfx', 'dialogs', 'notifications', 'messages'];
  const placement = [];
  for (const route of ROUTES) {
    await c.send('Page.navigate', { url: `${srv.url}/#/${route}` });
    const up = await c.waitFor("Boolean(document.querySelector('#merged .mx-surface'))", 12000);
    if (!up) console.log(await mountDiagnostics(c, c.events, `${route} merged column`));
    const geo = await c.json(`JSON.stringify((function(){
      var m=document.getElementById('merged'), r=document.getElementById('rail'), p=document.getElementById('pane');
      if(!m||!r||!p) return null;
      var b=function(n){ var x=n.getBoundingClientRect(); return {l:Math.round(x.left), r:Math.round(x.right), w:Math.round(x.width)}; };
      return { merged:b(m), rail:b(r), pane:b(p),
               inApp: m.parentElement && m.parentElement.id==='app',
               order: [].map.call(m.parentElement.children, function(n){return n.id||n.className;}) };
    })())`);
    placement.push({ route, up, geo });
  }
  const allUp = placement.every((p) => p.up && p.geo && p.geo.merged.w >= 240);
  ok('the show preview is mounted on all five routes', allUp,
    placement.map((p) => `${p.route}:${p.up ? p.geo.merged.w : 'missing'}`).join(' '));
  const placed = placement.every((p) => p.geo && p.geo.rail.r <= p.geo.merged.l + 1 && p.geo.merged.r <= p.geo.pane.l + 1);
  ok('it sits between the rail and the pane', placed,
    placement[0]?.geo ? `rail ${placement[0].geo.rail.r} ≤ merged ${placement[0].geo.merged.l}, merged ${placement[0].geo.merged.r} ≤ pane ${placement[0].geo.pane.l}` : 'no geometry');

  /* ---------------------------------------------------------- 2. one surface */

  await c.send('Page.navigate', { url: `${srv.url}/#/wall` });
  await c.waitFor("Boolean(document.querySelector('.mx-surface'))", 12000);
  await sleep(400);
  const one = await c.json(`JSON.stringify((function(){
    var s=document.querySelectorAll('#merged .mx-surface');
    var r=s[0]?s[0].getBoundingClientRect():null;
    return {
      surfaces: s.length,
      slots: document.querySelectorAll('#merged .pv-slot').length,
      frames: document.querySelectorAll('#merged .pv-frame').length,
      layers: [].map.call(document.querySelectorAll('.mx-scene > *'), function(n){return n.className; }),
      ratio: r ? +(r.width/r.height).toFixed(4) : 0,
      scene: (function(){ var e=document.querySelector('.mx-scene'); return e ? {w:e.offsetWidth,h:e.offsetHeight,t:getComputedStyle(e).transform} : null; })(),
      wallRamp: document.querySelector('.mx-wall') ? getComputedStyle(document.querySelector('.mx-wall')).getPropertyValue('--pv-a').trim() : '',
      chips: [].map.call(document.querySelectorAll('#merged .mx-chip'), function(n){return n.dataset.chip;}),
    };
  })())`);
  ok('there is one surface and no separate per-module preview', one.surfaces === 1 && one.slots === 0 && one.frames === 0,
    `${one.surfaces} .mx-surface, ${one.slots} .pv-slot, ${one.frames} .pv-frame`);
  ok('the surface is the 9:16 strip', Math.abs(one.ratio - 0.5625) < 0.01 && one.scene && one.scene.w === 405 && one.scene.h === 720,
    `ratio ${one.ratio}, scene ${one.scene?.w}×${one.scene?.h}, scale ${one.scene?.t}`);
  ok('the layers are the show stack, wall first and dialogs last',
    one.layers.length === 4 && /mx-wall/.test(one.layers[0]) && /mx-dialogs/.test(one.layers[3]),
    one.layers.join(' | '));
  ok('the wall layer is painted from the shared look', Boolean(one.wallRamp), `--pv-a ${one.wallRamp}`);
  ok('the header names all four modules', one.chips.join(',') === 'wall,handfx,dialogs,notifications', one.chips.join(','));

  /* ---------------------------------------------------------- 3. it is live */

  await post(srv.url, '/api/dialogs/live', {
    spec: { type: 'Error', title: 'merged preview check', text: 'a dialog in the strip', autoCloseMs: 0, buttons: [{ label: 'Retry', action: 'none' }, { label: 'OK', action: 'close' }] },
  });
  const arrived = await c.waitFor("document.querySelector('.mx-dialogs').shadowRoot.querySelectorAll('.dialog.in').length >= 1", 5000);
  const alert = await c.json(`JSON.stringify((function(){
    var h=document.querySelector('.mx-dialogs').shadowRoot;
    var d=h.querySelector('.dialog.in');
    var b=d?d.querySelector('.btn.primary'):null;
    var q=b?b.getBoundingClientRect():null;
    return { dialogs: h.querySelectorAll('.dialog').length, skin: h.querySelector('.desk').className,
             title: d?d.querySelector('.ttitle').textContent:null, text: d?d.querySelector('.msg').textContent:null,
             btn: q?{x:Math.round(q.x+q.width/2),y:Math.round(q.y+q.height/2)}:null,
             rows: [].map.call(document.querySelectorAll('#merged .mx-chip'), function(n){return n.dataset.chip+'='+(n.querySelector('.mx-chip-state').textContent||'');}) };
  })())`);
  ok('a raised alert reaches the surface', arrived && alert.dialogs >= 1 && /skin-/.test(alert.skin || ''),
    `${alert.dialogs} dialog(s), ${alert.skin}, "${alert.title}"`);
  const chipState = alert.rows.find((r) => r.startsWith('dialogs=')) || '';
  ok('the dialogs chip reports the live count', /up/.test(chipState) && !/=0/.test(chipState), chipState);

  /* ---------------------------------------------------------- 4. press the live control */

  const liveBefore = await getJson(srv.url, '/api/dialogs/live');
  const liveBeforeN = liveBefore.live.length;
  ok('the alert is up before the press', liveBeforeN === 1, `${liveBeforeN} live`);

  const mouse = (type, x, y, extra = {}) =>
    c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  await mouse('mouseMoved', alert.btn.x, alert.btn.y, { buttons: 0, clickCount: 0 });
  await mouse('mousePressed', alert.btn.x, alert.btn.y);
  await sleep(40);
  await mouse('mouseReleased', alert.btn.x, alert.btn.y);
  await sleep(600);
  const liveAfter = await getJson(srv.url, '/api/dialogs/live');
  ok('a press on the alert’s button acts on the alert, not the preview', liveAfter.live.length === liveBeforeN - 1,
    `live ${liveBeforeN} → ${liveAfter.live.length} after clicking (${alert.btn.x},${alert.btn.y})`);

  /* ---------------------------------------------------------- 5. drag it, and keep the position */

  await post(srv.url, '/api/dialogs/live', {
    spec: { type: 'Alert', title: 'drag me', text: 'position is state', autoCloseMs: 0 },
  });
  await c.waitFor("document.querySelector('.mx-dialogs').shadowRoot.querySelectorAll('.dialog.in').length >= 1", 5000);
  await sleep(250);
  const d0 = await c.json(`JSON.stringify((function(){
    var d=document.querySelector('.mx-dialogs').shadowRoot.querySelector('.dialog.in');
    var r=d.getBoundingClientRect();
    return { x:Math.round(r.x+40), y:Math.round(r.y+10), id:d.dataset.id };
  })())`);
  const beforeDrag = await getJson(srv.url, '/api/dialogs/live');
  await mouse('mouseMoved', d0.x, d0.y, { buttons: 0, clickCount: 0 });
  await mouse('mousePressed', d0.x, d0.y);
  for (let i = 1; i <= 5; i++) {
    await mouse('mouseMoved', d0.x + 6 * i, d0.y + 8 * i, { clickCount: 0 });
    await sleep(30);
  }
  await mouse('mouseReleased', d0.x + 30, d0.y + 40);
  await sleep(600);
  const afterDrag = await getJson(srv.url, '/api/dialogs/live');
  const pick = (list, id) => list.live.find((d) => d.id === id) || {};
  const from = pick(beforeDrag, d0.id);
  const to = pick(afterDrag, d0.id);
  ok('a drag writes the alert’s position to its own state',
    to.x > from.x && to.y > from.y,
    `${d0.id} ${from.x},${from.y} → ${to.x},${to.y}`);

  /* ---------------------------------------------------------- 6. a press must never spawn */

  const nBefore = afterDrag.live.length;
  const empty = await c.json(`JSON.stringify((function(){
    var s=document.querySelector('.mx-surface').getBoundingClientRect();
    return { x: Math.round(s.x+10), y: Math.round(s.bottom-10) };
  })())`);
  await mouse('mouseMoved', empty.x, empty.y, { buttons: 0, clickCount: 0 });
  await mouse('mousePressed', empty.x, empty.y);
  await sleep(40);
  await mouse('mouseReleased', empty.x, empty.y);
  await sleep(800);
  const nAfter = (await getJson(srv.url, '/api/dialogs/live')).live.length;
  ok('a press on empty strip space creates nothing', nAfter === nBefore, `live ${nBefore} → ${nAfter}`);

  /* ---------------------------------------------------------- 7. no overflow, no errors */

  const overflow = [];
  for (const w of [1024, 1280, 1600]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const over = await c.eval('document.documentElement.scrollWidth > window.innerWidth + 1');
    const surface = await c.json(`JSON.stringify((function(){
      var r=document.querySelector('.mx-surface').getBoundingClientRect();
      var col=document.getElementById('merged').getBoundingClientRect();
      return { inside: r.left >= col.left - 1 && r.right <= col.right + 1, ratio: +(r.width/r.height).toFixed(3) };
    })())`);
    overflow.push({ w, over, ...surface });
  }
  ok('no horizontal overflow, and the strip stays inside its column', overflow.every((o) => !o.over && o.inside),
    overflow.map((o) => `${o.w}:${o.over ? 'overflow' : 'ok'} ratio ${o.ratio}`).join(' '));

  drain();
  ok('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (err) {
  console.error('merged-preview gate threw:', err.stack || err.message);
  exitCode = 1;
} finally {
  c.close();
  chrome.stop();
  srv.stop();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) exitCode = 1;
process.exit(exitCode);
