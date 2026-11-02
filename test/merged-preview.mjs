// The merged preview column: present on every route, between the rail and the pane, alive.
//
// What this gate proves, in a real headless Chrome against a real server:
//   · the column is in the layout on all five routes, right of the rail and left of the pane
//   · four slots, each the shared component (a .pv-frame under each .pv-slot), each carrying its
//     own module's look
//   · the border drags, and the width survives a reload
//   · it is live: the wall palette changed from the wall's own pane shows up in the wall slot
//   · it is interactive: clicking a slot selects it, and its controls send the command its own
//     pane sends — checked against the module's API state, not against the DOM
//   · no console errors, no horizontal overflow at 1024 / 1280 / 1600
//
//   node test/merged-preview.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, CHROME } from './lib/chrome.mjs';
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
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

async function startServer() {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-merged-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stateDir, stop: () => child.kill('SIGTERM') };
    } catch {
      /* starting */
    }
  }
  child.kill('SIGTERM');
  throw new Error('server did not start');
}

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

const post = (base, p, body) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

/* ---------------------------------------------------------- 0. the shared store */

// One look per module is the whole point of the store: a change one view makes is the change every
// view reads. It is proved here in a real browser with no module pane open — the column alone,
// mounted through the same `mountMergedColumn` the shell uses — so the check cannot pass on two DOM
// nodes happening to agree, and it does not depend on a pane that happens to be on screen.
const storeSrv = await startServer();
let storeChrome = null;
try {
  storeChrome = await launchChrome({ size: [1440, 900], profilePrefix: 'sb-chrome-store-', extraArgs: ['--disable-gpu'] });
  const sc = connect(storeChrome.wsUrl);
  await sc.ready;
  await sc.send('Page.enable');
  await sc.send('Runtime.enable');
  await sc.send('Page.navigate', { url: `${storeSrv.url}/#/messages` });
  // the column exists on any route, but `__merged` is the shell's handle on it: wait for the shell
  await sc.waitFor("Boolean(window.__merged && window.__shell && window.__shell.ready)", 15000);
  const st = JSON.parse(await sc.eval(`(async function(){
    var mod = await import('/src/merged-preview.js');
    var s = mod.lookStore;
    // the module's own data path, no column instance and no DOM needed: exactly what a pane that
    // adopts the store would do before its first paint
    await mod.loadLook('wall');
    s.set('dialogs', { theme: s.get('dialogs').theme });
    var wall = s.get('wall');
    var seen = [];
    var off = s.subscribe(function(id, look){ seen.push({ id: id, theme: look.theme }); });
    s.set('dialogs', { theme: 'win95' });
    off();
    // the second write is what a stale reader would still see, so keep it out of the returned copy
    var atWriteTime = s.get('dialogs');
    s.set('dialogs', { theme: 'macos' });
    return JSON.stringify({ wall: wall, seen: seen, dialogs: atWriteTime, themeNow: s.get('dialogs').theme });
  })()`, true));
  ok('the shared look store fills from the server on its own', Boolean(st && st.wall && st.wall.pattern),
    `wall look: palette ${st && st.wall && st.wall.palette}, pattern ${st && st.wall && st.wall.pattern}`);
  ok('a look change is published once, to every subscriber',
    Boolean(st) && st.seen.length === 1 && st.seen[0].id === 'dialogs' && st.seen[0].theme === 'win95',
    `${st ? st.seen.length : '?'} notification(s): ${(st ? st.seen : []).map((x) => `${x.id}=${x.theme}`).join(', ')}`);
  ok('a reader gets the merged look, not a stale module-local copy', Boolean(st) && st.dialogs.theme === 'win95',
    `dialogs look: theme ${st && st.dialogs.theme}`);
  sc.close();
} finally {
  storeChrome && storeChrome.stop?.();
  storeSrv.stop();
}

const srv = await startServer();
const chrome = await launchChrome({ size: [1440, 900], profilePrefix: 'sb-chrome-merged-', extraArgs: ['--disable-gpu'] });
const c = connect(chrome.wsUrl);
let exitCode = 0;

try {
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  /* ---------------------------------------------------------- 1. it exists, everywhere */

  const ROUTES = ['wall', 'handfx', 'dialogs', 'notifications', 'messages'];
  const placement = [];
  for (const route of ROUTES) {
    await c.send('Page.navigate', { url: `${srv.url}/#/${route}` });
    const up = await c.waitFor("Boolean(document.querySelector('#merged .pv-slot .pv-frame'))", 12000);
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
  ok('the merged column is mounted on all five routes', allUp,
    placement.map((p) => `${p.route}:${p.up ? `${p.geo.merged.w}px` : 'missing'}`).join(' '));
  const ordered = placement.every((p) => p.geo && p.geo.rail.r <= p.geo.merged.l && p.geo.merged.r <= p.geo.pane.l);
  ok('it sits right of the rail and left of the module pane',
    ordered,
    placement.map((p) => (p.geo ? `${p.route}: rail→${p.geo.rail.r} col ${p.geo.merged.l}–${p.geo.merged.r} pane→${p.geo.pane.l}` : `${p.route}: no column`)).join(' | '));
  const inGrid = placement.every((p) => p.geo && p.geo.inApp);
  ok('it is a child of the app grid (not a floating overlay)', inGrid, inGrid ? '' : 'not a child of #app');

  /* ---------------------------------------------------------- 2. four slots, the real component */

  await c.send('Page.navigate', { url: `${srv.url}/#/wall` });
  await c.waitFor("Boolean(document.querySelector('#merged .pv-slot .pv-frame'))", 12000);
  const slots = await c.json(`JSON.stringify((function(){
    var cards=[].slice.call(document.querySelectorAll('#merged .pv-slot'));
    return { count: cards.length,
      frames: document.querySelectorAll('#merged .pv-slot .pv-frame').length,
      modules: cards.map(function(n){return n.dataset.module;}),
      looks: cards.map(function(n){ var l=n.querySelector('.pv-look'); return l ? getComputedStyle(l).getPropertyValue('--pv-a').trim() : null; }),
      shapes: cards.map(function(n){ var s=n.querySelector('.pv-stage'); return s ? s.dataset.shape : null; }),
      kinds: cards.map(function(n){ return n.querySelector('.pv-window') ? 'window' : 'none'; }),
      chips: document.querySelectorAll('#merged .pv-chips .pv-chip').length };
  })())`);
  ok('the column holds four slots, each a .pv-frame from the shared component',
    slots.count === 4 && slots.frames === 4,
    `${slots.count} slots / ${slots.frames} frames`);
  ok('each slot is its own module', ['wall', 'handfx', 'dialogs', 'notifications'].every((id) => slots.modules.includes(id)),
    slots.modules.join(', '));
  ok('one chip per module above the slots', slots.chips === 4, `${slots.chips} chips`);

  /* ---------------------------------------------------------- 3. it is live */

  // A fresh state dir has no pool messages, so "spawn a random alert" has nothing to draw and the
  // module answers 409. Seed one alert and one notification so the slot's own controls have
  // something to send: a real operator's pool is never empty, and this is the same route their
  // messages come from.
  const seeded = await fetch(`${srv.url}/api/pool/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { kind: 'dialog', title: 'Merged preview', text: 'an alert the column may spawn', random: true },
        { kind: 'notification', title: 'Merged preview', text: 'a toast the column may send', random: true },
      ],
    }),
  }).then((r) => r.json());
  ok('the pool has a message for each overlay to send', seeded && seeded.ok && seeded.count >= 2,
    `${seeded && seeded.count} message(s)`);


  // The wall's palette is a page command, so the honest place to change it is the wall's own pane.
  // The pane is on the wall route and its Palette control is the same `look.palette` command; the
  // column must follow it, and the read is the palette the slot stamps — the ramp the component is
  // actually painting with, not a label.
  await c.send('Page.navigate', { url: `${srv.url}/#/wall` });
  await c.waitFor("Boolean(document.querySelector('#wall-look-palette') && document.querySelector('#merged .pv-slot .pv-frame'))", 12000);
  const palettePick = await c.eval(`(function(){
    var s=document.querySelector('#wall-look-palette');
    if(!s) return 'no pane control';
    var before=s.value;
    var next=[].slice.call(s.options).map(function(o){return o.value;}).filter(Boolean).find(function(v){return v!==before;});
    s.value=next;
    s.dispatchEvent(new Event('change',{bubbles:true}));
    return next;
  })()`);
  const wallAfter = await (async () => {
    for (let i = 0; i < 25; i++) {
      const v = await c.json(`JSON.stringify({pal: document.querySelector('#merged .pv-slot[data-module="wall"]').dataset.palette,
        col: getComputedStyle(document.querySelector('#merged .pv-slot[data-module="wall"] .pv-look')).getPropertyValue('--pv-a').trim()})`);
      if (v.pal) return v;
      await sleep(200);
    }
    return {};
  })();
  const wallBefore = { col: '#00f5d4' }; // the engine's default ramp (neonwave), the wall's opening look
  ok('the wall slot follows a palette change made on the wall pane',
    Boolean(palettePick) && wallAfter.col !== wallBefore.col && wallAfter.pal && wallAfter.pal !== 'neonwave',
    `${palettePick}: slot ramp ${wallBefore.col} → ${wallAfter.col} (palette ${wallAfter.pal})`);

  // Overlays: a dialog spawned from its own pane lands in the dialogs slot's layer.
  await post(srv.url, '/api/dialogs/live', { text: 'merged preview check' });
  await sleep(1500);
  const dlg = await c.json(`JSON.stringify((function(){
    var s=document.querySelector('#merged .pv-slot[data-module="dialogs"]');
    var d=s.querySelector('.pv-layer-in .dg-desk');
    return { desk:!!d, cls: d?d.className:null, dialogs: d?d.querySelectorAll('.dialog').length:0,
             state:s.querySelector('.mp-state').textContent };
  })())`);
  ok('the dialogs slot draws the live dialogs',
    dlg.desk && dlg.dialogs >= 1 && /skin-/.test(dlg.cls || ''),
    `${dlg.dialogs} dialog(s) in ${dlg.cls}, state "${dlg.state}"`);

  await post(srv.url, '/api/notifications/live', { text: 'merged preview check' });
  await sleep(1500);
  const ntf = await c.json(`JSON.stringify((function(){
    var s=document.querySelector('#merged .pv-slot[data-module="notifications"]');
    var n=s.querySelector('.pv-layer-in .nt-layer');
    return { layer:!!n, cls: n?n.className:null, toasts: n?n.querySelectorAll('.toast').length:0 };
  })())`);
  ok('the notifications slot draws the live toasts with the module look class',
    ntf.layer && ntf.toasts >= 1 && /\bt-ios\b/.test(ntf.cls || ''),
    `${ntf.toasts} toast(s) in ${ntf.cls}`);

  /* ---------------------------------------------------------- 4. it is interactive */

  // Clicking a card selects it: its chip presses and its controls appear. Then a control must send
  // the module's own command — proved from the API, not from the button's own text.
  const before = await fetch(`${srv.url}/api/dialogs/live`).then((r) => r.json());
  const rect = await c.json(`JSON.stringify((function(){var n=document.querySelector('#merged .pv-slot[data-module="dialogs"] .mp-label');var b=n.getBoundingClientRect();return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})())`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(300);
  const sel = await c.json(`JSON.stringify((function(){
    var s=document.querySelector('#merged .pv-slot[data-module="dialogs"]');
    return { selected: s.dataset.selected, current: s.getAttribute('aria-current'),
             chip: document.querySelector('#merged .pv-chip[data-chip="dialogs"]').getAttribute('aria-pressed'),
             controls: [].filter.call(s.querySelectorAll('.mp-c'), function(b){ return b.offsetParent !== null; }).map(function(b){return b.dataset.act;}) };
  })())`);
  ok('clicking a slot selects it and reveals its controls',
    sel.selected === 'true' && sel.chip === 'true' && sel.controls.includes('send'),
    `selected:${sel.selected} chip:${sel.chip} controls:${sel.controls.join(',')}`);

  const sendRect = await c.json(`JSON.stringify((function(){var b=document.querySelector('#merged .pv-slot[data-module="dialogs"] .mp-c[data-act="send"]');var r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})())`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sendRect.x, y: sendRect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sendRect.x, y: sendRect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  let after = before;
  for (let i = 0; i < 20 && after.count === before.count; i++) {
    await sleep(200);
    after = await fetch(`${srv.url}/api/dialogs/live`).then((r) => r.json());
  }
  ok('a command from a slot reaches its module', after.count > before.count,
    `dialogs ${before.count} → ${after.count}`);

  // Clearing from the slot is the other half: the module's own DELETE.
  const clearRect = await c.json(`JSON.stringify((function(){var b=document.querySelector('#merged .pv-slot[data-module="dialogs"] .mp-c[data-act="clear"]');var r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})())`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clearRect.x, y: clearRect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clearRect.x, y: clearRect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  let cleared = after;
  for (let i = 0; i < 20 && cleared.count > 0; i++) {
    await sleep(200);
    cleared = await fetch(`${srv.url}/api/dialogs/live`).then((r) => r.json());
  }
  ok('clearing from the slot empties the module', cleared.count === 0, `dialogs ${after.count} → ${cleared.count}`);

  /* ---------------------------------------------------------- 5. the border drags and persists */

  // The viewport is the widest the column is ever allowed to be, so drag a width the stored value
  // cannot keep at 1024 and watch the ceiling do its job: the pane's floor wins over the operator's
  // preference, and the reload restores the preference, not the clamp.
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const beforeDrag = await c.json(`JSON.stringify({w:Math.round(document.getElementById('merged').getBoundingClientRect().width)})`);
  const handle = await c.json(`JSON.stringify((function(){var r=document.querySelector('#merged .merged-resize').getBoundingClientRect();return {x:Math.round(r.x+r.width/2), y:400};})())`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 6; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + i * 12, y: handle.y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(30);
  }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 72, y: handle.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(400);
  const afterDrag = await c.json(`JSON.stringify({w:Math.round(document.getElementById('merged').getBoundingClientRect().width), stored: localStorage.getItem('shockbox.merged.width')})`);
  ok('dragging the border resizes the column', afterDrag.w > beforeDrag.w + 40,
    `${beforeDrag.w}px → ${afterDrag.w}px (stored ${afterDrag.stored})`);

  await c.send('Page.reload', {});
  await c.waitFor("Boolean(document.querySelector('#merged .pv-slot .pv-frame'))", 12000);
  await sleep(600);
  const afterReload = await c.json(`JSON.stringify({w:Math.round(document.getElementById('merged').getBoundingClientRect().width)})`);
  ok('the width survives a reload', Math.abs(afterReload.w - afterDrag.w) <= 2,
    `${afterDrag.w}px → ${afterReload.w}px`);

  // the operator asked for a wide column; at 1024 the pane's floor wins and the column is clamped
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const clamped = await c.json(`JSON.stringify({w:Math.round(document.getElementById('merged').getBoundingClientRect().width), pane:Math.round(document.getElementById('pane').getBoundingClientRect().width)})`);
  ok('a wide column is clamped at 1024 so the pane keeps its width',
    clamped.w < afterReload.w && clamped.pane >= 500,
    `stored ${afterReload.w}px → ${clamped.w}px at 1024, pane ${clamped.pane}px`);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  /* ---------------------------------------------------------- 6. no overflow, anywhere */

  const sizes = [1024, 1280, 1600];
  const overflow = [];
  for (const w of sizes) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const m = await c.json(`JSON.stringify({ sw: document.documentElement.scrollWidth, iw: window.innerWidth,
      body: document.body.scrollWidth,
      col: Math.round(document.getElementById('merged').getBoundingClientRect().width),
      pane: Math.round(document.getElementById('pane').getBoundingClientRect().width) })`);
    overflow.push({ w, ...m });
  }
  const fits = overflow.every((o) => o.sw <= o.iw + 1 && o.body <= o.iw + 1);
  ok('no horizontal overflow at 1024 / 1280 / 1600', fits,
    overflow.map((o) => `${o.w}: scroll ${o.sw}/${o.iw} col ${o.col} pane ${o.pane}`).join(' | '));
  // the column must give way to the pane, not the other way round: 520px is what a module pane's
  // own two-column layout needs, and the column's ceiling is computed to leave it
  const panesHold = overflow.every((o) => o.pane >= 500);
  ok('the pane keeps a usable width beside the column at every size', panesHold,
    overflow.map((o) => `${o.w}: pane ${o.pane}px`).join(' | '));

  /* ---------------------------------------------------------- 7. console */

  const errors = c.events
    .filter((e) => (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') || e.method === 'Runtime.exceptionThrown')
    .map((e) => (e.method === 'Runtime.exceptionThrown'
      ? e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text
      : e.params.args.map((a) => a.value || a.description).join(' ')))
    // a route with no module behind it is the shell's own 404 note, not a column failure
    .filter((t) => t && !/No module at this address/.test(t));
  ok('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  c.close();
  chrome.stop?.();
  srv.stop();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
if (failed.length) exitCode = 1;
process.exit(exitCode);
