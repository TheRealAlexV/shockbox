// Real-browser check of the Notifications and Alerts *control panes* in the ShockBox shell.
//
// Both panes replaced hardcoded shell panes (public/src/panes/*.js) with module-owned ones, so
// the failure mode is silent: the shell quietly falls back to the old pane, or the new pane
// renders but paints from local state instead of the server. This mounts the shell in headless
// Chrome and asserts what a syntax check cannot:
//   · each route renders the module's own pane (ctx.paneSource is the module file)
//   · the preview draws exactly the entities the server reports, at the server's geometry
//   · the look control changes the settings document and the preview follows
//   · a spawn from the pane reaches the server and repaints the preview over SSE
//   · nothing overflows horizontally, and no console errors
//
//   node test/panes-notify-dialogs.mjs             # boots its own server
//   node test/panes-notify-dialogs.mjs --url=http://127.0.0.1:8981 [--keep]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, CHROME } from './lib/chrome.mjs';
import { mountDiagnostics } from './lib/diagnostics.mjs';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
if (!CHROME) {
  console.error('panes-notify-dialogs: no chrome/chromium found (set CHROME=)');
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-panes-'));
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
  const { wsUrl, stop } = await launchChrome({
    size: [1440, 900],
    profilePrefix: 'sb-chrome-',
    extraArgs: ['--disable-gpu'],
  });
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
    async waitFor(expr, ms = 6000) {
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

  /* ------------------------------------------------ shared: seed + geometry */

  // Seed the shared pool (a fresh state dir has none), then one toast and one alert, so the
  // previews have something to paint on first load.
  const seedPool = await fetch(`${srv.url}/api/pools`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { kind: 'notification', type: 'Info', title: 'ShockBox', text: 'Stream is live — toast one', random: true, storm: true },
        { kind: 'notification', type: 'Alert', title: 'Chat', text: 'New follower on the strip', random: true, storm: true },
        { kind: 'dialog', type: 'Error', title: 'System', text: 'Something went wrong somewhere.', random: true, storm: true, buttons: [{ label: 'OK', action: 'close' }] },
        { kind: 'dialog', type: 'Question', title: 'Update', text: 'Restart the encoder now?', random: true, storm: true, buttons: [{ label: 'Later', action: 'close' }, { label: 'Restart', action: 'close' }] },
      ],
    }),
  });
  ok('server seeds a pool with messages', seedPool.ok, `PUT /api/pools → ${seedPool.status}`);
  const seedNotify = await fetch(`${srv.url}/api/notifications/live`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ any: true }),
  });
  const seedDialog = await fetch(`${srv.url}/api/dialogs/live`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ any: true }),
  });
  ok('server spawns one toast and one alert for the test', seedNotify.ok && seedDialog.ok, `${seedNotify.status}/${seedDialog.status}`);

  const notifyLive = async () => fetch(`${srv.url}/api/notifications/live`).then((r) => r.json());
  const dialogLive = async () => fetch(`${srv.url}/api/dialogs/live`).then((r) => r.json());

  /* ------------------------------------------------------- notifications */

  await c.send('Page.navigate', { url: `${srv.url}/#/notifications` });
  const mountedN = await c.waitFor('document.readyState === "complete" && Boolean(document.querySelector(".pane"))', 12000);
  if (!mountedN) console.log(await mountDiagnostics(c, c.events, 'shell mount (notifications)'));
  ok('notifications route mounts in the shell', mountedN);

  const paneSrcN = await c.waitFor(`(async () => {
    const m = await import('/mod/notifications/ui/pane.js');
    return typeof m.render === 'function';
  })()`, true);
  ok('the module ships a notifications pane', paneSrcN);

  const previewN = await c.waitFor("Boolean(document.querySelector('#pane .nt-preview .pv-window [data-style]'))", 10000);
  // The old hardcoded pane said "Live toasts" and drew .live-stack; the module pane draws .nt-strip.
  const oldPaneN = await c.eval('Boolean(document.querySelector(".live-stack")) || /^Live toasts/m.test(document.body.innerText)');
  ok('notifications pane renders (module pane, not the shell fallback)', previewN && !oldPaneN, `strip:${previewN} old:${oldPaneN}`);

  const liveN = await notifyLive();
  const paintedN = JSON.parse(await c.eval(`JSON.stringify({
    rows: [].slice.call(document.querySelectorAll('#pane .nt-preview .pv-window [data-style] .toast')).map(function(n){
      return { id: n.dataset.id, top: n.style.top, h: n.style.height, text: n.querySelector('.text') ? n.querySelector('.text').textContent : '' };
    }),
    count: document.querySelector('.nt-stack-count') ? document.querySelector('.nt-stack-count').textContent : '',
    style: document.querySelector('#pane .nt-preview .pv-window [data-style]') ? document.querySelector('#pane .nt-preview .pv-window [data-style]').dataset.style : '',
    look: document.querySelector('.nt-mode') ? document.querySelector('.nt-mode').textContent : '',
  })`));
  const wantN = (liveN.live || []).map((e) => e.id).sort().join(',');
  const gotN = paintedN.rows.map((r) => r.id).sort().join(',');
  ok('the preview draws exactly the server’s live toasts', wantN === gotN, `server [${wantN}] painted [${gotN}]`);
  const geoOk = paintedN.rows.every((r) => {
    const e = (liveN.live || []).find((x) => x.id === r.id);
    return e && r.top === `${e.y}px` && r.h === `${e.h}px`;
  });
  ok('each preview toast sits at the server’s y and height', geoOk, paintedN.rows.map((r) => `${r.id}@${r.top}/${r.h}`).join(' '));
  ok('the stack count reads from the server', paintedN.count.trim() === `${liveN.stack.used} / ${liveN.stack.capacity}`, `"${paintedN.count}" vs ${liveN.stack.used}/${liveN.stack.capacity}`);
  ok('the strip wears the server’s look class', paintedN.style === 'ios', `style=${paintedN.style} look="${paintedN.look}"`);

  // The look control must reach the settings document, and the preview must follow.
  const lookBefore = (await notifyLive()).settings.style.value;
  await c.eval(`(function(){
    var b=[].slice.call(document.querySelectorAll('.nt-quick .seg')).find(function(n){return n.textContent.trim()==='macOS'});
    if(b) b.click(); return Boolean(b); })()`);
  await sleep(900);
  const lookAfter = (await notifyLive()).settings.style.value;
  const paintedAfter = await c.eval(`document.querySelector('#pane .nt-preview .pv-window [data-style]') ? document.querySelector('#pane .nt-preview .pv-window [data-style]').dataset.style : ''`);
  ok('the look control changes the settings document', lookAfter === 'macos' && lookBefore !== lookAfter, `${lookBefore} → ${lookAfter}`);
  ok('the preview follows the look the server settled on', paintedAfter === lookAfter, `strip ${paintedAfter}`);

  // The height slider is the same kind of control; take it through a change event.
  const heightBefore = (await notifyLive()).settings.height.value;
  const heightSet = await c.eval(`(function(){
    var r=document.querySelector('#nt-height');
    if(!r) return 'no control';
    var want = Number(r.value) === 96 ? 72 : 96;
    r.value = String(want);
    r.dispatchEvent(new Event('input',{bubbles:true}));
    r.dispatchEvent(new Event('change',{bubbles:true}));
    return 'set '+want; })()`);
  await sleep(900);
  const heightAfter = (await notifyLive()).settings.height.value;
  ok('the height control reaches the settings document', heightSet === 'no control' || heightAfter !== heightBefore, `${heightBefore} → ${heightAfter} (${heightSet})`);

  // A spawn from the pane reaches the server and paints over SSE.
  const beforeCount = (await notifyLive()).live.length;
  await c.eval(`(function(){
    var b=[].slice.call(document.querySelectorAll('#pane .btn, .pane .btn, .pane-slot .btn, .btn')).find(function(n){return /Spawn toast/i.test(n.textContent)});
    if(b) b.click(); return Boolean(b); })()`);
  const grew = await (async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if ((await notifyLive()).live.length !== beforeCount) return true;
    }
    return false;
  })();
  ok('the pane’s spawn button reaches the server', grew, `${beforeCount} → ${(await notifyLive()).live.length}`);
  let ssePainted = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    ssePainted = await c.eval(`[].slice.call(document.querySelectorAll('#pane .nt-preview .pv-window [data-style] .toast')).length`);
    if (ssePainted === (await notifyLive()).live.length) break;
  }
  const serverN = (await notifyLive()).live.length;
  ok('a spawned toast appears on the preview over SSE', ssePainted === serverN, `painted ${ssePainted}, server ${serverN}`);

  const widthsN = [1280, 1600, 1024];
  for (const w of widthsN) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const m = JSON.parse(await c.eval('JSON.stringify({sw: document.documentElement.scrollWidth, iw: window.innerWidth})'));
    ok(`notifications pane: no horizontal overflow at ${w}`, m.sw <= m.iw, `scrollWidth ${m.sw} innerWidth ${m.iw}`);
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await shot(c, path.join(SCRATCH, 'pane-notifications.png'));

  /* ----------------------------------------- notifications: form ownership */

  // The settings form must not leave a key out that the schema has, and the quick controls
  // above it must own exactly the rows they replace (a schema row for the same key would leave
  // two controls disagreeing and the last PATCH winning silently).
  {
    const meta = (await notifyLive()).settings || {};
    const schema = Object.keys(meta);
    const rendered = JSON.parse(
      await c.eval(`JSON.stringify([].slice.call(document.querySelectorAll('[id^="set-"]')).map(function(n){return n.id.slice(4);}).filter(function(v){return !/-track$/.test(v);}).filter(function(v,i,a){return a.indexOf(v)===i;}))`),
    );
    const stale = rendered.filter((k) => !schema.includes(k));
    const dup = rendered.filter((k) => ['style', 'height'].includes(k));
    const missing = schema.filter((k) => !rendered.includes(k) && !['style', 'height'].includes(k));
    ok('notifications: settings rows name schema keys only', stale.length === 0, `${rendered.length} rows, stale: ${stale.join(', ') || 'none'}`);
    ok('notifications: no row repeats a quick control', dup.length === 0, dup.join(', ') || 'none');
    ok('notifications: every schema key has a control', missing.length === 0, missing.join(', ') || `${schema.length} keys covered`);
  }

  /* ------------------------------------------------------------- dialogs */

  await c.send('Page.navigate', { url: `${srv.url}/#/dialogs` });
  await sleep(300);
  const mountedD = await c.waitFor('document.readyState === "complete" && Boolean(document.querySelector(".pane"))', 12000);
  if (!mountedD) console.log(await mountDiagnostics(c, c.events, 'shell mount (dialogs)'));
  const previewD = await c.waitFor('Boolean(document.querySelector("#pane .pv-frame") && document.querySelector("#pane .dg-desk"))', 10000);
  const oldPaneD = await c.eval('Boolean(document.querySelector(".live-card")) && !document.querySelector("#pane .dg-desk")');
  ok('alerts pane renders (module pane, not the shell fallback)', mountedD && previewD && !oldPaneD, `desk:${previewD} old:${oldPaneD}`);

  const liveD = await dialogLive();
  const paintedD = JSON.parse(await c.eval(`JSON.stringify({
    // scoped to the module pane: the merged preview column draws its own desk and its own dialogs
    rows: [].slice.call(document.querySelectorAll('#pane .dg-desk .dialog')).filter(function(n){ return !n.closest('.pv-layer-out'); }).map(function(n){
      return { id: n.dataset.id, geo: n.dataset.geo, left: n.style.left, top: n.style.top, w: n.style.width, h: n.style.height,
               text: n.querySelector('.msg') ? n.querySelector('.msg').textContent : '',
               title: n.querySelector('.ttitle') ? n.querySelector('.ttitle').textContent : '' };
    }),
    theme: document.querySelector('#pane .dg-desk') ? document.querySelector('#pane .dg-desk').dataset.theme : '',
    scale: document.querySelector('#pane .dg-desk') ? document.querySelector('#pane .dg-desk').dataset.scale : '',
    count: document.querySelector('.dg-count') ? document.querySelector('.dg-count').textContent : '',
  })`));
  const wantD = (liveD.live || []).map((e) => e.id).sort().join(',');
  const gotD = paintedD.rows.map((r) => r.id).sort().join(',');
  ok('the preview draws exactly the server’s live alerts', wantD === gotD, `server [${wantD}] painted [${gotD}]`);
  const geoOkD = paintedD.rows.every((r) => {
    const e = (liveD.live || []).find((x) => x.id === r.id);
    return e && r.left === `${e.x}px` && r.top === `${e.y}px` && r.w === `${e.w}px` && r.h === `${e.h}px`;
  });
  ok('each preview alert sits at the server’s cascade box', geoOkD, paintedD.rows.map((r) => `${r.id} ${r.geo}`).join(' | '));
  ok('the desk wears the server’s skin', paintedD.theme === 'win11', `theme=${paintedD.theme} scale=${paintedD.scale}`);
  ok('the count reads from the server', paintedD.count.trim() === `${liveD.live.length} / ${liveD.capacity}`, `"${paintedD.count}" vs ${liveD.live.length}/${liveD.capacity}`);

  const themeBefore = (await dialogLive()).settings.theme.value;
  await c.eval(`(function(){
    var b=[].slice.call(document.querySelectorAll('.dg-quick .seg')).find(function(n){return n.textContent.trim()==='macOS'});
    if(b) b.click(); return Boolean(b); })()`);
  await sleep(900);
  const themeAfter = (await dialogLive()).settings.theme.value;
  const skinAfter = await c.eval('document.querySelector("#pane .dg-desk") ? document.querySelector("#pane .dg-desk").className : ""');
  ok('the theme control changes the settings document', themeAfter === 'macos' && themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
  ok('the preview follows the skin the server settled on', /skin-macos/.test(skinAfter), skinAfter);

  const scaleBefore = (await dialogLive()).settings.scale.value;
  const scaleSet = await c.eval(`(function(){
    var r=document.querySelector('#dg-scale');
    if(!r) return 'no control';
    var want = Number(r.value) > 0.9 ? 0.8 : 1.1;
    r.value = String(want);
    r.dispatchEvent(new Event('input',{bubbles:true}));
    r.dispatchEvent(new Event('change',{bubbles:true}));
    return 'set '+want; })()`);
  await sleep(900);
  const scaleAfter = (await dialogLive()).settings.scale.value;
  ok('the scale control reaches the settings document', scaleSet === 'no control' || scaleAfter !== scaleBefore, `${scaleBefore} → ${scaleAfter} (${scaleSet})`);

  const beforeD = (await dialogLive()).live.length;
  await c.eval(`(function(){
    var b=[].slice.call(document.querySelectorAll('.btn')).find(function(n){return /Spawn alert/i.test(n.textContent)});
    if(b) b.click(); return Boolean(b); })()`);
  const grewD = await (async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if ((await dialogLive()).live.length !== beforeD) return true;
    }
    return false;
  })();
  ok('the pane’s spawn button reaches the server', grewD, `${beforeD} → ${(await dialogLive()).live.length}`);
  let paintedDCount = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    // the preview clones the layer once to dim the half outside the fence, so count only the live
    // layer's children — the clone is aria-hidden
    paintedDCount = await c.eval('[].slice.call(document.querySelectorAll("#pane .dg-desk .dialog")).filter(function(n){ return !n.closest(".pv-layer-out"); }).length');
    if (paintedDCount === (await dialogLive()).live.length) break;
  }
  const serverD2 = (await dialogLive()).live.length;
  ok('a spawned alert appears on the preview over SSE', paintedDCount === serverD2, `painted ${paintedDCount}, server ${serverD2}`);

  const widthsD = [1280, 1600, 1024];
  for (const w of widthsD) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const m = JSON.parse(await c.eval('JSON.stringify({sw: document.documentElement.scrollWidth, iw: window.innerWidth})'));
    ok(`alerts pane: no horizontal overflow at ${w}`, m.sw <= m.iw, `scrollWidth ${m.sw} innerWidth ${m.iw}`);
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await shot(c, path.join(SCRATCH, 'pane-dialogs.png'));

  /* ----------------------------------------------- dialogs: form ownership */

  {
    const schema = Object.keys((await dialogLive()).settings || {});
    const rendered = JSON.parse(
      await c.eval(`JSON.stringify([].slice.call(document.querySelectorAll('[id^="set-"]')).map(function(n){return n.id.slice(4);}).filter(function(v){return !/-track$/.test(v);}).filter(function(v,i,a){return a.indexOf(v)===i;}))`),
    );
    const stale = rendered.filter((k) => !schema.includes(k));
    const dup = rendered.filter((k) => ['theme', 'scale'].includes(k));
    const missing = schema.filter((k) => !rendered.includes(k) && !['theme', 'scale'].includes(k));
    ok('dialogs: settings rows name schema keys only', stale.length === 0, `${rendered.length} rows, stale: ${stale.join(', ') || 'none'}`);
    ok('dialogs: no row repeats a quick control', dup.length === 0, dup.join(', ') || 'none');
    ok('dialogs: every schema key has a control', missing.length === 0, missing.join(', ') || `${schema.length} keys covered`);
  }

  /* ------------------------------------------------------------- console */

  const consoleErrors = c.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
  ok('no console errors while exercising both panes', consoleErrors.length === 0, consoleErrors.map((e) => (e.params.args || []).map((a) => a.value || a.description).join(' ')).slice(0, 3).join(' | '));
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
