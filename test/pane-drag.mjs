// Read the wall preview's fence readout and ratio selector, and confirm both follow the server.
//
// The preview is the module's real page in an inert iframe (3a0c433): the pane no longer draws
// or drags a window. What can still silently lie is the iframe's src, the derived rect shown in
// the disabled fields, and the three-way ratio selector writing the server document.
//
//   node test/pane-drag.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, CHROME } from './lib/chrome.mjs';
import { mountDiagnostics } from './lib/diagnostics.mjs';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

const srv = await startServer();
const chrome = await startChrome();
const c = connect(chrome.wsUrl);
try {
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // Start from a known state: 9:16, so the server derives and emits the window.
  await fetch(`${srv.url}/api/wall/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ratio: '9:16' }),
  });

  await c.send('Page.navigate', { url: `${srv.url}/#/wall` });
  // Scope to THIS pane: the merged column at the top of the document mounts the same component,
  // so a bare selector would read that column instead of the pane under test.
  const paneMounted = await c.waitFor(
    "Boolean(document.querySelector('#pane .pv-frame .pv-iframe')) && Boolean(window.__shell && window.__shell.phase === 'mounted')",
    12000,
  );
  if (!paneMounted) console.log(await mountDiagnostics(c, c.events, 'wall pane mount'));
  ok('pane mounts', paneMounted);

  const live = () => fetch(`${srv.url}/api/wall/live`).then((r) => r.json());

  // The preview is the module's own page in an inert iframe: the src is the contract, and there
  // is nothing left to redraw or drag.
  const src = await c.eval(`(function(){var f=document.querySelector('#pane .pv-frame .pv-iframe'); return f? f.getAttribute('src') : '';})()`);
  ok('the preview is the module page in an iframe', src.startsWith('/wall/render'), src || 'no iframe');

  const readout = async () => JSON.parse(await c.eval(`JSON.stringify((function(){
    var out={};
    ['x','y','w','h'].forEach(function(k){ var n=document.querySelector('#wall-fence-'+k); out[k]= n? {value:n.value,disabled:n.disabled} : null; });
    var w=document.querySelector('#pane .pv-window'); var r=w?w.getBoundingClientRect():null;
    out.window = !!r && r.width>8 && r.height>8;
    return out; })())`));
  const derived = (await live()).render.fence?.px;
  ok('the server derives the 9:16 window', Boolean(derived), JSON.stringify(derived));
  for (let t0 = Date.now(); Date.now() - t0 < 8000 && Number((await readout()).x?.value) !== Math.round(derived?.x ?? -1);) await sleep(120);
  const shown = await readout();
  ok('the fence fields are a disabled readout of the derived rect',
    Boolean(derived) && ['x','y','w','h'].every((k) => shown[k] && shown[k].disabled && Number(shown[k].value) === Math.round(derived[k])),
    JSON.stringify(shown));
  ok('the 9:16 crop guide is drawn over the live page', shown.window, JSON.stringify(shown));

  // The three-way ratio selector replaced the window switch and the drag.
  const choices = JSON.parse(await c.eval(`JSON.stringify([].slice.call(document.querySelectorAll('#pane .wall-ratio .seg[data-value]')).map(function(b){ return b.dataset.value; }))`));
  ok('the ratio selector has default, 16:9 and 9:16', choices.join(',') === 'default,16:9,9:16', JSON.stringify(choices));
  const clickRatio = (v) => c.eval(`(function(){var b=document.querySelector('#pane .wall-ratio .seg[data-value="${v}"]'); if(!b) return 'no control'; b.click(); return 'clicked';})()`);

  await clickRatio('16:9');
  await sleep(900);
  const whole = (await live()).render;
  ok('choosing 16:9 writes a whole wall to the server', whole.ratio === '16:9' && whole.fence === null,
    `ratio ${whole.ratio}, fence ${whole.fence ? 'set' : 'null'}`);
  ok('the crop guide is hidden on a whole wall', !(await readout()).window, 'window still drawn');

  await clickRatio('9:16');
  await sleep(900);
  const back = (await live()).render;
  const restored = await readout();
  ok('choosing 9:16 restores the derived window',
    back.ratio === '9:16' && Boolean(back.fence?.px) && restored.window,
    `ratio ${back.ratio}, fence ${back.fence ? 'px' : 'null'}`);

  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SCRATCH, 'pane-fence-readout.png'), Buffer.from(r.data, 'base64'));
  console.log(`     screenshot ${path.join(SCRATCH, 'pane-fence-readout.png')}`);
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
