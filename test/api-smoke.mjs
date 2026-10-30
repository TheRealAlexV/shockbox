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
ok(d2.status === 200 && d2.data.entity.x !== dlgEntity.x, 'second alert cascades (different x)', [dlgEntity.x, d2.data.entity && d2.data.entity.x]);

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

// --- cleanup ------------------------------------------------------------
await req('DELETE', `/api/pool/all/messages/${dialogId}`);
await req('DELETE', `/api/pool/all/messages/${notifId}`);

stop();
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
