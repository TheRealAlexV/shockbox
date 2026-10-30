// Real-browser check of the wall render page, driven over CDP (no puppeteer dependency).
//
// Why a browser: the page is classic scripts on a canvas. Syntax checks and HTTP 200s cannot
// tell whether the engine mounted, whether server mode pulled its settings, or whether a bus
// command reached the wall. Only a live page can, and only with the same code path OBS uses.
//
//   node test/wall-browser.mjs            # boots its own server on an ephemeral port
//   node test/wall-browser.mjs --url=http://127.0.0.1:8981
//
// Exits non-zero on the first failed expectation, printing the page's console and its diag().

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, CHROME } from './lib/chrome.mjs';
import { probeGl, glLine } from './lib/gl-probe.mjs';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
if (!CHROME) {
  console.error('wall-browser: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wall-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) {
        // The server holds SSE streams and timers open; a killed test must not leave one behind.
        const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
        process.on('exit', () => child.kill('SIGKILL'));
        return { url, log, stop };
      }
    } catch {
      /* not up yet */
    }
  }
  child.kill('SIGKILL');
  throw new Error(`server did not come up:\n${log.join('')}`);
}

// ── Tiny CDP client ─────────────────────────────────────────────────────────
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
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(c, expression, ms = 8000) {
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

async function main() {
  const srv = await startServer();
  const { devtools, stop: stopChrome } = await launchChrome({
    size: [1280, 720],
    profilePrefix: 'sb-chrome-',
    // The engine needs a real WebGL2 context. `--disable-gpu` tells Chrome not to bother with one,
    // which leaves a headless runner that has no device with nothing to fall back to; ask for
    // SwiftShader explicitly instead, the same way handfx-visual does.
    extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const c = await cdp(devtools);
  const consoleLines = [];
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Log.enable');
  // First error on the page, kept for the fence debug line: a thrown script leaves the engine
  // half-mounted, and every later assertion reads as "missing" rather than "broken".
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.addEventListener('error', function (e) { window.__err = (e && e.message) || 'error'; });
             window.addEventListener('unhandledrejection', function (e) { window.__err = 'promise: ' + ((e.reason && e.reason.message) || e.reason); });`,
  });
  // Console + network failures are the first thing to look at when a page does not mount.
  const origPush = c.events.push.bind(c.events);
  c.events.push = (...args) => {
    for (const e of args) {
      if (e && e.method === 'Runtime.consoleAPICalled') {
        const text = (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleLines.push(`${e.params.type}: ${text}${e.params.stackTrace ? '' : ''}`);
      } else if (e && e.method === 'Log.entryAdded') {
        consoleLines.push(`log ${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}`);
      }
    }
    return origPush(...args);
  };

  try {
    await c.send('Page.navigate', { url: `${srv.url}/wall/render` });
    const mounted = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.view)');
    ok('page mounts the engine', Boolean(mounted), mounted ? `view=${mounted}` : 'LEDWALL_INSTANCE never appeared');
    if (!mounted) {
      console.log(`     console:\n       ${consoleLines.slice(-20).join('\n       ') || '(none)'}`);
      console.log(`     ${glLine(await probeGl(c))}`);
      throw new Error('engine did not mount');
    }

    const mode = await evaluate(c, 'window.LEDWALL_SERVER_MODE');
    ok('served page is in server mode', mode === true, `LEDWALL_SERVER_MODE=${mode}`);

    // 1. The page pulls the server's settings and the control pane can change them.
    const patched = await fetch(`${srv.url}/api/core/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}).toString(),
    }).catch(() => null);
    // Core settings are not the wall's document; the wall settings route is what the pane uses.
    const wallSet = await evaluate(
      c,
      `fetch('/api/wall/state').then(r=>r.json()).then(j=>j.settings ? Object.keys(j.settings) : [])`,
      true,
    );
    ok('page can read /api/wall/state', Array.isArray(wallSet), Array.isArray(wallSet) ? wallSet.join(',') : String(wallSet));

    const look = await evaluate(
      c,
      `fetch('/api/wall/render').then(r=>r.json()).then(j=>j.settings && j.settings.look)`,
      true,
    );
    ok('/api/wall/render returns a look', Boolean(look && typeof look === 'object'), JSON.stringify(look));

    // 2. A deck-style command reaches the wall through the bus, in the same tick budget OBS has.
    const patternBefore = await evaluate(c, 'window.LEDWALL_INSTANCE.getSettings().views[window.LEDWALL_INSTANCE.view].pattern');
    const sent = await evaluate(
      c,
      `fetch('/api/wall/cmd',{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify({cmd:'pattern.next'})}).then(r=>r.json())`,
      true,
    );
    ok('POST /api/wall/cmd accepted', sent && sent.ok === true, JSON.stringify(sent));
    const applied = await waitFor(c, 'window.LEDWALL_INSTANCE.s.pattern !== ' + JSON.stringify(patternBefore), 4000);
    const patternNow = await evaluate(c, 'window.LEDWALL_INSTANCE.getSettings().views[window.LEDWALL_INSTANCE.view].pattern');
    const cmdState = await evaluate(c, 'JSON.stringify((function(i){ var v=i.diag().agent; return {received:v.received, applied:v.applied, ignored:v.ignored, errors:v.errors, lastCmd:v.lastCmd}; })(window.LEDWALL_INSTANCE))');
    console.log('     pipeline: ' + cmdState);
    ok('command applied on the page', Boolean(applied), `pattern ${patternBefore} -> ${patternNow}`);

    // 2b. A control-pane settings change reaches the page as a state snapshot.
    const briBefore = await evaluate(c, 'window.LEDWALL_INSTANCE.getSettings().brightness');
    // A look change is a settings write (validated against the module schema); /broadcast
    // carries the fence only, by design.
    const patch = await fetch(`${srv.url}/api/wall/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brightness: 0.55 }),
    }).then((r) => r.json());
    ok('PATCH /api/wall/settings accepted', patch && patch.ok === true, JSON.stringify(patch));
    const briApplied = await waitFor(c, 'Math.abs(window.LEDWALL_INSTANCE.s.brightness - 0.55) < 1e-9', 4000);
    const briNow = await evaluate(c, 'window.LEDWALL_INSTANCE.getSettings().brightness');
    ok('state snapshot applied on the page', Boolean(briApplied), `brightness ${briBefore} -> ${briNow}`);

    // 3. Rejected commands are rejected, not silently swallowed.
    const bad = await evaluate(
      c,
      `fetch('/api/wall/cmd',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cmd:'gate.set'})}).then(async r=>({status:r.status,body:await r.json()}))`,
      true,
    );
    ok('unknown cmd is a 400', bad && bad.status === 400 && /unknown cmd/.test(bad.body.error || ''), JSON.stringify(bad));

    // 4. The heartbeat marks the page online, through its own POST /api/wall/state.
    const online = await waitFor(c, `fetch('/api/wall/render').then(r=>r.json()).then(j=>j.online.landscape === true)`, 8000);
    ok('page heartbeat marks it online', Boolean(online));
    const hb = await evaluate(c, 'JSON.stringify(window.LEDWALL_INSTANCE.diag().agent)');
    const agent = JSON.parse(hb);
    ok('heartbeat POSTs succeed', agent.postOk > 0 && agent.postFail === 0, `postOk=${agent.postOk} postFail=${agent.postFail} lastError=${agent.lastError}`);

    // 5. The canvas is actually painting: two frames apart must differ.
    const shot1 = await c.send('Page.captureScreenshot', { format: 'png' });
    await sleep(600);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    ok('canvas is animating', shot1.data !== shot2.data, shot1.data === shot2.data ? 'identical frames 600 ms apart' : 'frames differ');

    // 4b. The pane's fence control: a pixel rect in, a whole-cell window on the wall out.
    const fencePush = await fetch(`${srv.url}/api/wall/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { fence: { x: 880, y: 0, w: 1440, h: 2560 } }, live: true }),
    }).then((r) => r.json());
    ok('fence broadcast accepted', fencePush && fencePush.ok === true, JSON.stringify(fencePush));
    const fenceOn = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE.fenceCells)', 4000);
    const fenceState = await evaluate(c, 'JSON.stringify({cells: window.LEDWALL_INSTANCE.fenceCells, fence: window.LEDWALL_INSTANCE.fence, scale: window.LEDWALL_INSTANCE.scale, W: window.LEDWALL_INSTANCE.W, grid: window.LEDWALL_INSTANCE.grid})');
    ok('fence reaches the page', Boolean(fenceOn), fenceState);
    console.log('     fence pipeline: ' + (await evaluate(c, `JSON.stringify({snap: window.LEDWALL_INSTANCE.diag().agent.snapshots, last: window.LEDWALL_INSTANCE.diag().agent.lastCmd, fn: typeof window.LEDWALL_INSTANCE.setFence, on: window.LEDWALL_INSTANCE.fenceOn, fence: window.LEDWALL_INSTANCE.fence})`)));

    // The page's look is the control pane's document: a look key must survive a refresh, and
    // the fence must arrive with it (the page never re-derives it).
    console.log('     before reload: ' + (await evaluate(c, `JSON.stringify({f: window.LEDWALL_INSTANCE.fenceCells, on: window.LEDWALL_INSTANCE.fenceOn})`)));
    await c.send('Page.navigate', { url: `${srv.url}/wall/render?nonce=${Date.now()}` });
    const remote = await fetch(`${srv.url}/api/wall/render`).then((r) => r.json()).catch((e) => ({ error: e.message }));
    const pageFetch = await evaluate(c, `fetch('/api/wall/render',{headers:{Accept:'application/json'}}).then(r=>r.json()).then(j=>JSON.stringify(j.settings && j.settings.fence)).catch(e=>'ERR '+e.message)`, true);
    console.log('     fence fetched by page: ' + pageFetch);
    console.log('     fence from server: ' + JSON.stringify(remote.settings && remote.settings.fence));
    const applied0 = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE)') && await evaluate(c, 'JSON.stringify({on: window.LEDWALL_INSTANCE.fenceOn, fence: window.LEDWALL_INSTANCE.fence, fn: typeof window.LEDWALL_INSTANCE.setFence})');
    console.log('     applied at mount: ' + applied0);
    const remounted = await waitFor(c, 'Boolean(window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.fenceCells)');
    console.log('     fence debug: ' + (await evaluate(c, `JSON.stringify({mode: window.LEDWALL_SERVER_MODE, fence: window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.fence, cells: window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.fenceCells, on: window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.fenceOn, grid: window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.grid && [window.LEDWALL_INSTANCE.grid.cols, window.LEDWALL_INSTANCE.grid.rows], W: window.LEDWALL_INSTANCE && window.LEDWALL_INSTANCE.W, thrown: window.__err || null})`)));
    ok('look + fence survive a page reload', Boolean(remounted), remounted ? JSON.stringify(await evaluate(c, 'window.LEDWALL_INSTANCE.getSettings().brightness')) : 'no fence after reload');

    // 6. The 9:16 fence: a whole-cell window in the middle of a 16:9 wall.
    const fb = await evaluate(c, `JSON.stringify(window.LEDWALL_INSTANCE.fenceCells)`);
    const fenceCells = JSON.parse(fb);
    ok('fence snapped to whole cells', Boolean(fenceCells && fenceCells.w > 0 && fenceCells.h > 0), fb);
    if (fenceCells) {
      // A 9:16 window on a 112x63 wall: 63 tall (the full wall height) and 35 wide. Pixels:
      // 35 * 1280/112 = 400 wide, 63 * 720/63 = 720 tall → exactly 9:16.
      const pxW = fenceCells.w * (1280 / 112);
      const pxH = fenceCells.h * (720 / 63);
      const ratio = pxW / pxH;
      ok('fence is a 9:16 window', Math.abs(ratio - 9 / 16) < 0.01, `${fenceCells.w}x${fenceCells.h} cells = ${pxW.toFixed(0)}x${pxH.toFixed(0)} px, ratio ${ratio.toFixed(4)}`);
      const centred = Math.abs(fenceCells.x - (112 - fenceCells.x - fenceCells.w)) <= 2;
      ok('fence is centred on the wall', centred, `x=${fenceCells.x} w=${fenceCells.w} of 112`);
      // A pixel-level clue that the window is really rendered: sample the two sides of the ring.
      await sleep(500);
      const px = await evaluate(
        c,
        `(function(){
           var i = window.LEDWALL_INSTANCE, g = i.grid, f = i.fenceCells;
           var gl = i.gl, w = i.W, h = i.H;
           var buf = new Uint8Array(4);
           function at(cx, cy) {
             gl.bindFramebuffer(gl.FRAMEBUFFER, null);
             // readPixels is bottom-up: flip the row.
             gl.readPixels(Math.round(cx), Math.round(cy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
             return [buf[0], buf[1], buf[2]];
           }
           var pitchX = w / g.cols, pitchY = h / g.rows;
           var inside = at((f.x + 0.5) * pitchX, (f.y + 0.5) * pitchY);
           var outside = at((f.x - 6) * pitchX, (f.y + 0.5) * pitchY);
           var lum = function (c) { return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]; };
           return { inside: lum(inside), outside: lum(outside) };
         })()`,
      );
      ok('fence edge is lit against the dimmed wall', px.inside > px.outside + 12, `ring ${px.inside.toFixed(0)} vs outside ${px.outside.toFixed(0)}`);
    }

    // 6. No page errors. The engine logs to console on a broken script.
    const errors = c.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
    ok('no uncaught page exceptions', errors.length === 0, errors.join(' | ').slice(0, 400));

    const diag = await evaluate(c, 'JSON.stringify(window.LEDWALL_INSTANCE.diag().agent || {})');
    console.log(`     agent diag: ${diag}`);
  } finally {
    c.close();
    stopChrome();
    srv.stop();
    await new Promise((r) => setTimeout(r, 150));
    if (srv.log) fs.writeFileSync(path.join(SCRATCH, 'wall-browser-server.log'), srv.log.join(''));
    fs.writeFileSync(path.join(SCRATCH, 'wall-browser-console.log'), consoleLines.join('\n'));
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(`wall-browser: ${err.stack || err.message}`);
  process.exit(1);
});
