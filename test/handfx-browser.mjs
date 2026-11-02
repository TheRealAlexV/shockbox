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
import { launchChrome, CHROME } from './lib/chrome.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
if (!CHROME) {
  console.error('handfx-browser: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

// The canonical effect ids, in the order the page's registry declares them. `handdebug` is the
// debug-overlay setting, not an effect, and is deliberately absent.
const CANON = ['fireball', 'lightning', 'sparkring', 'embers', 'smoke', 'aura', 'wires', 'frost', 'portal', 'disco', 'slime', 'inkflow', 'shatter', 'cyber', 'bloomlife', 'echo', 'bodyonfire', 'bodysmoke', 'frozenbody', 'edit', 'electroshock', 'meteor', 'shoot'];

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
      if (r.ok) {
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

/** A CDP session bound to one target id (a new tab), apart from the main page's session. */
async function cdpPage(devtools, targetId) {
  const ws = new WebSocket(`ws://${new URL(devtools).host}/devtools/page/${targetId}`);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
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
  // Fake camera: Chrome's own test-pattern device, so getUserMedia succeeds without a real one.
  // --use-fake-ui-for-media-stream answers the permission prompt the way a person would.
  const { devtools, stop: stopChrome } = await launchChrome({
    size: [1280, 720],
    profilePrefix: 'sb-chrome-',
    extraArgs: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const chromePort = new URL(devtools).port;
  const c = await cdp(devtools);
  const consoleLines = [];
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Log.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    // A ResizeObserver that notices a size change caused by its own callback is reported by Chrome
    // as an `error` event with this one message, and the browser recovers from it silently. It is a
    // layout ping-pong at worst, not a broken page, so the gate records the FIRST real exception
    // and lets this specific, self-healing report through.
    source: `window.addEventListener('error', function (e) {
               var m = (e && e.message) || 'error';
               if (/ResizeObserver loop/.test(m)) return;
               if (!window.__err) window.__err = m;
             });
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

    // The body page is its own small source; it must be served isolated too (wasm + SIMD), and its
    // files with it, or the page cannot boot.
    const bodyRes = await fetch(`${srv.url}/handfx/body`);
    const bodyCoi = { coop: bodyRes.headers.get('cross-origin-opener-policy'), coep: bodyRes.headers.get('cross-origin-embedder-policy') };
    const bodyHtml = await bodyRes.text();
    ok('body page is served cross-origin isolated', bodyRes.ok && bodyCoi.coop === 'same-origin' && bodyCoi.coep === 'require-corp' && /body\/main\.js/.test(bodyHtml), `${bodyRes.status} ${JSON.stringify(bodyCoi)}`);
    const bodyJs = await fetch(`${srv.url}/handfx/body/js/body/main.js`);
    const bodySrc = await bodyJs.text();
    ok('body page script serves and names the missing-model path', bodyJs.ok && /model missing/.test(bodySrc) && /BroadcastChannel/.test(bodySrc), `${bodyJs.status} ${bodySrc.length}B`);

    // The body page's two models: present on disk means the construct+segment+channel path must
    // run; absent means "model missing" stays the honest state, and that is all this file can check.
    const modelsEarly = (await (await fetch(`${srv.url}/api/handfx/status`)).json()).bodyModels || {};
    const modelsLocal = Boolean(modelsEarly.pose?.local && modelsEarly.segmenter?.local);
    if (!modelsLocal) {
      skip(
        'body page: models construct, segment and reach a peer over handfx.body',
        `body models are not on disk (pose=${modelsEarly.pose?.local ? 'local' : 'absent'}, segmenter=${modelsEarly.segmenter?.local ? 'local' : 'absent'}) — the page's "model missing" path is the shipped state here`,
      );
    } else {
      // Bytes are read from disk by the server; the test never touches the network for them.
      const poseBytes = await fetch(`${srv.url}/api/handfx/model?kind=pose`);
      const poseBuf = await poseBytes.arrayBuffer();
      const segBytes = await fetch(`${srv.url}/api/handfx/model?kind=segmenter`);
      const segBuf = await segBytes.arrayBuffer();
      const head = new Uint8Array(poseBuf.slice(0, 4));
      ok(
        'body models serve with the right bytes',
        poseBytes.status === 200 && segBytes.status === 200 && poseBuf.byteLength > 1_000_000 && segBuf.byteLength > 100_000 && head[2] === 0x50 && head[3] === 0x4b,
        `pose ${poseBuf.byteLength}B seg ${segBuf.byteLength}B pose-head=${Array.from(head).map((b) => b.toString(16)).join(' ')}`,
      );

      // Two same-origin documents: the body page itself, and a listener page that subscribes to
      // `handfx.body`. The listener must receive a mask bitmap the body page posted. `new?` PUT
      // (unlike Target.createTarget) hands back the target's real id for the session audit.
      // The listener is a fresh tab attached by its own session. `Target.createTarget` returns a
      // `targetId`, not the `TargetID` attach expects — attaching by it lands the session on
      // whatever tab is already open. `/json/new?about:blank` hands back the real target id.
      const listener = JSON.parse(await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).text());
      const listenerTarget = listener.id;
      const listenerWs = `ws://127.0.0.1:${chromePort}/devtools/page/${listenerTarget}`;
      const attach = { sessionId: null };
      {
        const lws = new WebSocket(listenerWs);
        let n = 0;
        const pending = new Map();
        lws.addEventListener('message', (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
          }
        });
        await new Promise((r, j) => {
          lws.addEventListener('open', r, { once: true });
          lws.addEventListener('error', j, { once: true });
        });
        const raw = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const id = ++n;
            pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
            lws.send(JSON.stringify({ id, method, params }));
          });
        attach.close = () => lws.close();
        attach.sessionId = 'listener';
        // The body page's own script is irrelevant here; only the channel listener is.
        const lc0 = { send: (method, params = {}) => raw(method, params), events: [], close: () => lws.close() };
        await lc0.send('Runtime.enable');
        await lc0.send('Page.enable');
        await lc0.send('Page.navigate', { url: `${srv.url}/handfx/body?listener=1` });
        for (let i = 0; i < 100; i++) {
          const st = await lc0.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          if (st.result.value === 'complete') break;
          await sleep(100);
        }
        await lc0.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
        await lc0.send('Runtime.evaluate', {
          expression: `window.__got = []; window.__bc = new BroadcastChannel('handfx.body');
            window.__bc.onmessage = (e) => { const m = e.data || {}; if (m.type === 'mask' && m.bitmap) window.__got.push({ w: m.bitmap.width, h: m.bitmap.height, at: m.at }); };`,
          returnByValue: true,
        });
        var lc = lc0;
      }

      // The body page is a separate document: open it here (the listener already has one open for
      // the channel, but the driven page must be the one this session evaluates in).
      await c.send('Page.navigate', { url: `${srv.url}/handfx/body?drive=1` });
      const bodyBooted = await waitFor(c, 'Boolean(window.__handfxBody)', 15000).catch(() => false);
      if (!bodyBooted) console.log(`     body page console:\n       ${consoleLines.slice(-12).join('\n       ')}\n     url=${await evaluate(c, 'location.href')}`);
      // Drive the body page directly (a real click is the operator's path; the module's Start is
      // the same call). The camera is Chrome's fake device, so pose/segment run on a test pattern:
      // the point is that they *run*, not that they find a body.
      // A headless tab opened behind another document is `visibilityState: hidden`, and a hidden
      // page does not run its rAF mask loop: without this the body page never posts, and the
      // failure would look like a broken channel. Focus emulation + an active lifecycle is what
      // makes the tab behave like the OBS source it stands in for.
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await c.send('Page.bringToFront').catch(() => {});
      await c.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await sleep(400);
      const bodyRun = await evaluate(
        c,
        `(async () => {
          const out = { models: null, pose: null, seg: null, sent: 0, error: null };
          const h = window.__handfxBody;
          if (!h) return { error: 'body page did not boot (no window.__handfxBody)' };
          // Both models construct in this same call (everything a thenable yields to, so a busy
          // loop would starve them): 20 s is the model load, not a race.
          await h.start();
          for (let i = 0; i < 200 && !(h.state.sent > 0); i++) await new Promise((r) => setTimeout(r, 100));
          out.pose = h.state.pose; out.seg = h.state.segmenter; out.sent = h.state.sent;
          out.error = h.state.error; out.running = h.state.running;
          out.status = document.getElementById('status').textContent;
          out.visibility = document.visibilityState;
          return out;
        })()`,
        true,
      );
      ok(
        'body page loads both models and posts masks',
        bodyRun.pose === 'ready' && bodyRun.seg === 'ready' && bodyRun.sent > 0 && bodyRun.running === true,
        JSON.stringify(bodyRun).slice(0, 300),
      );

      // Wait for the listener to see one; a BroadcastChannel that cannot cross documents is the
      // failure this check is for, so it gets a real timeout, not a retry loop forever.
      let received = null;
      // The listener lives in its own CDP session, so its evaluates go through that session.
      for (let i = 0; i < 60; i++) {
        const r = await lc.send('Runtime.evaluate', { expression: 'window.__got.length', returnByValue: true });
        if (r.result.value > 0) {
          const first = await lc.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__got[0])', returnByValue: true });
          received = JSON.parse(first.result.value);
          break;
        }
        await sleep(100);
      }
      ok('body mask arrives over BroadcastChannel(handfx.body)', Boolean(received && received.w > 0 && received.h > 0), received ? JSON.stringify(received) : 'no mask message within 6 s');


      // The overlay's own subscription path: a mask on the channel reaches fx.setBodyMask. The CDP
      // session's foreground tab runs the body page here, so the overlay goes in a separate tab
      // that keeps running (headless tabs behind the active one are throttled, so it is made
      // active by focus emulation — the same trick as the body page above).
      const overlayTab = JSON.parse(await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).text());
      const octl = await cdpPage(devtools, overlayTab.id);
      await octl.send('Page.enable');
      await octl.send('Runtime.enable');
      await octl.send('Page.navigate', { url: `${srv.url}/handfx` });
      for (let i = 0; i < 200; i++) {
        const r = await octl.send('Runtime.evaluate', { expression: 'Boolean(window.__handfx && window.__handfx.fx)', returnByValue: true });
        if (r.result.value) break;
        await sleep(100);
      }
      await octl.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await octl.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      // Keep the body page posting: this session's tab has been in the background since the
      // overlay tab opened, so focus it again and let the fake camera deliver a frame.
      await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await c.send('Page.bringToFront').catch(() => {});
      await c.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      let overlaySaw = false;
      for (let i = 0; i < 100; i++) {
        const r = await octl.send('Runtime.evaluate', { expression: 'Boolean(window.__handfx.fx.bodyMaskSeen)', returnByValue: true });
        if (r.result.value) {
          overlaySaw = true;
          break;
        }
        await sleep(100);
      }
      const maskUploaded = await octl.send('Runtime.evaluate', {
        expression: `(() => { const fx = window.__handfx.fx; if (!fx.bodyTex) return false; return { w: fx.bodyW, h: fx.bodyH, seen: fx.bodyMaskSeen }; })()`,
        returnByValue: true,
      }).then((r) => r.result.value).catch(() => false);
      ok('overlay page receives the mask and marks the body live', Boolean(overlaySaw && maskUploaded && maskUploaded.seen), `saw=${overlaySaw} mask=${JSON.stringify(maskUploaded)}`);
      ok('the mask reaches the renderer as a texture', Boolean(maskUploaded && maskUploaded.w > 0 && maskUploaded.h > 0), JSON.stringify(maskUploaded));
      await fetch(`${devtools}/json/close/${overlayTab.id}`).catch(() => {});
      octl.close();
      // The listener tab also runs the body page, so it posts a second stream on the channel; the
      // overlay would merge both and test nothing extra. Close it before the overlay check.
      await fetch(`${devtools}/json/close/${listenerTarget}`).catch(() => {});
      lc.close();
    }

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
    // The model URL the overlay is handed is a fallback, not a route the page takes when the
    // server has the file: a local copy must be what a page loads, and it must be reachable only
    // from this origin (the overlay is COEP require-corp, so an unlabelled cross-origin fetch of
    // the model would fail — and a CDN copy would not be offline at all).
    const modelCorp = modelRes.headers.get('cross-origin-resource-policy');
    const modelSourceHdr = modelRes.headers.get('x-handfx-model-source');
    if (local) {
      const buf = await modelRes.arrayBuffer();
      ok('local model serves', modelRes.ok && buf.byteLength > 1_000_000, `${modelRes.status} ${buf.byteLength}B`);
      // The bytes are the MediaPipe bundle the overlay expects: a .task is a zip whose first entry
      // is the model graph, so a PK header at offset 0 is the cheap, honest check.
      const head = Array.from(new Uint8Array(buf.slice(0, 4))).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      ok('local model is the MediaPipe .task bundle', head === '00 00 50 4b' && buf.byteLength === 7819105, `head=${head} bytes=${buf.byteLength}`);
      ok('local model is served same-origin (CORP) and says so', modelCorp === 'same-origin' && modelSourceHdr === 'local', `corp=${modelCorp} source=${modelSourceHdr}`);
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
    const snap = await evaluate(c, '({ state: window.__handfx.tracker.state, model: window.__handfx.tracker.model, error: window.__handfx.tracker.error, runtime: window.__handfx.tracker.runtime, modelSource: window.__handfx.tracker.modelSource })');
    // Which copy of the model the page used is not visible in the picture: `model: 'ready'` is
    // the same whether the bytes came from the module's file or storage.googleapis.com, and Cache
    // Storage made an old CDN copy indistinguishable from a local one. So the assertion is the
    // page's own account (tracker.modelSource, set by fetchModel) AND the browser's resource
    // timing: a same-origin /api/handfx/model entry, and no CDN entry at all.
    const usedModel = await evaluate(
      c,
      `(async () => {
        const h = window.__handfx;
        const res = performance.getEntriesByType('resource').map((e) => ({ name: e.name, initiator: e.initiatorType, transfer: e.transferSize }));
        // The page may have served the bytes from Cache Storage, which leaves no resource entry:
        // ask the cache what it holds for the model keys, and the tracker what it used.
        let cacheKeys = [];
        try {
          const cache = await caches.open('handfx:models-v1');
          cacheKeys = (await cache.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
        } catch { cacheKeys = []; }
        return {
          modelSource: h.tracker.modelSource,
          cdnEntries: res.filter((e) => /storage\\.googleapis|googleapis\\.com/.test(e.name)).map((e) => e.name),
          modelEntries: res.filter((e) => /\\/api\\/handfx\\/model/.test(e.name)).map((e) => e.name),
          taskEntries: res.filter((e) => /\\.task(\\?|$)/.test(e.name)).map((e) => e.name),
          cacheKeys,
        };
      })()`,
      true,
    );
    const src = usedModel.modelSource || {};
    ok(
      'overlay loads the LOCAL model file, not the CDN',
      src.from === 'local' && src.source === '/api/handfx/model' && usedModel.cdnEntries.length === 0 && usedModel.cacheKeys.every((k) => !/from=cdn/.test(k)),
      JSON.stringify({ from: src.from, source: src.source, cached: src.cached, bytes: src.bytes, cdn: usedModel.cdnEntries, cacheKeys: usedModel.cacheKeys, task: usedModel.taskEntries }),
    );
    ok(
      'the model request is same-origin (resource timing has no storage.googleapis.com entry)',
      usedModel.cdnEntries.length === 0 && (usedModel.modelEntries.length > 0 || src.cached === true),
      `model=${JSON.stringify(usedModel.modelEntries)} cdn=${JSON.stringify(usedModel.cdnEntries)} cached=${src.cached}`,
    );
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
    // The shell is where the pane mounts, so isolation has to hold on the shell's own document and
    // files: COOP/COEP on index.html alone is not enough — the module graph it boots
    // (`/src/shell.js` and its imports) is fetched inside the same isolated document, and an
    // isolated document that loads a non-isolated module graph does not boot at all.
    const shellDocs = {};
    for (const p of ['/', '/src/shell.js', '/src/ui.js', '/src/shell.css']) {
      const r = await fetch(`${srv.url}${p}`);
      shellDocs[p] = { ok: r.ok, coop: r.headers.get('cross-origin-opener-policy'), coep: r.headers.get('cross-origin-embedder-policy') };
      await r.arrayBuffer();
    }
    ok(
      'the shell document and its module graph are served cross-origin isolated',
      shellDocs['/'].ok && shellDocs['/'].coop === 'same-origin' && shellDocs['/'].coep === 'require-corp' &&
        shellDocs['/src/shell.js'].ok && shellDocs['/src/shell.js'].coop === 'same-origin' && shellDocs['/src/shell.js'].coep === 'require-corp',
      JSON.stringify(shellDocs),
    );

    await c.send('Page.navigate', { url: `${srv.url}/#/handfx` });
    const paneReady = await waitFor(c, `Boolean(document.querySelector('.hfx') && document.querySelectorAll('.hfx-effect').length)`, 12000);
    if (!paneReady) {
      const slot = await evaluate(c, `document.querySelector('.pane-slot') ? document.querySelector('.pane-slot').innerHTML.slice(0, 600) : 'no .pane-slot'`);
      console.log(`     pane console:\n       ${consoleLines.slice(-15).join('\n       ')}\n     slot: ${slot}`);
    }
    // The pane route, measured in the document the pane actually mounts in: it must report
    // crossOriginIsolated === true (a false there is what told the operator the pane's own tab was
    // not isolated), and it must have mounted with no isolation banner.
    const paneIso = await evaluate(c, `({ coi: self.crossOriginIsolated, secure: self.isSecureContext, banners: [...document.querySelectorAll('.hfx-banner')].map((b) => b.textContent) })`);
    ok('pane route reports crossOriginIsolated === true', paneIso.coi === true, `crossOriginIsolated=${paneIso.coi} banners=${JSON.stringify(paneIso.banners)}`);
    ok('pane mounts with no isolation banner', Boolean(paneReady) && paneIso.banners.every((t) => !/cross-origin isolated/i.test(t)), paneIso.banners.join(' | ') || 'no banners');
    const tiles = await evaluate(c, `[...document.querySelectorAll('.hfx-effect')].map((t) => t.querySelector('.hfx-effect-id').textContent)`);
    ok('pane renders the effect registry', Boolean(paneReady) && Array.isArray(tiles) && tiles.length >= 5, (tiles || []).join(','));
    const controls = await evaluate(c, `({ switches: document.querySelectorAll('.hfx-effect input[type=checkbox]').length, sliders: document.querySelectorAll('.hfx-effect input[type=range]').length, pills: [...document.querySelectorAll('.hfx-pill')].map((p) => p.textContent).join(' | ') })`);
    ok('pane has per-effect enable + intensity', controls.switches >= 5 && controls.sliders >= 5, `switches=${controls.switches} sliders=${controls.sliders}`);
    ok('pane states the secure-context and isolation facts', /secure context/.test(controls.pills) && /cross-origin isolated/.test(controls.pills), controls.pills);

    // ── 7a. the effect rows carry the engine's own names, never a rendered `undefined` ──
    // The registry the pane reads is `[{ id, title, gesture, from }]`. A row built from a bare id
    // list (what `Object.keys(FX)` is) renders the literal "nullnull" after every effect. This
    // checks the live browser: every rendered row has a real name, that name is the one the engine
    // declares, and nothing on the page says null/undefined.
    const rowText = await evaluate(c, `(() => {
      const tiles = [...document.querySelectorAll('.hfx-effect')];
      return {
        names: [...document.querySelectorAll('.hfx-effect-name')].map((n) => n.textContent),
        nullish: [...tiles].filter((t) => /^(null|undefined)+$|nullnull/.test(t.querySelector('.hfx-effect-top').textContent)).length,
        bodyHasNullnull: document.body.innerHTML.includes('nullnull'),
      };
    })()`);
    const servedReg = await (await fetch(`${srv.url}/api/handfx/status`)).json();
    const servedTitles = new Map((servedReg.effects || []).map((e) => [e.id, e.title]));
    const namesRight = rowText.names.length === CANON.length && rowText.names.every((n) => typeof n === 'string' && n.trim() && !/null|undefined/i.test(n));
    const titlesMatch = (servedReg.effects || []).every((e) => rowText.names.includes(e.title));
    ok(
      'pane effect rows show the engine names (no nullnull)',
      namesRight && titlesMatch && rowText.nullish === 0 && !rowText.bodyHasNullnull,
      `${rowText.names.length} names: ${rowText.names.slice(0, 4).join(' | ')}… nullish=${rowText.nullish} nullnull=${rowText.bodyHasNullnull}`,
    );
    // Where the names come from: `/effects` is a bare id list (strings, renderer order) and
    // `/status` carries the same ids with the engine's title. Both are pinned as served, so a pane
    // that started inventing labels would still fail here even with the rows looking right.
    const bareRes = await fetch(`${srv.url}/api/handfx/effects`);
    const bareList = await bareRes.json();
    ok(
      'the bare effect list is strings in renderer order',
      bareRes.status === 200 && Array.isArray(bareList) && bareList.length === CANON.length && bareList.every((id, i) => id === CANON[i]),
      `${Array.isArray(bareList) ? bareList.length : typeof bareList} ids: ${(bareList || []).slice(0, 4).join(',')}…`,
    );
    const servedShape = (servedReg.effects || []).every((e) => e && typeof e.id === 'string' && typeof e.title === 'string' && e.title.trim() && e.title !== e.id);
    ok('status carries the engine title for every effect', servedShape && servedTitles.size === CANON.length, `${servedTitles.size} titles, fireball → ${servedTitles.get('fireball')}`);

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

    // ── 8. the full registry: every id draws, history/snapshot/particles/edit work ──
    // Back to the overlay page (the pane navigation above left it).
    await c.send('Page.navigate', { url: `${srv.url}/handfx` });
    const overlayBack = await waitFor(c, 'Boolean(window.__handfx && window.__handfx.ready)', 12000);
    ok('overlay page boots again for the registry pass', Boolean(overlayBack), '');

    // A synthetic skeleton in field space, and a generated body mask (an ellipse "torso").
    await evaluate(c, `(() => {
      const h = window.__handfx;
      h.fx.setSettings({ effects: h.EFFECT_ORDER.slice() });
      const w = 96, ht = 72, data = new Uint8Array(w * ht * 4);
      for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) {
        const cx = (x / w - 0.5) * 2, cy = (y / ht - 0.5) * 2;
        const inside = (cx * cx) / 0.048 + (cy * cy) / 0.384 < 1 ? 255 : 0;
        const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = data[i + 3] = inside;
      }
      h.__testMask = h.fx.setBodyMask({ width: w, height: ht, data });
      h.__testView = {
        palms: [{ x: 0.5, y: 0.6, radius: 0.1 }],
        fingertipPairs: [[{ x: 0.38, y: 0.4 }, { x: 0.62, y: 0.4 }], [{ x: 0.36, y: 0.45 }, { x: 0.64, y: 0.45 }]],
        front: { x: 0.5, y: 0.5, radius: 0.12 },
        anchor: { x: 0.5, y: 0.6, radius: 0.12 },
        swipe: { x: 0.5, y: 0.6, radius: 0.12, dir: 1 },
        hands: [{ landmarks: h.syntheticHands(1)[0].landmarks.map((p) => ({ x: p.x, y: p.y })), palm: { x: 0.5, y: 0.6 }, handedness: 'Left' }],
      };
      return h.__testMask;
    })()`).then((maskOk) => ok('renderer accepts a synthetic body mask', maskOk === true, `setBodyMask=${maskOk}`));

    const registryPass = await evaluate(c, `(() => {
      const h = window.__handfx, fx = h.fx, view = h.__testView;
      fx.debugGl = true; fx.debugLog = [];
      const res = {};
      for (const id of h.EFFECT_ORDER) {
        fx.trigger(id, {});
        fx.render(performance.now(), view);
        fx.render(performance.now() + 16, view);
        res[id] = { live: fx.live.has(id), gl: fx.gl.getError(), err: fx.error || null };
      }
      fx.debugGl = false;
      return { res, errs: fx.debugLog.slice(0, 10), probe: fx.probeComposite(), count: h.EFFECT_ORDER.length };
    })()`);
    const ids = Object.keys(registryPass.res);
    const badIds = ids.filter((id) => !registryPass.res[id].live || registryPass.res[id].gl !== 0 || registryPass.res[id].err);
    // The page's registry is the canonical list; `handdebug` is a debug-overlay setting, not an
    // effect, so it must not be in it.
    ok(`every registry id draws without a GL error (${ids.length} ids)`, ids.length === CANON.length && ids.every((id, i) => id === CANON[i]) && badIds.length === 0 && registryPass.probe === 0, `bad=${JSON.stringify(badIds)} probe=${registryPass.probe} errs=${JSON.stringify(registryPass.errs)}`);

    // History path: inkflow and echo sample u_prev, so frame 2 must be non-zero where frame 1 was not.
    const history = await evaluate(c, `(() => {
      const h = window.__handfx, fx = h.fx, view = h.__testView;
      fx.setSettings({ effects: ['inkflow', 'echo'] });
      for (const id of ['inkflow', 'echo']) fx.release(id);
      fx.trigger('inkflow', { centre: { x: 0.5, y: 0.5, radius: 0.2 } });
      const px = () => { const b = new Uint8Array(4); fx.gl.readPixels(Math.floor(fx.w * 0.5), Math.floor(fx.h * 0.5), 1, 1, fx.gl.RGBA, fx.gl.UNSIGNED_BYTE, b); return [b[0], b[1], b[2], b[3]]; };
      fx.render(performance.now(), view);
      const a = px();
      fx.render(performance.now() + 400, view);
      fx.render(performance.now() + 800, view);
      const b = px();
      return { a, b, age: fx.historyAge };
    })()`);
    ok('inkflow history produces pixels by the second frame', history.b[3] > 0 || (history.a[3] > 0 && history.b[0] >= history.a[0]), `f1=${history.a} f3=${history.b}`);

    // Electroshock samples the snapshot: u_src bound, and a bright ring appears at u_radius.
    const shock = await evaluate(c, `(() => {
      const h = window.__handfx, fx = h.fx, view = h.__testView;
      fx.setSettings({ effects: ['electroshock'] });
      fx.release('electroshock');
      fx.trigger('electroshock', { centre: { x: 0.5, y: 0.5, radius: 0.2 } });
      // Fresh t0 so the ring is a few hundred ms old, not two minutes (the page's clock starts at
      // load; an effect triggered later must be aged against a t0 near now).
      fx.live.get('electroshock').t0 = performance.now();
      // A fresh t0 puts the shader at age ~0; the ring's radius runs with age (u_radius = expand
      // rate * age), so the frames must be aged forward from t0 for the ring to be anywhere.
      const t0 = fx.live.get('electroshock').t0;
      fx.render(t0, view);
      fx.render(t0 + 260, view);
      const gl = fx.gl;
      // The shockwave is a band on the shader's own front, and the renderer feeds
      // u_radius = 0.02 + age * 1.6 (fx.js, electroshock branch). By the second render (t0 + 260 ms)
      // that front is at ~0.44 field units from the anchor — near the frame edge, so probing the
      // centre or one fixed x can only ever read the hole. Read the whole frame instead, in field
      // units (x scaled by the aspect, as the shader does), and report where its alpha is.
      const age = fx.live.get('electroshock').age;
      const radius = 0.02 + age * 1.6;
      const aspect = fx.w / fx.h;
      const all = new Uint8Array(fx.w * fx.h * 4);
      gl.readPixels(0, 0, fx.w, fx.h, gl.RGBA, gl.UNSIGNED_BYTE, all);
      let lit = 0;
      let minFront = Infinity;
      let brightest = 0;
      const anchor = 0.5;
      for (let y = 0; y < fx.h; y++) {
        for (let x = 0; x < fx.w; x++) {
          const a = all[(y * fx.w + x) * 4 + 3];
          if (!a) continue;
          lit++;
          if (a > brightest) brightest = a;
          const dx = ((x + 0.5) / fx.w - anchor) * aspect;
          const dy = (y + 0.5) / fx.h - anchor;
          const r = Math.hypot(dx, dy);
          if (r < minFront) minFront = r;
        }
      }
      return {
        live: fx.live.has('electroshock'),
        gl: gl.getError(),
        snap: Boolean(fx.snapTex),
        radius: Math.round(radius * 1000) / 1000,
        lit,
        brightest,
        innerEdge: minFront === Infinity ? null : Math.round(minFront * 1000) / 1000,
      };
    })()`);
    // Live + snapshot + clean context are the *binding* claims. The art claim is "the shockwave is
    // sampled from the scene and drawn on — never inside — its front": pixels exist, the brightest
    // is real, and nothing is lit inside u_radius (a shockwave starts at its front; a filled disc
    // would light the centre too).
    ok(
      'electroshock draws from the scene snapshot',
      shock.live &&
        shock.gl === 0 &&
        shock.snap &&
        shock.lit > 0 &&
        shock.brightest > 0 &&
        shock.innerEdge !== null &&
        shock.innerEdge >= shock.radius - 0.05,
      JSON.stringify(shock),
    );

    // Particles: a burst increments the store, and one render integrates + draws them.
    const parts = await evaluate(c, `(() => {
      const h = window.__handfx, fx = h.fx;
      const before = fx.particleCount();
      const n = h.spawnShoot(h.__testView);
      fx.render(performance.now(), h.__testView);
      return { before, n, after: fx.particleCount() };
    })()`);
    ok('shoot burst spawns particles', parts.n > 0 && parts.after >= parts.n, JSON.stringify(parts));

    // Edit canvas: a stroke stamps pixels, clear wipes them.
    const edit = await evaluate(c, `(() => {
      const h = window.__handfx, fx = h.fx;
      fx.setSettings({ effects: ['edit'] });
      fx.trigger('edit', {});
      const gl = fx.gl, b = new Uint8Array(4);
      const begin = fx.editBegin(0.4, 0.4); const moved = fx.editMove(0.6, 0.5); fx.editEnd();
      // The stroke is on the edit canvas, not the scene: read the canvas (the scene would only
      // show it through the composite, which a 0.5 s fade can dim). The canvas is RGBA8, and
      // readPixels counts from its bottom-left, so a scan of the whole buffer is the honest
      // count — the stroke's exact pixel row depends on the page's aspect.
      const canvas = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fx.edit.fbo);
        const all = new Uint8Array(fx.w * fx.h * 4);
        gl.readPixels(0, 0, fx.w, fx.h, gl.RGBA, gl.UNSIGNED_BYTE, all);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        let lit = 0;
        for (let i = 3; i < all.length; i += 4) if (all[i] > 0) lit++;
        return lit;
      };
      const stamped = canvas();
      h.applyBusCommand({ channel: 'handfx', cmd: 'edit.clear', args: {} });
      const cleared = canvas();
      fx.render(performance.now(), h.__testView);
      return { begin, moved, stamped, cleared, gl: gl.getError() };
    })()`);
    ok('edit stamps pixels and edit.clear wipes them', edit.stamped > 0 && edit.cleared < edit.stamped && edit.gl === 0, JSON.stringify(edit));

    // Body effects never draw without a mask (a fresh renderer path cannot be faked here, so the
    // check is that the mask is required: bind nothing and the effect reports it drew nothing).
    const noMask = await evaluate(c, `(() => {
      const h = window.__handfx, fx = h.fx;
      const saved = fx.bodyMaskSeen;
      fx.bodyMaskSeen = false;
      fx._resize();
      fx.release('bodyonfire');
      fx.trigger('bodyonfire', {});
      const live = fx.live.get('bodyonfire') || { centre: { x: 0.5, y: 0.5 }, radius: 0.1, energy: 1, fade: 1, age: 0.2 };
      const drewWithMask = fx._drawEffect('bodyonfire', live, h.__testView, 1);
      fx.bodyMaskSeen = saved;
      return { hasMask: Boolean(fx.bodyTex), drewWithMask };
    })()`);
    ok('body effects draw nothing without a mask', noMask.hasMask === true && noMask.drewWithMask === false, JSON.stringify(noMask));

    // ── 9. the server accepts the full id set, and the new commands ─────────
    const allStatus = await (await fetch(`${srv.url}/api/handfx/status`)).json();
    const servedIds = (allStatus.effects || []).map((e) => e.id);
    ok('status serves the full registry (handdebug excluded)', servedIds.length === CANON.length && servedIds.every((id, i) => id === CANON[i]) && !servedIds.includes('handdebug'), servedIds.join(','));
    let acceptAll = true;
    const refused = [];
    for (const id of servedIds) {
      const r = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'effect.set', args: { id } }) });
      const j = await r.json();
      if (!(r.status === 200 && j.ok)) { acceptAll = false; refused.push(id); }
    }
    ok(`cmd effect.set accepts all ${servedIds.length} registry ids`, acceptAll, refused.length ? `refused: ${refused.join(',')}` : '');
    const unknown = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'effect.set', args: { id: 'definitely-not-an-effect' } }) });
    ok('cmd effect.set rejects an unknown id', unknown.status === 400, `HTTP ${unknown.status}`);
    await unknown.arrayBuffer();
    const fire = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'projectile.fire', args: { skin: 'heart' } }) });
    const fireBody = await fire.json();
    ok('cmd projectile.fire is published', fire.status === 200 && fireBody.ok && fireBody.seq > 0, JSON.stringify(fireBody).slice(0, 120));
    const badSkin = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'projectile.fire', args: { skin: 'banana' } }) });
    ok('cmd projectile.fire refuses an unknown skin', badSkin.status === 400, `HTTP ${badSkin.status}`);
    await badSkin.arrayBuffer();
    const clear = await fetch(`${srv.url}/api/handfx/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'edit.clear' }) });
    ok('cmd edit.clear is published', clear.status === 200 && (await clear.json()).ok, '');
    const bodyStat = await fetch(`${srv.url}/api/handfx/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'body', open: true }) });
    ok('ack accepts the body page beat', bodyStat.status === 200, `HTTP ${bodyStat.status}`);
    await bodyStat.arrayBuffer();
    const maskAck = await fetch(`${srv.url}/api/handfx/ack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effect: 'bodyonfire', tracking: false, maskAt: Date.now() }) });
    await maskAck.arrayBuffer();
    const withBody = await (await fetch(`${srv.url}/api/handfx/status`)).json();
    ok('status reports a body mask timestamp, no frames', Boolean(withBody.body && withBody.body.lastMaskAt > 0 && withBody.body.pageOpen === true), JSON.stringify(withBody.body));

    // ── 10. the pane renders the 25 entries, skins and the body row ────────
    await c.send('Page.navigate', { url: `${srv.url}/#/handfx` });
    await waitFor(c, `Boolean(document.querySelector('.hfx') && document.querySelectorAll('.hfx-effect').length)`, 12000);
    const paneAll = await evaluate(c, `({
      tiles: [...document.querySelectorAll('.hfx-effect')].map((t) => t.querySelector('.hfx-effect-id').textContent),
      gestures: [...document.querySelectorAll('.hfx-effect .hfx-note')].map((n) => n.textContent).filter((t) => /gesture:/.test(t)).length,
      skins: document.querySelectorAll('.hfx-effect select').length,
      bodyRow: [...document.querySelectorAll('.hfx-pill')].map((p) => p.textContent).join(' | '),
      fireBtn: [...document.querySelectorAll('button')].some((b) => /projectile\\.fire/.test(b.textContent)),
      clearBtn: [...document.querySelectorAll('button')].some((b) => /edit\\.clear/.test(b.textContent)),
    })`);
    ok(`pane renders all ${CANON.length} registry ids with gestures`, paneAll.tiles.length === CANON.length && paneAll.gestures >= CANON.length, `${paneAll.tiles.length} tiles, ${paneAll.gestures} gestures`);
    ok('pane shows the shoot skin and the body row', paneAll.skins >= 1 && /mask|body/i.test(paneAll.bodyRow) && paneAll.fireBtn && paneAll.clearBtn, JSON.stringify({ skins: paneAll.skins, row: paneAll.bodyRow.slice(0, 120) }));

    // The command path end to end: POST /cmd with an effect list has to *change the document*,
    // not just answer `{ok:true}`. (This was the defect: the route validated and published but
    // never wrote settings, so /status kept reporting the five defaults.)
    const srvOrigin = new URL(srv.url);
    const api = (path, body) => new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: srvOrigin.hostname, port: srvOrigin.port, path, method: payload ? 'POST' : 'GET', headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
    const want = CANON.slice(0, 3);
    const listRes = await api('/api/handfx/cmd', { cmd: 'effect.set', args: { value: want } });
    const statusAfterSet = await api('/api/handfx/status');
    const got = statusAfterSet.json?.settings?.effects?.value;
    ok('effect.set writes the effect list (not only {ok:true})', listRes.status === 200 && listRes.json?.ok === true && JSON.stringify(got) === JSON.stringify(want), JSON.stringify({ status: listRes.status, got }));
    const allRes = await api('/api/handfx/cmd', { cmd: 'effect.set', args: { value: CANON } });
    const afterAll = await api('/api/handfx/status');
    ok('effect.set accepts all ' + CANON.length + ' registry ids', allRes.status === 200 && (afterAll.json?.settings?.effects?.value || []).length === CANON.length, `${allRes.status}`);
    const badRes = await api('/api/handfx/cmd', { cmd: 'effect.set', args: { value: ['not_an_effect'] } });
    ok('effect.set rejects an unknown id and keeps the list', badRes.status === 400 && JSON.stringify((await api('/api/handfx/status')).json?.settings?.effects?.value) === JSON.stringify(CANON), `${badRes.status} ${badRes.json?.error || ''}`);

    const pageErr = await evaluate(c, 'window.__err || null');
    ok('no uncaught page exceptions', !pageErr, pageErr || '');
    // The pane is the last document this session looked at, and the console lines were collected
    // from it throughout: a pane that mounts isolated but logs an isolation, CORP or module error
    // is a broken pane with a passing header. Only errors count — warnings and GL info are noise.
    const paneConsoleErrors = consoleLines.filter((l) => /^(error|log error|log severe):/.test(l) && !/favicon/.test(l));
    ok('pane mounts with no console errors', paneConsoleErrors.length === 0, paneConsoleErrors.slice(-3).join(' | ') || 'none');
  } finally {
    stopChrome();
    await new Promise((r) => setTimeout(r, 150));
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
