// The notification / alert sound path end to end: the clip store on the server, and the two
// overlays that play from it.
//
// Server half (no browser): a sound directory made in a temp dir with a real (tiny, valid) WAV.
//   · /api/{notifications,dialogs}/audio/list lists it
//   · /audio/<name> serves it with audio/wav
//   · a name containing `..`, a separator, or an illegal extension is refused
//   · a missing directory → empty list, and /audio/<name> 404s with a message
//   · PATCH settings refuses a tone that is not on disk
// Browser half (headless Chrome, --autoplay-policy=no-user-gesture-required): each module page
// is loaded as itself — its own module script, its own SSE — byte-for-byte as the server serves
// it. The page's asset URLs are the real ones, so a page that cannot load its own CSS/JS fails
// here instead of being propped up. The player is created with
// `{instrument:true}`, which records every element it builds and every play() it issues, so the
// test asserts on the player's own record, never on audio output:
//   · a page load over an existing banner plays nothing (the first payload seeds the page)
//   · a new spawn during the session builds exactly one element and plays once
//   · sound:false never plays again and the strip still renders
//
//   node test/sound.mjs              # boots its own server and Chrome
//   node test/sound.mjs --keep       # leave the temp dirs behind

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, CHROME } from './lib/chrome.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const KEEP = process.argv.includes('--keep');

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A 0.1 s, 8 kHz, mono, 8-bit PCM WAV — the smallest thing every browser will decode. */
function tinyWav() {
  const rate = 8000;
  const n = Math.floor(rate * 0.1);
  const buf = Buffer.alloc(44 + n);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin((i / rate) * 2 * Math.PI * 440));
  return buf;
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

async function startServer(soundsDir) {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sound-state-'));
  const args = [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir];
  if (soundsDir !== undefined) args.push('--sounds', soundsDir);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stop: () => child.kill('SIGTERM'), log, stateDir };
    } catch {
      /* starting */
    }
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start:\n${log.join('')}`);
}

function startChrome() {
  return launchChrome({
    size: [405, 720],
    profilePrefix: 'sb-sound-chrome-',
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--mute-audio'],
  });
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
    } else if (msg.method) events.push(msg);
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
    async waitFor(expr, ms = 8000) {
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

// Records every Audio the page builds and every play() it calls: the overlays pass
// `{instrument:true}` to their player, which maintains `window.__pageAudio`; this hook only
// makes the independent check below possible (a play() the player did not count shows the bug).
const INSTRUMENT = String.raw`
  (function () {
    window.addEventListener('error', function (e) {
      var t = e.target;
      var what = t && t !== window ? (t.tagName + ' ' + (t.src || t.href || '')) : (e.message || 'window-error');
      window.__loadErr = (window.__loadErr || '') + ' | ' + what;
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      window.__loadErr = (window.__loadErr || '') + ' REJ ' + String((e.reason && e.reason.message) || e.reason);
    });
  })();
`;
const STATUS = `JSON.stringify(window.__pageAudio ? {
  // Elements are counted in full: one clip is preloaded at page load and reused for every
  // play, so the element count proves one element and the play count proves the firings.
  els: window.__pageAudio.els.length,
  plays: window.__pageAudio.plays - (window.__base ? window.__base.plays : 0),
  srcs: window.__pageAudio.els.map(function (e) { return e.getAttribute('src'); })
} : { els: 0, plays: 0, srcs: [], noPlayer: true })`;
/**
 * Load a module page. Chrome runs it exactly as a browser source would: the module page,
 * its own `<script type="module">` imports, its own SSE. Nothing here re-writes the document
 * or re-evaluates the overlay — the measurement is of the real page.
 *
 * The only thing installed before navigation is the instrumentation: the player exposes its
 * record under `window.__pageAudio` when it is built with `{instrument:true}`, and a wrapper
 * counts calls to the native `HTMLMediaElement.play` so a play that the player never issued
 * cannot be mistaken for one it did.
 */
async function open(c, url, origin, proxy) {
  const t = origin;
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  const pagePath = new URL(url).pathname;
  const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
  // Serve the page from the test's own origin under the page's path, byte-for-byte as the
  // server serves it: the page names its assets root-relative (`/notify/app.js`), so the browser
  // asks the proxy for exactly the URL a real OBS browser source asks for. Everything else (the
  // SSE stream, `/api/*`, `/audio/*`) goes to the real server through the proxy.
  await c.send('Page.navigate', { url: `${proxy.origin}${pagePath}${hash}` });
  await sleep(1800);

  const exc = c.events.filter((e) => e.method === 'Runtime.exceptionThrown').slice(-3).map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  const cerr = c.events.filter((e) => e.method === 'Runtime.consoleAPICalled').slice(-3).map((e) => (e.params.args || []).map((a) => a.value || a.description).join(' '));
  if (!(await c.waitFor('!!window.__pageAudio', 15000))) {
    const why = await c.send('Runtime.evaluate', { expression: 'String(window.__loadErr || document.readyState)', returnByValue: true });
    throw new Error(`page ${url} did not announce its player (${JSON.stringify(why.result)})`);
  }
  // The module's own first paint is an HTTP read; the baseline is taken after it, so what the
  // page preloaded is visible and nothing has played yet.
  await c.send('Runtime.evaluate', {
    expression: `window.__base = { plays: window.__pageAudio.plays };`,
    returnByValue: true,
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sounds-'));
const WAV = 'tiny tone.wav'; // a space in the name: legal, and encoded by the player
fs.writeFileSync(path.join(dir, WAV), tinyWav());
fs.writeFileSync(path.join(dir, 'readme.txt'), 'not a clip');

const srv = await startServer(dir);
const missing = await startServer(path.join(dir, 'no-such-dir'));

/**
 * The page origin the browser half loads from. It forwards every request to the real server
 * untouched — no `<base>`, no rewriting of a page or a module source — so the browser asks for the
 * exact URLs a real OBS browser source asks for and a page that names its CSS/JS/module wrongly
 * fails here instead of being propped up. The SSE stream is forwarded unbuffered.
 */
async function startPageProxy(upstream) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/events') {
      const up = http.request({ host: '127.0.0.1', port: new URL(upstream).port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
        r.pipe(res); // stream, never buffer: an SSE proxy must forward as it arrives
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: new URL(upstream).port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())) };
}
const proxy = await startPageProxy(srv.url);
let chrome = null;
let c = null;
try {
  /* ------------------------------------------------------------ server: list */

  const t = srv.url;
  const nl = await fetch(`${t}/api/notifications/audio/list`).then((r) => r.json());
  ok('notifications lists the clips in the sound directory', nl.ok === true && nl.files.includes(WAV), JSON.stringify(nl.files));
  ok('the list omits files that are not clips', !nl.files.includes('readme.txt'), nl.files.join(', '));
  const dl = await fetch(`${t}/api/dialogs/audio/list`).then((r) => r.json());
  ok('dialogs lists the same clips', dl.ok === true && JSON.stringify(dl.files) === JSON.stringify(nl.files), dl.dir);
  ok('both modules report the same directory', dl.dir === dir && nl.dir === dir, `${nl.dir} / ${dl.dir}`);

  /* ---------------------------------------------------------- server: serving */

  const s1 = await fetch(`${t}/audio/${encodeURIComponent(WAV)}`);
  const body = Buffer.from(await s1.arrayBuffer());
  ok('/audio/<name> serves the clip as audio/wav', s1.status === 200 && s1.headers.get('content-type') === 'audio/wav', `${s1.status} ${s1.headers.get('content-type')}`);
  ok('the served clip is byte-identical', body.equals(fs.readFileSync(path.join(dir, WAV))), `${body.length} bytes`);
  const s2 = await fetch(`${t}/audio/${encodeURIComponent(WAV)}`, { method: 'HEAD' });
  ok('HEAD /audio/<name> answers without a body', s2.status === 200 && Number(s2.headers.get('content-length')) === body.length, `${s2.status} ${s2.headers.get('content-length')}`);

  /* --------------------------------------------------------- server: refusals */

  const bad = ['..%2Fx.wav', '%2E%2E%2Fsecret.wav', '..%5Cx.wav', 'sub%2Fx.wav', 'sub%5Cx.wav', 'x..wav'];
  for (const name of bad) {
    const r = await fetch(`${t}/audio/${name}`);
    ok(`refused: /audio/${name}`, r.status === 403 || r.status === 404, `${r.status} ${(await r.json()).error}`);
  }
  const ext = await fetch(`${t}/audio/readme.txt`);
  ok('refused: a name without a clip extension', ext.status === 404, String(ext.status));
  const abs = await fetch(`${t}/audio/${encodeURIComponent(path.join(dir, WAV))}`);
  ok('refused: an absolute path as the name', abs.status === 403 || abs.status === 404, String(abs.status));

  /* ---------------------------------------------------- server: absent dir */

  const ml = await fetch(`${missing.url}/api/notifications/audio/list`);
  const mlj = await ml.json();
  ok(
    'missing directory → empty list with a message',
    ml.status === 200 && mlj.ok === true && mlj.available === false && Array.isArray(mlj.files) && mlj.files.length === 0 && /cannot read|configured/.test(mlj.error),
    `${ml.status} ${JSON.stringify(mlj)}`,
  );
  const ma = await fetch(`${missing.url}/audio/${encodeURIComponent(WAV)}`);
  const maj = await ma.json();
  ok('missing directory → /audio 404 with a message', ma.status === 404 && /no clip .* in /.test(maj.error), `${ma.status} ${maj.error}`);

  /* --------------------------------------------------- server: tone settings */

  const okPatch = await fetch(`${t}/api/notifications/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tone: WAV }),
  }).then((r) => r.json());
  ok('a tone that exists is accepted', okPatch.ok === true && okPatch.settings.tone.value === WAV, JSON.stringify(okPatch.changed));
  const badPatch = await fetch(`${t}/api/notifications/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tone: 'nope.mp3' }),
  });
  ok('a tone that does not exist is refused', badPatch.status === 400, `${badPatch.status} ${(await badPatch.json()).error}`);
  const badDialogs = await fetch(`${t}/api/dialogs/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tone: '../evil.mp3' }),
  });
  ok('dialogs refuses a traversing tone', badDialogs.status === 400, String(badDialogs.status));
  await fetch(`${t}/api/dialogs/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tone: WAV }) });

  /* ------------------------------------------------------------- browser */

  if (!CHROME) {
    console.log('no chrome/chromium found — browser half skipped (set CHROME=)');
  } else {
    chrome = await startChrome();
    c = connect(chrome.wsUrl);
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    // Before the first navigation: a 405×720 viewport, so the overlays lay out at their real
    // OBS size. The Audio instrumentation goes in per page, in `open()`.
    await c.send('Emulation.setDeviceMetricsOverride', { width: 405, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Network.enable');
    c.events.length = 0;
    const spawnNotify = (text) =>
      fetch(`${t}/api/notifications/live`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: { text } }),
      }).then((r) => r.json());
    const spawnDialog = (text) =>
      fetch(`${t}/api/dialogs/live`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: { text } }),
      }).then((r) => r.json());

    /* notifications overlay: seed over one existing banner, then one new one */

    await fetch(`${t}/api/notifications/live`, { method: 'DELETE' });
    await spawnNotify('already on the strip');
    await open(c, `${t}/notify#notification`, t, proxy);
    await sleep(500);
    const seeded = JSON.parse((await c.eval(STATUS)) || 'null');
    ok('notifications: a page load over an existing banner plays nothing', seeded && seeded.plays === 0, JSON.stringify(seeded));

    await spawnNotify('a new one');
    await sleep(600);
    await sleep(500);
    await c.waitFor('document.querySelectorAll("#stage .toast").length === 2', 8000);
    await sleep(400);

    const afterOne = JSON.parse((await c.eval(STATUS)) || 'null');
    ok('notifications: a new spawn builds exactly one Audio element', afterOne && afterOne.els === 1, JSON.stringify(afterOne));
    ok('notifications: a new spawn calls play() once', afterOne && afterOne.plays === 1, JSON.stringify(afterOne));
    ok('notifications: the element points at the configured tone', afterOne && afterOne.srcs && afterOne.srcs[0] === `/audio/${encodeURIComponent(WAV)}`, afterOne && afterOne.srcs);

    await fetch(`${t}/api/notifications/live`, { method: 'DELETE' });
    await sleep(400);
    await spawnNotify('second new one');
    await c.waitFor('document.querySelectorAll("#stage .toast").length === 1', 8000);
    await sleep(400);
    const afterTwo = JSON.parse((await c.eval(STATUS)) || 'null');
    ok('notifications: a second spawn reuses the one element and plays again', afterTwo && afterTwo.els === 1 && afterTwo.plays === 2, JSON.stringify(afterTwo));

    /* sound:false */

    await fetch(`${t}/api/notifications/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sound: false }) });
    await sleep(400);
    await spawnNotify('silent one');
    await c.waitFor('document.querySelectorAll("#stage .toast").length === 2', 8000);
    await sleep(400);

    const off = JSON.parse((await c.eval(STATUS)) || 'null');
    ok('notifications: sound:false builds nothing and plays nothing', off && off.plays === 2, JSON.stringify(off));
    await fetch(`${t}/api/notifications/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sound: true }) });
    await fetch(`${t}/api/notifications/live`, { method: 'DELETE' });

    /* dialogs overlay: same contract, dialog tone */

    await fetch(`${t}/api/dialogs/live`, { method: 'DELETE' });
    await spawnDialog('already open');
    await open(c, `${t}/dialogs#dialog`, t, proxy);
    await fetch(`${t}/api/dialogs/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: { text: 'probe' } }) });
    await sleep(600);
    await c.waitFor('document.querySelectorAll("#desk .dialog").length === 1', 8000);
    await sleep(500);
    const dSeeded = JSON.parse((await c.eval(STATUS)) || 'null');

    ok('dialogs: a page load over an open alert plays nothing', dSeeded && dSeeded.plays === 0, JSON.stringify(dSeeded));
    await spawnDialog('a new alert');
    await c.waitFor('document.querySelectorAll("#desk .dialog").length === 2', 8000);
    await sleep(400);
    const dOne = JSON.parse((await c.eval(STATUS)) || 'null');
    ok('dialogs: a new alert builds exactly one Audio element', dOne && dOne.els === 1, JSON.stringify(dOne));
    ok('dialogs: a new alert calls play() once', dOne && dOne.plays === 1, JSON.stringify(dOne));
    ok('dialogs: the element points at the configured tone', dOne && dOne.srcs && dOne.srcs[0] === `/audio/${encodeURIComponent(WAV)}`, dOne && dOne.srcs);

    /* a measure re-send must not re-announce an alert */

    const firstId = (await fetch(`${t}/api/dialogs/live`).then((r) => r.json())).live[0].id;
    await fetch(`${t}/api/dialogs/live/measure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: firstId, w: 300, h: 140 }),
    });
    await sleep(500);
    const dMeasured = JSON.parse((await c.eval(STATUS)) || 'null');
    ok('dialogs: a measure frame does not play the tone again', dMeasured && dMeasured.plays === 1, JSON.stringify(dMeasured));

    const consoleErrors = c.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
    ok('no console errors in either overlay', consoleErrors.length === 0, consoleErrors.map((e) => (e.params.args || []).map((a) => a.value || a.description).join(' ')).slice(0, 2).join(' | '));
  }
} catch (err) {
  ok('sound harness ran without throwing', false, err.message);
} finally {
  c?.close();
  chrome?.stop();
  srv.stop?.();
  missing.stop?.();
  proxy.stop?.();
  await sleep(200);
  if (!KEEP) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(srv.stateDir, { recursive: true, force: true });
      fs.rmSync(missing.stateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
