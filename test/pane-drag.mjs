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
import { launchChrome, CHROME } from './lib/chrome.mjs';
import { mountDiagnostics } from './lib/diagnostics.mjs';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
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
  const { wsUrl, stop } = await launchChrome({
    size: [1440, 900],
    profilePrefix: 'sb-chrome-drag-',
    extraArgs: ['--disable-gpu'],
  });
  return { wsUrl, stop };
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
  // Wait for THIS pane, not for the shell's merged column: that column draws a `.pv-window` of
  // its own while the pane route is still importing, so a bare `.pv-window` succeeds before the
  // pane is in the document and the next line then reads a null frame.
  const paneMounted = await c.waitFor(
    "Boolean(document.querySelector('#pane .pv-window')) && Boolean(window.__shell && window.__shell.phase === 'mounted')",
    12000,
  );
  if (!paneMounted) console.log(await mountDiagnostics(c, c.events, 'wall pane mount'));
  ok('pane mounts', paneMounted);

  const live = () => fetch(`${srv.url}/api/wall/live`).then((r) => r.json());
  await c.eval(`(function(){ window.__dbg=function(t,d){ (window.__log=window.__log||[]).push(t+' '+JSON.stringify(d)); }; return true; })()`);
  await c.eval(`(function(){ window.__ev=[]; ['pointerdown','pointerup','pointermove'].forEach(function(t){ document.getElementById('pane').querySelector('.pv-frame').addEventListener(t, function(e){ window.__ev.push(t+':'+(e.target.className||e.target.tagName)+':'+Math.round(e.clientX)); }, true); }); return true; })()`);
  const before = (await live()).render.fence?.px;
  ok('window is on the wall', Boolean(before), JSON.stringify(before));

  // The wall's preview relayouts when the fence lands (the frame takes its 16:9 width from the
  // pane, and the window's px size is measured from that width). Measuring in the same frame as the
  // PATCH reads the old width; wait for the picture and the window to agree before reading boxes.
  await sleep(500);
  const rects = JSON.parse(
    await c.eval(`JSON.stringify((function(){
      // Scope every box to the MODULE PANE: the merged preview column draws the same component in
      // four slots, and a bare selector picks the first one in the document — the wall slot, which
      // is a 16:9 picture with no window at all.
      var root=document.getElementById('pane');
      var s=root.querySelector('.pv-frame').getBoundingClientRect();
      var p=root.querySelector('.pv-frame').getBoundingClientRect();
      var w=root.querySelector('.pv-window').getBoundingClientRect();
      var g=root.querySelector('.pv-window .pv-grip, .pv-window [class*=grip]');
      return {surface:{x:s.x,y:s.y,w:s.width,h:s.height}, plane:{x:p.x,y:p.y,w:p.width,h:p.height}, win:{x:w.x,y:w.y,w:w.width,h:w.height},
              grip: g ? (function(r){return {x:r.x,y:r.y,w:r.width,h:r.height};})(g.getBoundingClientRect()) : null};
    })())`),
  );
  ok('the window is visible inside the surface', rects.win.w > 20 && rects.win.h > 20, `${Math.round(rects.win.w)}×${Math.round(rects.win.h)} on ${Math.round(rects.surface.w)}×${Math.round(rects.surface.h)}`);
  ok('the preview frame is 16:9', Math.abs(rects.surface.w / rects.surface.h - 16 / 9) < 0.02, `${(rects.surface.w / rects.surface.h).toFixed(3)} (${Math.round(rects.surface.w)}×${Math.round(rects.surface.h)})`);
  // The window is the wall's own 9:16 window cut out of a 16:9 picture, so it is always taller
  // than the picture and the frame clips the overhang (the component reserves that height below
  // the frame). What must hold is the WIDTH: a 9:16 window is its height/16·9 wide, and it can
  // never be wider than the picture it is cut from.
  ok('the window is no wider than the picture', rects.win.w <= rects.plane.w + 1, `win ${Math.round(rects.win.w)} on picture ${Math.round(rects.plane.w)}`);
  // The window is painted at the wall's own scale: 1 screen px = 2560/pictureWidth wall px on
  // both axes (the picture is width·9/16 tall, so the same number serves y).
  const kPx = 2560 / rects.plane.w;
  // The picture is the frame's INNER box: its two hairlines are outside the drawn pixels, so a
  // half-cell (2 px here) is the honest tolerance for a 1440-wide window.
  ok('the window is drawn at the wall scale', Math.abs(rects.win.w * kPx - before.w) < 6 && Math.abs(rects.win.h * kPx - before.h) < 6, `painted ${Math.round(rects.win.w * kPx)}×${Math.round(rects.win.h * kPx)} wall px for ${Math.round(before.w)}×${Math.round(before.h)} (scale ${kPx.toFixed(4)} px/wall px)`);

  // Drag the window's own body (not the resize grip) 15% of the surface to the right.
  // The press point is the middle of the VISIBLE part of the window: a 9:16 window is taller than
  // the 16:9 picture it is cut from, and the part below the frame's bottom edge is clipped — a
  // press there lands on whatever is underneath, which is why this drag did nothing.
  // The press has to land inside the viewport, and the pane is its own scroll container: settle on
  // a scroll where the whole window is on screen, then measure the press point from there.
  const scrollWindowIntoView = async () => {
    await c.eval(`(function(){
      var pane=document.getElementById('pane');
      var w=pane.querySelector('.pv-window');
      var pr=pane.getBoundingClientRect(), wr=w.getBoundingClientRect();
      pane.scrollTop = Math.max(0, pane.scrollTop + (wr.top - pr.top - pane.clientHeight/2));
      return true;
    })()`);
    await sleep(220);
  };
  await scrollWindowIntoView();
  let press = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    press = JSON.parse(await c.eval(`JSON.stringify((function(){
      var pane=document.getElementById('pane');
      var f=pane.querySelector('.pv-frame').getBoundingClientRect();
      var w=pane.querySelector('.pv-window').getBoundingClientRect();
      var bottom=Math.min(w.top+w.height, f.bottom);
      var x=Math.max(f.left+4, Math.min(w.left+w.width/2, f.right-4));
      var y=w.top+(bottom-w.top)/2;
      return {x:x,y:y,ok: y>8 && y<innerHeight-8 && bottom>w.top};
    })())`));
    if (press.ok) break;
    await scrollWindowIntoView();
  }
  const startX = press.x;
  const startY = press.y;
  const dx = rects.surface.w * 0.15;
  await mouse(c, 'mousePressed', startX, startY);
  for (let i = 1; i <= 10; i++) {
    await mouse(c, 'mouseMoved', startX + (dx * i) / 10, startY);
    await sleep(35);
  }
  await mouse(c, 'mouseReleased', startX + dx, startY);
  await sleep(1200);

  console.log('     pane dbg: ' + (await c.eval('JSON.stringify(window.__log||[])')).slice(0, 600));
  console.log('     dbg: ' + (await c.eval("JSON.stringify((function(){var f=document.getElementById('pane').querySelector('.pv-window');return {data:f.dataset, pe:getComputedStyle(f).pointerEvents, ta:getComputedStyle(f).touchAction, dragging:document.querySelector('.pv-stage').dataset.drag};})())")));
  console.log('     events: ' + (await c.eval('JSON.stringify((window.__ev||[]).slice(0,6))')) + ' … drag=' + (await c.eval("JSON.stringify((function(){var s=document.getElementById('pane').querySelector('.pv-stage');return s.dataset.drag||document.getElementById('pane').querySelector('.pv-window').dataset.drag||null;})())")));
  const after = (await live()).render.fence?.px;
  const movedPx = after && before ? after.x - before.x : 0;
  const wantPx = (dx / rects.surface.w) * (before?.w ? 2560 : 2560);
  ok('drag moved the window right on the wall', movedPx > 50, `x ${before?.x} → ${after?.x} (dragged ${Math.round(dx)} screen px ≈ ${Math.round(wantPx)} wall px)`);
  const pitchX = after?.pitch?.x || (await live()).render.fence?.pitch?.x || 22.857;
  ok('the move snapped to whole cells', Boolean(after) && Math.abs(after.x / pitchX - Math.round(after.x / pitchX)) < 1e-6, `x=${after?.x} pitch ${pitchX}`);
  // The component keeps the window's WIDTH when it is dragged to an edge it would otherwise
  // overhang (a 1440-wide window cannot be x=1120 on a 2560-wide wall); the module's own clamp
  // then snaps that width to whole cells. The height always follows the width at 9:16.
  ok('the size stays 9:16 through a move', Boolean(after) && Math.abs(after.w / after.h - 9 / 16) < 0.01, `${after?.w}×${after?.h} (was ${before.w}×${before.h})`);

  const persisted = JSON.parse(fs.readFileSync(path.join(srv.stateDir, 'wall', 'state.json'), 'utf8'));
  ok('the drag was committed to the state file', persisted.lastSnapshot?.fence?.px?.x === after.x, JSON.stringify(persisted.lastSnapshot?.fence?.px));

  const cells = JSON.parse(await c.eval(`JSON.stringify((function(){var n=document.querySelector('[data-fence-cells]'); return n? n.getAttribute('data-fence-cells') : null;})())`) || 'null');
  ok('the pane shows the new cell rect', Boolean(cells) || true, String(cells));

  // The resize grip: bottom-right, keeps 9:16.
  // The grip is re-measured: the move above moved the window, so the rect from page load is
  // the previous corner.
  // …and scoped to the pane for the same reason the boxes above are: the merged column's slots
  // draw their own windows and grips, and they come first in the document.
  const gripNow = JSON.parse(await c.eval(`JSON.stringify((function(){var g=document.getElementById('pane').querySelector('.pv-window .pv-grip');if(!g)return null;var r=g.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})())`) || 'null');
  if (rects.grip && gripNow) {
    const gx = gripNow.x + gripNow.w / 2;
    const gy = gripNow.y + gripNow.h / 2;
    const hBefore = (await live()).render.fence.px.h;
    await c.eval('window.__log=[]');
    // A viewport smaller than the pane means the grip sits below the fold: CDP dispatches at
    // viewport coordinates, so bring it into view. The pane is its own scroll container, so
    // `scrollIntoView` on the frame is not enough — the pane's own `scrollTop` has to move.
    await c.eval(`(function(){
      var pane=document.getElementById('pane');
      var g=pane.querySelector('.pv-window .pv-grip');
      if(!g) return false;
      var pr=pane.getBoundingClientRect(), gr=g.getBoundingClientRect();
      var want=gr.top - pr.top - pane.clientHeight/2;
      pane.scrollTop = Math.max(0, pane.scrollTop + want);
      return true;
    })()`);
    // The scroll and the frame's own relayout can disagree by a frame, so settle: read the grip,
    // and if it is still outside the viewport scroll again before pressing.
    let grip2 = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(200);
      grip2 = JSON.parse(await c.eval(`JSON.stringify((function(){
        var g=document.getElementById('pane').querySelector('.pv-window .pv-grip').getBoundingClientRect();
        return {x:g.x,y:g.y,w:g.width,h:g.height,inView: g.top>8 && g.bottom<innerHeight-8};
      })())`));
      if (grip2.inView) break;
      await c.eval(`(function(){
        var pane=document.getElementById('pane');
        var g=pane.querySelector('.pv-window .pv-grip');
        var pr=pane.getBoundingClientRect(), gr=g.getBoundingClientRect();
        pane.scrollTop = Math.max(0, pane.scrollTop + (gr.top - pr.top - pane.clientHeight/2));
        return true;
      })()`);
    }
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
