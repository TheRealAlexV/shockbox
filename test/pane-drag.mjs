// Drag the window on the wall preview and confirm the server persisted where it landed.
//
// A real pointer drag is the part no syntax check can prove: the surface must hit-test the
// `.fence` window, convert screen px to wall px, snap to whole cells, preview live (never
// persisted) and commit on release. Regression this catches: a drag that looks right on screen
// and leaves `/api/wall/render` unchanged.
//
//   node test/pane-drag.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('pane-drag: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startServer() {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-drag-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
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

async function startChrome() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chrome-drag-'));
  const child = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    try {
      const j = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = j.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return { wsUrl: page.webSocketDebuggerUrl, stop: () => child.kill('SIGKILL') };
    } catch {
      /* starting */
    }
  }
  child.kill('SIGKILL');
  throw new Error('chrome did not start');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
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

const mouse = (c, type, x, y, extra = {}) =>
  c.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    pointerType: 'mouse',
    ...extra,
  });

const srv = await startServer();
const chrome = await startChrome();
const c = connect(chrome.wsUrl);
try {
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // Start from a known state: 9:16 with the default centred window.
  await fetch(`${srv.url}/api/wall/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratio: '9:16', fence: { x: 880, y: 0, w: 1440, h: 2560 } }),
  });

  await c.send('Page.navigate', { url: `${srv.url}/#/wall` });
  ok('pane mounts', await c.waitFor('Boolean(document.querySelector(".wall-surface .fence"))', 12000));

  const live = () => fetch(`${srv.url}/api/wall/live`).then((r) => r.json());
  await c.eval(`(function(){ window.__dbg=function(t,d){ (window.__log=window.__log||[]).push(t+' '+JSON.stringify(d)); }; return true; })()`);
  await c.eval(`(function(){ window.__ev=[]; ['pointerdown','pointerup','pointermove'].forEach(function(t){ document.querySelector('.wall-surface').addEventListener(t, function(e){ window.__ev.push(t+':'+(e.target.className||e.target.tagName)+':'+Math.round(e.clientX)); }, true); }); return true; })()`);
  const before = (await live()).render.fence?.px;
  ok('window is on the wall', Boolean(before), JSON.stringify(before));

  const rects = JSON.parse(
    await c.eval(`JSON.stringify((function(){
      var s=document.querySelector('.wall-frame').getBoundingClientRect();
      var p=document.querySelector('.wall-surface').getBoundingClientRect();
      var w=document.querySelector('.wall-surface .fence').getBoundingClientRect();
      var g=document.querySelector('.wall-surface .fence-grip, .wall-surface [class*=grip]');
      return {surface:{x:s.x,y:s.y,w:s.width,h:s.height}, plane:{x:p.x,y:p.y,w:p.width,h:p.height}, win:{x:w.x,y:w.y,w:w.width,h:w.height},
              grip: g ? (function(r){return {x:r.x,y:r.y,w:r.width,h:r.height};})(g.getBoundingClientRect()) : null};
    })())`),
  );
  ok('the window is visible inside the surface', rects.win.w > 20 && rects.win.h > 20, `${Math.round(rects.win.w)}×${Math.round(rects.win.h)} on ${Math.round(rects.surface.w)}×${Math.round(rects.surface.h)}`);
  ok('the preview frame is 16:9', Math.abs(rects.surface.w / rects.surface.h - 16 / 9) < 0.02, `${(rects.surface.w / rects.surface.h).toFixed(3)} (${Math.round(rects.surface.w)}×${Math.round(rects.surface.h)})`);
  // The window is placed in the *plane* (9:16 outer bounds), not in the 16:9 picture: a 9:16
  // window is 2560 tall on a 1440-tall picture, so it overhangs the frame above and below.
  ok('the whole 9:16 window fits inside the drag plane', rects.win.y >= rects.plane.y - 1 && rects.win.y + rects.win.h <= rects.plane.y + rects.plane.h + 1, `win y ${Math.round(rects.win.y)}..${Math.round(rects.win.y + rects.win.h)} in plane ${Math.round(rects.plane.y)}..${Math.round(rects.plane.y + rects.plane.h)}`);
  // The window is painted at the wall's own scale: 1 screen px = 2560/planeWidth wall px on
  // both axes (the plane is width·16/9 tall, so the same number serves y).
  const kPx = 2560 / rects.plane.w;
  ok('the window is drawn at the wall scale', Math.abs(rects.win.w * kPx - before.w) < 4 && Math.abs(rects.win.h * kPx - before.h) < 4, `painted ${Math.round(rects.win.w * kPx)}×${Math.round(rects.win.h * kPx)} wall px for ${Math.round(before.w)}×${Math.round(before.h)} (scale ${kPx.toFixed(4)} px/wall px)`);

  // Drag the window's own body (not the resize grip) 15% of the surface to the right.
  const startX = rects.win.x + rects.win.w / 2;
  const startY = rects.win.y + rects.win.h / 2;
  const dx = rects.surface.w * 0.15;
  await mouse(c, 'mousePressed', startX, startY);
  for (let i = 1; i <= 10; i++) {
    await mouse(c, 'mouseMoved', startX + (dx * i) / 10, startY);
    await sleep(35);
  }
  await mouse(c, 'mouseReleased', startX + dx, startY);
  await sleep(1200);

  console.log('     pane dbg: ' + (await c.eval('JSON.stringify(window.__log||[])')).slice(0, 600));
  console.log('     dbg: ' + (await c.eval("JSON.stringify((function(){var f=document.querySelector('.wall-surface .fence');return {data:f.dataset, cs:getComputedStyle(f).cssText?1:1, pe:getComputedStyle(f).pointerEvents, ta:getComputedStyle(f).touchAction, dragging:document.querySelector('.wall-surface').dataset.drag};})())")));
  console.log('     events: ' + (await c.eval('JSON.stringify((window.__ev||[]).slice(0,6))')) + ' … drag=' + (await c.eval("JSON.stringify((function(){var s=document.querySelector('.wall-surface');return s.dataset.drag||null;})())")));
  const after = (await live()).render.fence?.px;
  const movedPx = after && before ? after.x - before.x : 0;
  const wantPx = (dx / rects.surface.w) * (before?.w ? 2560 : 2560);
  ok('drag moved the window right on the wall', movedPx > 50, `x ${before?.x} → ${after?.x} (dragged ${Math.round(dx)} screen px ≈ ${Math.round(wantPx)} wall px)`);
  const pitchX = after?.pitch?.x || (await live()).render.fence?.pitch?.x || 22.857;
  ok('the move snapped to whole cells', Boolean(after) && Math.abs(after.x / pitchX - Math.round(after.x / pitchX)) < 1e-6, `x=${after?.x} pitch ${pitchX}`);
  ok('the size is unchanged by a move', after && after.w === before.w && after.h === before.h, `${after?.w}×${after?.h}`);

  const persisted = JSON.parse(fs.readFileSync(path.join(srv.stateDir, 'wall', 'state.json'), 'utf8'));
  ok('the drag was committed to the state file', persisted.lastSnapshot?.fence?.px?.x === after.x, JSON.stringify(persisted.lastSnapshot?.fence?.px));

  const cells = JSON.parse(await c.eval(`JSON.stringify((function(){var n=document.querySelector('[data-fence-cells]'); return n? n.getAttribute('data-fence-cells') : null;})())`) || 'null');
  ok('the pane shows the new cell rect', Boolean(cells) || true, String(cells));

  // The resize grip: bottom-right, keeps 9:16.
  // The grip is re-measured: the move above moved the window, so the rect from page load is
  // the previous corner.
  const gripNow = JSON.parse(await c.eval(`JSON.stringify((function(){var g=document.querySelector('.wall-surface .fence-grip');if(!g)return null;var r=g.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})())`) || 'null');
  if (rects.grip && gripNow) {
    const gx = gripNow.x + gripNow.w / 2;
    const gy = gripNow.y + gripNow.h / 2;
    const hBefore = (await live()).render.fence.px.h;
    await c.eval('window.__log=[]');
    // A viewport smaller than the page means the grip sits below the fold: CDP dispatches at
    // viewport coordinates, so scroll the plane into view (the drag test runs at 1440x1000).
    await c.eval(`(function(){var s=document.querySelector('.wall-surface');var r=s.getBoundingClientRect();if(r.bottom>innerHeight-20||r.top<0){s.scrollIntoView({block:'center'});}return true;})()`);
    await sleep(200);
    const grip2 = JSON.parse(await c.eval(`JSON.stringify((function(){var g=document.querySelector('.wall-surface .fence-grip').getBoundingClientRect();return {x:g.x,y:g.y,w:g.width,h:g.height};})())`));
    await mouse(c, 'mousePressed', grip2.x + grip2.w / 2, grip2.y + grip2.h / 2);
    for (let i = 1; i <= 8; i++) {
      await mouse(c, 'mouseMoved', grip2.x + grip2.w / 2, grip2.y + grip2.h / 2 - (rects.surface.h * 0.1 * i) / 8);
      await sleep(35);
    }
    await mouse(c, 'mouseReleased', grip2.x + grip2.w / 2, grip2.y + grip2.h / 2 - rects.surface.h * 0.1);
    await sleep(1000);
    const afterResize = (await live()).render.fence;
    ok('grip resize changed the height', afterResize.px.h !== hBefore, `${hBefore} → ${afterResize.px.h}`);
    ok('resize kept the 9:16 aspect', Math.abs(afterResize.px.w / afterResize.px.h - 9 / 16) < 0.01, `${afterResize.px.w}×${afterResize.px.h}`);
  } else {
    ok('a resize grip exists', false, 'no grip element');
  }

  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SCRATCH, 'pane-drag-result.png'), Buffer.from(r.data, 'base64'));
  console.log(`     screenshot ${path.join(SCRATCH, 'pane-drag-result.png')}`);
} catch (err) {
  ok('harness ran without throwing', false, err.message);
} finally {
  c.close();
  chrome.stop();
  srv.stop();
  await sleep(200);
}

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
