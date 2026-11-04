// End-to-end API checks for the popup modules.
//   node test/api-smoke.mjs                          # boots its own server on a free port
//   node test/api-smoke.mjs http://127.0.0.1:8977    # or drive a running one
// Exits non-zero on the first failed assertion so it is usable as a gate.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let stop = () => {};
let base = process.argv[2] || '';
if (!base) {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-api-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  stop = () => child.kill('SIGTERM');
  base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    await sleep(200);
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      /* starting */
    }
  }
  if (!up) {
    stop();
    console.error('api-smoke: server did not start');
    process.exit(2);
  }
}

let failures = 0;

function ok(cond, label, extra) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
}

async function req(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, type: r.headers.get('content-type') || '' };
}

console.log(`ShockBox API smoke — ${base}\n`);

// --- core ---------------------------------------------------------------
const health = await req('GET', '/health');
ok(health.status === 200, 'GET /health 200');
ok(health.data.modules && health.data.modules.notifications === 'up', 'notifications up', health.data.modules);
ok(health.data.modules && health.data.modules.dialogs === 'up', 'dialogs up', health.data.modules);

const mods = await req('GET', '/api/modules');
ok(mods.status === 200 && Array.isArray(mods.data.modules), 'GET /api/modules lists modules');
const notifMod = (mods.data.modules || []).find((m) => m.id === 'notifications');
ok(notifMod && notifMod.settings && notifMod.settings.style, 'notifications advertises a settings schema', notifMod && notifMod.settings);

// --- pool ---------------------------------------------------------------
const before = await req('GET', '/api/pools');
ok(before.status === 200 && Array.isArray(before.data.pools), 'GET /api/pools 200');
ok(['all', 'random', 'dialogs', 'notifications'].every((id) => before.data.pools.some((p) => p.id === id)), 'pools: all/random/dialogs/notifications');

const added = await req('POST', '/api/pool/all/messages', { text: 'API smoke dialog', type: 'Error', title: 'Smoke' });
ok(added.status === 200 && added.data.id, 'add a dialog message', added.data);
const dialogId = added.data.id;

const addedN = await req('POST', '/api/pool/all/messages', { text: 'API smoke notification', kind: 'notification', type: 'Info' });
ok(addedN.status === 200, 'add a notification message');
const notifId = addedN.data.id;

const bad = await req('POST', '/api/pool/all/messages', { text: '' });
ok(bad.status === 400, 'empty text is rejected', bad.data);

const kindView = await req('GET', '/api/pool/dialogs');
ok(kindView.data.messages.every((m) => m.kind === 'dialog'), 'dialogs pool only holds dialogs');
const notifView = await req('GET', '/api/pool/notifications');
ok(notifView.data.messages.every((m) => m.kind === 'notification'), 'notifications pool only holds notifications');

const moved = await req('POST', `/api/pool/all/messages/${dialogId}/move`, { to: 'notifications', index: 0 });
ok(moved.status === 200 && moved.data.kind === 'notification', 'move a message between kinds', moved.data);
await req('POST', `/api/pool/all/messages/${dialogId}/move`, { to: 'dialogs', index: 0 });

const patched = await req('PATCH', `/api/pool/all/messages/${dialogId}`, { text: 'API smoke dialog (patched)' });
ok(patched.status === 200 && patched.data.message.text === 'API smoke dialog (patched)', 'patch a message', patched.data);

// --- dialogs ------------------------------------------------------------
const d1 = await req('POST', '/api/dialogs/live', { any: true });
ok(d1.status === 200 && d1.data.entity && d1.data.entity.kind === 'dialog', 'spawn an alert from the pool', d1.data);
const dlgEntity = d1.data.entity || {};

const d2 = await req('POST', '/api/dialogs/live', { any: true });
// Alerts do not cascade: every one lands on the single deterministic centre, so two of the same
// size share the same x (and y) exactly. Their rendered y differs because the stage stacks them
// in a column with a gap, and both boxes must stay inside the 405x720 canvas.
const second = d2.data.entity || {};
const centred = (e) => e.w > 0 && e.x === Math.round((405 - e.w) / 2);
const insideStage = (e) => e.x >= 0 && e.y >= 0 && e.x + e.w <= 405 && e.y + e.h <= 720;
ok(d2.status === 200 && centred(dlgEntity) && centred(second) && dlgEntity.x === second.x,
  'both alerts sit on the same centred axis', [dlgEntity.x, second.x]);
ok(insideStage(dlgEntity) && insideStage(second), 'both alerts sit inside the stage', [dlgEntity, second]);
const dialogsCss = await (await fetch(base + '/dialogs/style.css')).text();
const stageRule = (dialogsCss.match(/#stage\s*\{[^}]*\}/) || [''])[0];
ok(dlgEntity.y === second.y && /flex-direction:\s*column/.test(stageRule) && /gap:\s*[1-9]/.test(stageRule),
  'alerts that would overlap are stacked by the stage (rendered y differs)', [dlgEntity.y, second.y]);

const miss = await req('POST', '/api/dialogs/live', { poolId: notifId });
ok(miss.status === 400, 'spawning a notification through the alerts module is refused', miss.data);

const meas = await req('POST', '/api/dialogs/live/measure', { id: dlgEntity.id, w: 300, h: 140 });
ok(meas.status === 200 && meas.data.entity.h === 140, 'measure updates height', meas.data);

const dlgLive = await req('GET', '/api/dialogs/live');
ok(dlgLive.data.live.length >= 2, 'alerts live list has the spawned entities', dlgLive.data.live.length);

const closed = await req('DELETE', `/api/dialogs/live?id=${dlgEntity.id}`);
ok(closed.status === 200 && closed.data.closed === 1, 'close one alert by id', closed.data);

const cleared = await req('DELETE', '/api/dialogs/live');
ok(cleared.status === 200, 'clear all alerts');
const afterClear = await req('GET', '/api/dialogs/live');
ok(afterClear.data.live.length === 0, 'alerts list is empty after clear');

// --- notifications ------------------------------------------------------
const n1 = await req('POST', '/api/notifications/live', { poolId: notifId });
ok(n1.status === 200 && n1.data.entity.kind === 'notification', 'spawn a notification by poolId', n1.data);
const n2 = await req('POST', '/api/notifications/live', { any: true });
ok(n2.status === 200 && n2.data.entity.y > n1.data.entity.y, 'second notification stacks below the first', [n1.data.entity.y, n2.data.entity && n2.data.entity.y]);
const wrongKind = await req('POST', '/api/notifications/live', { poolId: dialogId });
ok(wrongKind.status === 400, 'spawning a dialog through notifications is refused', wrongKind.data);

const settings = await req('PATCH', '/api/notifications/settings', { height: 96, style: 'win11' });
ok(settings.status === 200 && settings.data.changed.includes('height'), 'notification settings patch', settings.data);
const badSetting = await req('POST', '/api/notifications/settings', { style: 'nope' });
ok(badSetting.status === 405 || badSetting.status === 404, 'unsupported method on settings is not silently accepted', badSetting.status);
const badStyle = await req('PATCH', '/api/notifications/settings', { style: 'nope' });
ok(badStyle.status === 400, 'unknown enum value is rejected', badStyle.data);

const autoClose = await req('PATCH', '/api/notifications/settings', { autoCloseMs: 100 });
ok(autoClose.status === 200, 'set a short auto-close');
const n3 = await req('POST', '/api/notifications/live', { poolId: notifId });
ok(n3.status === 200, 'spawn with auto-close set');
await new Promise((r) => setTimeout(r, 700));
const afterAuto = await req('GET', '/api/notifications/live');
ok(!afterAuto.data.live.some((e) => e.id === (n3.data.entity && n3.data.entity.id)), 'notification auto-closed on the server', afterAuto.data.live.map((e) => e.id));
await req('PATCH', '/api/notifications/settings', { autoCloseMs: 12000, height: 76 });

const clearN = await req('DELETE', '/api/notifications/live');
ok(clearN.status === 200, 'clear notifications');

// --- pages --------------------------------------------------------------
for (const p of ['/dialogs', '/notify']) {
  const r = await fetch(base + p);
  const text = await r.text();
  ok(r.status === 200 && /<script[^>]+type="module"/.test(text), `page ${p} serves a module page`);
}
const overlayJs = await fetch(base + '/mod/dialogs/overlay/app.js');
ok(overlayJs.status === 200 && /EventSource/.test(await overlayJs.text()), 'overlay module assets are served from the module dir');

// A page that names an asset relative to itself while it is served at a module prefix
// (`href="style.css"` at /shockfx → /style.css → 404) fails silently: the document is 200, only the
// stylesheet and the script are missing, and the OBS source is blank with no API call to blame. So
// every declared page is walked here, every href/src resolved the way a browser resolves it (the
// document URL, plus the page's <base> when it declares one), and each reference must be served.
// The page list comes from the manifests: a new module or page is covered without editing this test.
const declaredPages = [];
for (const id of fs.readdirSync(path.join(ROOT, 'modules'))) {
  const manifestPath = path.join(ROOT, 'modules', id, 'module.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const page of manifest.pages || []) if (page.route) declaredPages.push({ id, route: page.route, file: page.file || '' });
}
ok(declaredPages.length > 0, `module manifests declare pages to walk (${declaredPages.map((p) => p.route).join(', ')})`);

for (const page of declaredPages) {
  const docUrl = new URL(page.route, base);
  const pageRes = await fetch(docUrl);
  const html = await pageRes.text();
  ok(pageRes.status === 200, `page ${page.route} (${page.file}) is served`, pageRes.status);
  const baseTag = /<base\s[^>]*href\s*=\s*["']([^"']*)["']/i.exec(html);
  const docBase = baseTag ? new URL(baseTag[1], docUrl) : docUrl;
  // The <base> tag is read above and then dropped: its href is the resolution origin, not a file
  // the browser fetches, and a page's base URL is not required to be a served path.
  const refHtml = html.replace(/<base\b[^>]*>/gi, '');
  // href/src are the attributes a browser fetches without a click. A URL with a scheme is not this
  // server's asset, and a fragment is not a request at all.
  const refs = [...refHtml.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)]
    .map((m) => m[1].trim())
    .filter((ref) => ref && !ref.startsWith('#') && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref));
  for (const ref of refs) {
    const assetUrl = new URL(ref, docBase);
    const asset = await fetch(assetUrl);
    const type = asset.headers.get('content-type') || '';
    // A module page loads ES modules: serving the right bytes as text/plain still leaves the
    // overlay blank, so the type is part of "resolves".
    const isJs = /\.m?js$/.test(assetUrl.pathname);
    ok(
      asset.status === 200 && (!isJs || /javascript/.test(type)),
      `page ${page.route} (${page.file}) reference "${ref}" resolves → ${assetUrl.pathname}`,
      { status: asset.status, type },
    );
  }
}

// --- cleanup ------------------------------------------------------------
await req('DELETE', `/api/pool/all/messages/${dialogId}`);
await req('DELETE', `/api/pool/all/messages/${notifId}`);

stop();
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
