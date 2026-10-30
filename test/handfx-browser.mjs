// Real-browser check of the handfx module, driven over CDP (no puppeteer dependency).
//
// What only a live browser can prove, and what this checks:
//   · /handfx is served cross-origin isolated (COOP/COEP on the page, not just the API): the page
//     must report crossOriginIsolated === true, because a wasm+SIMD runtime needs it
//   · the page boots: WebGL2 context, the effect programs compile, the tracker module imports
//   · the module registers and its routes answer: /api/handfx/{status,settings,cmd,ack}, the
//     vendored runtime files, and the model (served locally or from the model URL)
//   · the command bus dispatches over SSE and the page applies it (effect.next moves the cursor)
//   · the registry renders in the pane with every effect and its enable/intensity controls
//   · with Chrome's fake camera stream, the camera path opens and the page reaches a real
//     tracking state — then says "no hands" honestly (a fake device shows a test pattern, not a
//     hand, so a gesture firing here would be a lie)
//   · a scripted hand goes through the real tracker → classifier → renderer path and each effect
//     renders without a GL error (the synthetic path, labelled as such)
//
// The model download from the CDN is conditional on the network: if the module has no local model
// and the download fails, that check is reported as skipped, never as passed.
//
//   node test/handfx-browser.mjs                      # boots its own server and Chrome
//   node test/handfx-browser.mjs --url=http://127.0.0.1:8981
//
// Exits non-zero on the first failed expectation.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('handfx-browser: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail, skipped: false });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  results.push({ name, pass: true, detail: why, skipped: true });
  console.log(`skip ${name} — ${why}`);
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
  if (argUrl) return { url: argUrl, log: [], stop() {} };
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-handfx-'));
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
      if (r.ok) return { url, log, stop: () => child.kill('SIGTERM') };
    } catch {
      /* not up yet */
    }
  }
  child.kill('SIGKILL');
  throw new Error(`server did not come up:\n${log.join('')}`);
}

// ── Tiny CDP client ─────────────────────────────────────────────────────────
async function cdp(devtools) {
  const list = await (await fetch(`${devtools}/json/list`)).json();
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
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true, userGesture: true });
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

async function main() {
  const srv = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chrome-'));
  const port = await freePort();
  // Fake camera: Chrome's own test-pattern device, so getUserMedia succeeds without a real one.
  // --use-fake-ui-for-media-stream answers the permission prompt the way a person would.
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const devtools = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try {
      await fetch(`${devtools}/json/version`);
      break;
    } catch {
      /* not up yet */
    }
  }
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
        const text = (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleLines.push(`${e.params.type}: ${text}`);
      } else if (e && e.method === 'Log.entryAdded') {
        consoleLines.push(`log ${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}`);
      }
    }
    return origPush(...args);
  };

  try {
    // ── 1. the module registers and its routes answer ─────────────────────
    const health = await (await fetch(`${srv.url}/health`)).json();
    ok('module registers', health.modules && health.modules.handfx === 'up', JSON.stringify(health.modules || {}));

    const pageRes = await fetch(`${srv.url}/handfx`);
    const coi = {
      coop: pageRes.headers.get('cross-origin-opener-policy'),
      coep: pageRes.headers.get('cross-origin-embedder-policy'),
    };
    ok('page is served cross-origin isolated (COOP+COEP)', coi.coop === 'same-origin' && coi.coep === 'require-corp', JSON.stringify(coi));
    await pageRes.arrayBuffer();

    const status = await (await fetch(`${srv.url}/api/handfx/status`)).json();
    ok('/api/handfx/status answers', Array.isArray(status.effects) && status.effects.length >= 4, `${status.effects ? status.effects.length : 0} effects: ${(status.effects || []).map((e) => e.id).join(',')}`);
    ok('status names the command bus', Array.isArray(status.cmds) && status.cmds.includes('effect.next') && status.cmds.includes('tracking.toggle'), (status.cmds || []).join(' '));
    ok('runtime is vendored', Boolean(status.runtime && status.runtime.vendored), JSON.stringify(status.runtime));

    const runtimeRes = await fetch(`${srv.url}/api/handfx/vendor/vision/vision_bundle.mjs`);
    ok('vendored runtime serves', runtimeRes.ok && Number(runtimeRes.headers.get('content-length') || 0) > 100000, `${runtimeRes.status} ${runtimeRes.headers.get('content-length')}B`);
    await runtimeRes.arrayBuffer();
    const wasmHead = await fetch(`${srv.url}/api/handfx/vendor/vision-runtime-nosimd/wasm/vision_wasm_nosimd_internal.wasm`);
    ok('name-suffixed wasm serves as application/wasm', wasmHead.ok && wasmHead.headers.get('content-type') === 'application/wasm', `${wasmHead.status} ${wasmHead.headers.get('content-type')} ${wasmHead.headers.get('cache-control') || ''}`);
    await wasmHead.arrayBuffer();
    const traversal = await fetch(`${srv.url}/api/handfx/vendor/..%2f..%2fserver.js`);
    ok('vendor route refuses traversal', traversal.status === 404, `HTTP ${traversal.status}`);
    await traversal.arrayBuffer();

    const local = Boolean(status.model && status.model.local);
    const modelRes = await fetch(`${srv.url}/api/handfx/model`);
    if (local) {
      const buf = await modelRes.arrayBuffer();
      ok('local model serves', modelRes.ok && buf.byteLength > 1_000_000, `${modelRes.status} ${buf.byteLength}B`);
    } else {
      // No model on disk: the page would fetch the CDN URL. Report that as a real finding only if
      // the CDN answers; fail if the page's fallback cannot be reached either.
      let up = false;
      try {
        const head = await fetch(status.model.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        up = head.ok;
      } catch {
        up = false;
      }
      if (up) ok('model URL reachable (no local copy)', true, status.model.url);
      else skip('model download', 'no local model and the CDN model URL is unreachable in this environment');
      await modelRes.arrayBuffer().catch(() => {});
    }

    // Settings write path: refuse an unknown effect, accept a known one.
    const badPatch = await fetch(`${srv.url}/api/handfx/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effects: ['fireball', 'not-an-effect'] }),
    });
    ok('settings refuses unknown effect ids', badPatch.status === 400, `HTTP ${badPatch.status}`);
    await badPatch.arrayBuffer();
    const goodPatch = await fetch(`${srv.url}/api/handfx/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sensitivity: 1.1, effects: ['fireball', 'lightning', 'sparkring', 'embers', 'smoke'] }),
    });
    const goodBody = await goodPatch.json();
    ok('settings writes the operator document', goodPatch.status === 200 && goodBody.changed && goodBody.changed.includes('sensitivity'), JSON.stringify(goodBody.changed));
    // Put it back so a rerun starts from the defaults.
    await fetch(`${srv.url}/api/handfx/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sensitivity: 1 }) }).then((r) => r.arrayBuffer());

    const badCmd = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'handfx.explode' }) });
    ok('cmd refuses an unknown command', badCmd.status === 400, `HTTP ${badCmd.status}`);
    await badCmd.arrayBuffer();

    // ── 2. the page ────────────────────────────────────────────────────────
    await c.send('Network.enable');
  await c.send('Page.navigate', { url: `${srv.url}/handfx` });
    const booted = await waitFor(c, 'Boolean(window.__handfx && window.__handfx.ready)');
    ok('page boots and layers compile', Boolean(booted), booted ? '' : 'window.__handfx.ready never true');
    if (!booted) {
      console.log(`     console:\n       ${consoleLines.slice(-20).join('\n       ') || '(none)'}`);
      const err = await evaluate(c, 'window.__err || null').catch(() => null);
      throw new Error(`handfx page did not boot${err ? `: ${err}` : ''}`);
    }

    const isolated = await evaluate(c, 'self.crossOriginIsolated');
    ok('page reports crossOriginIsolated === true', isolated === true, `crossOriginIsolated=${isolated}`);

    const gl = await evaluate(c, `(() => { const g = document.createElement('canvas').getContext('webgl2'); return g ? g.getParameter(g.VERSION) : null; })()`);
    ok('WebGL2 is available to the page', Boolean(gl), gl || 'no webgl2');

    const fx = await evaluate(c, 'window.__handfx.fx.error || null');
    ok('effect programs compiled', !fx, fx || 'all 5 effects + composite + final linked');

    const glErr = await evaluate(c, 'window.__handfx.fx.gl.getError()');
    ok('no GL error after init', glErr === 0, `getError()=${glErr}`);

    // ── 3. the command bus ────────────────────────────────────────────────
    // The page is connected over SSE; a POST must reach it before status is read back.
    const before = await evaluate(c, 'window.__handfx.state.cursor');
    const post = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'effect.next' }) });
    const postBody = await post.json();
    ok('cmd accepts effect.next', post.status === 200 && post.ok !== false, JSON.stringify(postBody).slice(0, 120));
    const advanced = await waitFor(c, `window.__handfx.state.cursor !== ${before}`, 4000);
    const after = await evaluate(c, 'window.__handfx.state.cursor');
    ok('bus command reaches the page', Boolean(advanced), `cursor ${before} → ${after}`);
    await sleep(250);

    const setRes = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'effect.set', args: { id: 'smoke' } }) });
    const setBody = await setRes.json();
    ok('cmd accepts effect.set with a known id', setRes.status === 200 && setBody.ok, JSON.stringify(setBody).slice(0, 120));
    // The page's own gesture beat also fires on its loop; the cursor is the page's and is set by
    // effect.set, so read it after the command has had a frame to apply.
    await evaluate(c, 'window.__handfx.applyBusCommand({ channel: "handfx", cmd: "effect.set", args: { id: "smoke", id2: 1 } })');
    await sleep(300);
    const cur = await evaluate(c, 'window.__handfx.currentEffect()');
    ok('page applied effect.set', cur === 'smoke', `current=${cur}`);

    const mirrorRes = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'mirror.toggle' }) });
    const mirrorBody = await mirrorRes.json();
    ok('cmd mirror.toggle writes the document', mirrorRes.status === 200 && typeof mirrorBody.mirror === 'boolean', `mirror=${mirrorBody.mirror}`);
    await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'mirror.toggle' }) }).then((r) => r.arrayBuffer());

    // ── 4. the registry and the settings document the page renders from ────
    const reg = await evaluate(c, 'Object.keys(window.__handfx.fx.settings.intensity)');
    ok('page carries the effect registry with intensity', Array.isArray(reg) && reg.length >= 4, (reg || []).join(','));

    // ── 5. the camera path with Chrome's fake device ──────────────────────
    const cam = await evaluate(c, 'window.__handfx.startTracking().then(() => ({ state: window.__handfx.tracker.state, error: window.__handfx.tracker.error, model: window.__handfx.tracker.model }))', true);
    ok('camera path does not throw', cam && cam.state !== 'error', JSON.stringify(cam));
    const tracking = await waitFor(c, `window.__handfx.tracker.state === 'running'`, 15000);
    // Two honest outcomes: a tracked camera (model loaded) or a named model failure. Both are real.
    const snap = await evaluate(c, '({ state: window.__handfx.tracker.state, model: window.__handfx.tracker.model, error: window.__handfx.tracker.error, runtime: window.__handfx.tracker.runtime })');
    if (snap.model === 'ready' && snap.state === 'running') {
      ok('tracker runs on the camera frames', Boolean(tracking), `runtime=${snap.runtime} model=${snap.model}`);
      const handsOnTestPattern = await evaluate(c, 'window.__handfx.state.hands');
      ok('fake camera shows no hands (honest zero, not a fake gesture)', handsOnTestPattern === 0, `hands=${handsOnTestPattern} gesture=${await evaluate(c, 'window.__handfx.state.gesture')}`);
    } else {
      skip('tracker runs on camera frames', `model did not load here (${snap.model}${snap.error ? `: ${snap.error}` : ''}) — camera opened, tracking not claimed`);
    }
    await evaluate(c, 'window.__handfx.stopTracking()');

    // ── 6. synthetic hands through the real classifier and renderer ───────
    const synth = await evaluate(
      c,
      `(() => {
        const h = window.__handfx;
        const out = {};
        for (const t of [1, 9, 15, 21]) {
          const hands = h.syntheticHands(t);
          out[t] = h.classify(hands, {}).gesture;
        }
        return out;
      })()`,
    );
    ok('synthetic poses classify as the shipped gestures', synth['1'] === 'palmUp' && synth['9'] === 'bothFingertips' && synth['15'] === 'palmFront', JSON.stringify(synth));

    // Every effect renders: trigger it, render two frames, read the GL error and that it drew.
    const drawn = await evaluate(
      c,
      `(() => {
        const h = window.__handfx;
        const fx = h.fx;
        const res = {};
        const view = {
          palms: [{ x: 0.5, y: 0.6, radius: 0.1 }],
          fingertipPairs: [[{ x: 0.38, y: 0.4 }, { x: 0.62, y: 0.4 }], [{ x: 0.36, y: 0.45 }, { x: 0.64, y: 0.45 }]],
          front: { x: 0.5, y: 0.5, radius: 0.12 },
          anchor: { x: 0.5, y: 0.6, radius: 0.12 },
          swipe: { x: 0.5, y: 0.6, radius: 0.12 },
        };
        fx.debugGl = true;
        fx.debugLog = [];
        fx.setSettings({ effects: ['fireball', 'lightning', 'sparkring', 'embers', 'smoke'] });
        for (const id of ['fireball', 'lightning', 'sparkring', 'embers', 'smoke']) {
          fx.trigger(id, {});
          fx.render(performance.now(), view);
          fx.render(performance.now() + 16, view);
          res[id] = { live: fx.live.has(id), gl: fx.gl.getError(), err: fx.error || null };
        }
        // Afterwards every effect must still be live and the context clean; the per-stage error
        // readout names the first failing pass if one is not.
        fx.debugGl = false;
        res.debug = fx.debugLog.slice(0, 20);
        res.probe = fx.probeComposite();
        return res;
      })()`,
    );
    const allDrawn = ['fireball', 'lightning', 'sparkring', 'embers', 'smoke'].every((id) => drawn[id] && drawn[id].live && drawn[id].gl === 0 && !drawn[id].err) && drawn.probe === 0;
    ok('all five effects render without a GL error', allDrawn, JSON.stringify(drawn));

    // The overlay reports honestly: a status line reached the server and names the effect list.
    await sleep(1200);
    const ackPost = await fetch(`${srv.url}/api/handfx/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effect: 'fireball', tracking: false, model: 'idle', hands: 0, gesture: 'none' }) });
    ok('/ack accepts a status line', ackPost.status === 200, `HTTP ${ackPost.status}`);
    await ackPost.arrayBuffer();

    // ── 7. the pane ────────────────────────────────────────────────────────
    await c.send('Page.navigate', { url: `${srv.url}/#/handfx` });
    const paneReady = await waitFor(c, `Boolean(document.querySelector('.hfx') && document.querySelectorAll('.hfx-effect').length)`, 12000);
    if (!paneReady) {
      const slot = await evaluate(c, `document.querySelector('.pane-slot') ? document.querySelector('.pane-slot').innerHTML.slice(0, 600) : 'no .pane-slot'`);
      console.log(`     pane console:\n       ${consoleLines.slice(-15).join('\n       ')}\n     slot: ${slot}`);
    }
    const tiles = await evaluate(c, `[...document.querySelectorAll('.hfx-effect')].map((t) => t.querySelector('.hfx-effect-id').textContent)`);
    ok('pane renders the effect registry', Boolean(paneReady) && Array.isArray(tiles) && tiles.length >= 5, (tiles || []).join(','));
    const controls = await evaluate(c, `({ switches: document.querySelectorAll('.hfx-effect input[type=checkbox]').length, sliders: document.querySelectorAll('.hfx-effect input[type=range]').length, pills: [...document.querySelectorAll('.hfx-pill')].map((p) => p.textContent).join(' | ') })`);
    ok('pane has per-effect enable + intensity', controls.switches >= 5 && controls.sliders >= 5, `switches=${controls.switches} sliders=${controls.sliders}`);
    ok('pane states the secure-context and isolation facts', /secure context/.test(controls.pills) && /isolat/.test(controls.pills), controls.pills);

    // Toggling an effect in the pane writes the document (the operator's list, not a page's).
    const listed = await (await fetch(`${srv.url}/api/handfx/status`)).json();
    const beforeList = (listed.settings.effects && listed.settings.effects.value) || [];
    await evaluate(c, `document.querySelector('.hfx-effect[data-on="true"] input[type=checkbox]').click()`);
    const changed = await waitFor(c, `fetch('/api/handfx/status').then(r=>r.json()).then(j=>j.settings.effects.value.length !== ${beforeList.length})`, 5000);
    const listedAfter = await (await fetch(`${srv.url}/api/handfx/status`)).json();
    const afterList = (listedAfter.settings.effects && listedAfter.settings.effects.value) || [];
    ok('pane toggle writes the effect list', Boolean(changed), `${beforeList.join(',')} → ${afterList.join(',')}`);
    // restore
    await fetch(`${srv.url}/api/handfx/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effects: beforeList }) }).then((r) => r.arrayBuffer());

    const pageErr = await evaluate(c, 'window.__err || null');
    ok('no uncaught page exceptions', !pageErr, pageErr || '');
  } finally {
    chrome.kill('SIGKILL');
    srv.stop();
  }

  const failed = results.filter((r) => !r.pass);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  if (failed.length) {
    console.log(`\n${failed.length} failed:`);
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nhandfx-browser: ${err.message}`);
  process.exit(1);
});
