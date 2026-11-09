// The overlay draws even when its boot status read fails: the gate that stops a sixth recurrence.
//   node test/handfx-boot-status.mjs
//
// The signature has been "fixed" four times and come back every time: `/shockfx` paints nothing
// because boot put the first frame behind `GET /api/handfx/status`. Each fix moved the await; each
// later fix moved it back. This gate pins the contract from the page's own evidence, so a reorder
// that puts the loop behind the read fails here instead of in OBS:
//
//   · the page's phase list (inline bootstrap, `self.__handfxDiag.phaseList()`) contains
//     `loop-start`. It is emitted synchronously, before the boot's first await, so `first-ack` is
//     never the thing to look for — it can lag the bound and says nothing about the loop.
//   · `window.__handfx.state.draws` / `.loopTicks` advance across two samples a second apart. The
//     counters are the loop's own, exposed as the page's test hook, not scraped from the DOM.
//
// Four cases, the same two facts in each, plus one witness per case:
//   1 fail      /api/handfx/status -> 500            + a `boot-step` ring entry naming `boot status`
//   2 hang      /api/handfx/status never answers     + boot settles well inside the 8 s read bound,
//                                                      i.e. the 1500 ms boot bound actually bounded
//   3 control   /api/handfx/status -> a valid doc    + `state-loaded`, so a broken harness cannot
//                                                      pass as a working page
//   4 diag      a `phaseList` that throws            + `state.diagFails > 0` and the frame was
//                                                      re-armed before the throw, so the loop owns
//                                                      no death path through its diagnostics
//
// The stub server serves the real files from modules/handfx/pages, so the page under test is the
// shipped one. Only the status route is per-case; every other route answers fast and short (a 404
// build is "a build we could not read", never a mismatch and never a reload).
//
// Chrome: same launch path, flags and viewport as handfx-browser.mjs, including the SwiftShader
// pair. `--disable-gpu` is not passed: it has starved this stack of its WebGL2 context before and
// turned a real failure into a false pass.
//
// One browser, four documents, 10 s per case, teardown in `finally`. Exits non-zero on failure.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, CHROME } from './lib/chrome.mjs';

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'modules', 'handfx', 'pages');
const CASE_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
  return pass;
};

if (!CHROME) {
  console.log('skip handfx boot-status gate — no Chrome/Chromium found (set CHROME_PATH)');
  process.exit(0);
}
if (typeof globalThis.WebSocket !== 'function') {
  console.log('skip handfx boot-status gate — this Node has no global WebSocket (needs Node 22+)');
  process.exit(0);
}

/* ── the stub server: real files, one scripted status route ──────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// The boot's /status is 500, hangs, or is a valid document. `mode` is set per case, before the
// navigate, so there is no cross-case bleed to explain away.
let mode = 'control';
const hanging = new Set();

// The control document: what a healthy boot hands `applySettings`. `trackingSource: 'auto'` is
// deliberate — 'synthetic' would switch the rig on and pull the tracker into a gate that is only
// about the loop. `runtime.vendored` keeps the boot from raising the vendor banner.
const CONTROL_STATUS = {
  ok: true,
  enabled: true,
  runtime: { vendored: true },
  settings: { ratio: '16:9', trackingSource: 'auto' },
  tracking: { state: 'idle' },
};

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function serveStatic(pathname, res) {
  // The page carries <base href="/shockfx/">, so everything it loads arrives under that prefix.
  let rel = pathname;
  if (rel === '/shockfx' || rel === '/shockfx/') rel = '/overlay.html';
  else if (rel.startsWith('/shockfx/')) rel = rel.slice('/shockfx'.length);
  else return notFound(res);

  const file = path.resolve(PAGES, `.${decodeURIComponent(rel)}`);
  if (!file.startsWith(PAGES + path.sep)) return notFound(res);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-length': stat.size,
    // The page must boot cross-origin isolated exactly as the real server serves it, or the
    // WebGL/tracker path it is checking is not the one under test.
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function handler(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/handfx/status') {
    if (mode === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"error":"gate: status 500"}');
      return;
    }
    if (mode === 'hang') {
      // Headers are never written and the body never ends. The page's own AbortSignal is what has
      // to free this request; the gate destroys it at teardown.
      hanging.add(res);
      res.on('close', () => hanging.delete(res));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(CONTROL_STATUS));
    return;
  }

  // The ack is the page's beat: answer it, and answer it fast, so a stalled ack can never be what
  // this gate is measuring.
  if (p === '/api/handfx/ack') {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"ok":true}');
    return;
  }
  if (p === '/api/handfx/page-event') {
    req.resume();
    res.writeHead(204);
    res.end();
    return;
  }
  // A build we could not read is not a mismatch (build-check is written that way), so this can
  // never trigger the stale-bundle self-reload and turn the gate into a reload loop.
  if (p === '/api/handfx/build') return notFound(res);
  // 204 ends an EventSource for good instead of holding a socket and retrying every few seconds.
  if (p === '/events') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (p === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.resume();
    return notFound(res);
  }
  return serveStatic(p, res);
}

/* ── CDP: one page target, an evaluate that fails loudly ────────────────────────────────────── */

async function cdp(devtools) {
  const list = await (await fetch(`http://${new URL(devtools).host}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target from /json/list');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function evaluate(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) {
    const why = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
    throw new Error(`evaluate: ${why}`);
  }
  return r.result.value;
}

/** Poll the page until `expression` is truthy. 100 ms; the case deadline is the caller's. */
async function until(c, expression, ms, what) {
  const end = Date.now() + ms;
  let lastError = null;
  while (Date.now() < end) {
    try {
      if (await evaluate(c, expression)) return true;
    } catch (err) {
      lastError = err; // a navigate in flight has no execution context yet; retry
    }
    await sleep(100);
  }
  throw new Error(`${what}: not within ${ms} ms${lastError ? ` (${lastError.message})` : ''}`);
}

/** One failing case is reported, not fatal: the other two still run and say what they saw. */
async function attempt(name, fn) {
  try {
    return await fn();
  } catch (err) {
    ok(name, false, err.message);
    return null;
  }
}

function withDeadline(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: case exceeded ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ── the cases ──────────────────────────────────────────────────────────────────────────────── */

const COUNTERS = `(() => {
  const h = window.__handfx;
  return h ? { draws: h.state.draws, ticks: h.state.loopTicks, diagFails: h.state.diagFails } : null;
})()`;

// Case 4's shim. It has to be in place before the overlay module evaluates, which rules out
// anything installed after load. `Page.addScriptToEvaluateOnNewDocument` runs at document
// creation — but the page's own inline bootstrap then assigns `self.__handfxDiag = diag`
// unconditionally during parse, so a plain assignment here would be replaced and the case would
// silently prove nothing. A getter-only property makes that assignment a no-op in the bootstrap's
// non-strict script, and the module's `DIAG_METHODS.every(...)` predicate then selects this object.
//
// Only `phaseList` throws: that is the call `paintDiag()` makes every frame. `phase` stays a no-op
// on purpose — the module wraps it in `guardDiag`, a different (guarded) path.
//
// The rAF counter answers the ordering question the counters cannot: was the next frame scheduled
// BEFORE the diagnostic ran? With `requestAnimationFrame(loop)` first in the body the throw sees
// rafCalls one ahead of phaseListCalls; with the re-arm moved below `paintDiag()` it sees zero.
const DIAG_SHIM = `(() => {
  const raf = self.requestAnimationFrame.bind(self);
  let rafCalls = 0;
  let phaseListCalls = 0;
  self.requestAnimationFrame = (cb) => { rafCalls += 1; return raf(cb); };
  const shim = {
    clientId: 'gate-diag-shim',
    build: '',
    ring: [],
    phases: [],
    phase() {},
    report() {},
    setBuild() {},
    setClient() {},
    phaseList() {
      phaseListCalls += 1;
      const ahead = rafCalls - phaseListCalls;
      if (!(self.__diagOrderMax >= ahead)) self.__diagOrderMax = ahead;
      throw new Error('gate: shim phaseList throws');
    },
  };
  Object.defineProperty(self, '__handfxDiag', { get: () => shim, set: () => {}, configurable: false });
})();`;

async function runCase(c, base, name, runMode) {
  console.log(`\n${name}`);
  mode = runMode;
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(100);
  const t0 = Date.now();
  await c.send('Page.navigate', { url: `${base}/shockfx/` });

  // `loop-start` and "draws advance" used to be asserted here. A page that reaches the loop and
  // draws once satisfies both forever, so this gate stayed green while the deployed overlay was
  // frozen for 56 s: it could not fail on a dead page. The liveness claim now lives in
  // `test/handfx-browser.mjs` §5b, tied to the ack-freshness window the server itself publishes.
  // `phases` stays because case 3's control needs the `state-loaded` breadcrumb.
  const phases = await evaluate(c, 'self.__handfxDiag.phaseList()');

  // The hooks are installed at the end of boot, after its status await. A boot whose await never
  // bounded never gets here, so this wait is also the hang case's evidence.
  await until(c, 'Boolean(window.__handfx)', 5000, 'boot settled (window.__handfx)');
  const settledMs = Date.now() - t0;
  ok('boot settled inside the read bounds', settledMs < 5000, `${settledMs} ms`);

  return { settledMs, phases };
}

/**
 * Case 4: the phase list throws on every read. `loop-start` lives in that list, so it is not
 * available here; the counters, `state.diagFails` and the shim's ordering witness are the evidence.
 */
async function runDiagCase(c, base) {
  console.log('\ncase 4: a phaseList that throws');
  // The status document is healthy on purpose: the only failure in this case is the diagnostic.
  mode = 'control';
  await c.send('Page.navigate', { url: 'about:blank' });
  await sleep(100);
  await c.send('Page.navigate', { url: `${base}/shockfx/` });

  await until(c, 'Boolean(window.__handfx)', 5000, 'boot settled (window.__handfx)');
  await until(c, 'window.__handfx.state.loopTicks > 0', 3000, 'first loop tick');
  const first = await evaluate(c, COUNTERS);
  await sleep(1000);
  const second = await evaluate(c, COUNTERS);
  const ahead = await evaluate(c, 'self.__diagOrderMax');

  ok('loopTicks advance with a throwing phaseList', second.ticks > first.ticks, `${first.ticks} → ${second.ticks}`);
  ok('draws advance with a throwing phaseList', second.draws > first.draws, `${first.draws} → ${second.draws}`);
  // This is the honesty check: it proves the throw happened and was survived, rather than proving
  // nothing because the shim was never installed or never selected.
  ok(
    'the throw was survived, not skipped (diagFails > 0)',
    second.diagFails > 0,
    `diagFails ${first.diagFails} → ${second.diagFails}`,
  );
  // And this one says the loop owns no death path through its diagnostics: each frame re-armed the
  // next one before the throwing read. A re-arm moved below `paintDiag()` reads 0 here.
  ok('the next frame was scheduled before the diagnostic threw', ahead >= 1, `rAF ahead of paintDiag by ${ahead}`);
  return { first, second, ahead };
}

async function main() {
  let server;
  let chrome = null;
  let c = null;
  let base = '';
  try {
    server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;

    // Exactly the flags handfx-browser.mjs launches with. The SwiftShader pair is what gives this
    // stack a WebGL2 context; `--disable-gpu` is deliberately absent.
    chrome = await launchChrome({
      size: [1280, 720],
      profilePrefix: 'sb-chrome-',
      extraArgs: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    c = await cdp(chrome.devtools);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Page.bringToFront').catch(() => {});

    // 1 — the boot read fails with a server error.
    const failCase = await attempt('case 1: /api/handfx/status → 500', () =>
      withDeadline(runCase(c, base, 'case 1: /api/handfx/status → 500', 'fail'), CASE_MS, 'case 1'),
    );
    if (failCase) {
      const ring = await evaluate(c, 'self.__handfxDiag.ring.map((e) => e.kind + "|" + e.message)');
      const witness = ring.find((line) => line.startsWith('boot-step|') && /boot status/.test(line));
      ok('ring names the failed boot status read', Boolean(witness), witness || ring.join(' ; '));
    }

    // 2 — the boot read never answers. The bound must bound: the boot finishes on its own 1500 ms,
    // not on the 8 s default that a bare request would inherit.
    const hangCase = await attempt('case 2: /api/handfx/status hangs', () =>
      withDeadline(runCase(c, base, 'case 2: /api/handfx/status hangs', 'hang'), CASE_MS, 'case 2'),
    );
    if (hangCase) {
      ok('hang case settled well inside the 8 s read bound', hangCase.settledMs < 5000, `${hangCase.settledMs} ms`);
    }

    // 3 — control: a valid document. This has to pass before a fix is credited; a broken harness
    // that never served the page would fail here even though cases 1 and 2 look like proof.
    const ctl = await attempt('case 3: /api/handfx/status → valid document', () =>
      withDeadline(runCase(c, base, 'case 3: /api/handfx/status → valid document', 'control'), CASE_MS, 'case 3'),
    );
    if (ctl) {
      ok('control applied the status document', ctl.phases.includes('state-loaded'), ctl.phases.join(' → '));
    }

    // 4 — a diagnostic that throws, installed before the module can see it. paintDiag() reads the
    // phase list every frame; this is the call that used to strand the loop. The script is removed
    // afterwards so no later document can inherit it.
    const shim = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: DIAG_SHIM });
    try {
      await attempt('case 4: a phaseList that throws', () =>
        withDeadline(runDiagCase(c, base), CASE_MS, 'case 4'),
      );
    } finally {
      await c
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: shim.identifier })
        .catch(() => {});
    }
  } finally {
    try {
      c?.close();
    } catch {
      /* the browser may already be gone */
    }
    try {
      if (chrome) chrome.stop();
    } catch {
      /* stop() is idempotent and never throws by design; belt only */
    }
    // A hanging status response owns a socket that `close()` would otherwise wait on forever.
    for (const res of hanging) {
      try {
        res.destroy();
      } catch {
        /* already closed */
      }
    }
    hanging.clear();
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
  }

  if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed: the loop starts and draws whatever the boot status read does');
}

try {
  await main();
} catch (err) {
  // Launch refused (host busy, no gate lock) or the server could not bind: `finally` in main has
  // already torn everything down, so this is only the reason.
  console.log(`FAIL handfx boot-status gate — ${err.message}`);
  process.exit(1);
}
