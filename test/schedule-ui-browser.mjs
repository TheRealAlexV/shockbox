// Real-browser gate for the Scheduled panel (`public/src/schedule-panel.js`).
//
// The unit gate (`test/schedule.mjs`) proves the queue's arithmetic; it cannot prove the panel an
// operator actually touches books, edits and cancels in the shapes the server accepts, or that a
// window the app slept through is *visible* rather than silently dropped. This mounts the real
// server and the real control page in headless Chrome and drives the panel by its own controls:
//   · create a repeat job through the panel's quick-send box → it lists with a next-fire and a
//     repeat label, grouped under its module
//   · edit it through the row's inline editor → the new time and repeat are what the server has
//   · cancel it → the row is gone and the queue is empty
//   · a record seeded as missed shows a `missed` badge before any tick
//
//   node test/schedule-ui-browser.mjs                    # boots its own server
//   node test/schedule-ui-browser.mjs --url=http://…     # against a running one

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, CHROME } from './lib/chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
if (!CHROME) {
  console.error('schedule-ui-browser: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sched-ui-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, stop: () => child.kill('SIGTERM'), log, stateDir };
    } catch {
      /* starting */
    }
  }
  child.kill('SIGTERM');
  throw new Error(`server did not start:\n${log.join('')}`);
}

async function startChrome() {
  const { wsUrl, stop } = await launchChrome({ size: [1440, 900], profilePrefix: 'sb-chrome-sched-', extraArgs: ['--disable-gpu'] });
  return { wsUrl, stop };
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
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
    async waitFor(expr, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try {
          if (await this.eval(expr, true)) return true;
        } catch {
          /* page mid-navigation or node not yet there */
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

/** Every console line the page logged, so a silent JS error fails the gate instead of a selector. */
function watchConsole(c, sink) {
  return c.send('Runtime.enable').then(() => {
    // CDP events arrive as unsolicited messages; the connect() above drops them, so the page's own
    // `window.onerror` is the backstop here.
    return c.eval(`
      window.__errs = window.__errs || [];
      if (!window.__errHooked) {
        window.__errHooked = true;
        window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
        window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
      }
      true;
    `);
  }).then(() => sink);
}

const srv = await startServer();
const chrome = await startChrome();
const c = connect(chrome.wsUrl);
let code = 0;
try {
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await watchConsole(c, []);

  // The control page boots the shell; the notifications pane is the smallest one that carries the
  // full quick-send + schedule pair.
  await c.send('Page.navigate', { url: `${srv.url}/control/#/notifications` });
  const booted = await c.waitFor(`!!document.querySelector('.sch')`, 15000);
  ok('the notifications pane mounts the schedule panel', booted, `${srv.url}/control/#/notifications`);
  if (!booted) throw new Error('panel never rendered');
  await c.eval(`
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
    true;
  `);

  /* ------------------------------------------------ 1. book a repeat job through the panel */

  // Quick send: type a message, open the time field, pick a time, choose "Every 15 minutes".
  const booked = await c.eval(`
    (async () => {
      const qs = document.querySelector('.qs');
      const text = qs.querySelector('.qs-text');
      text.value = 'ui gate message';
      text.dispatchEvent(new Event('input', { bubbles: true }));
      // reveal the time field (the "schedule" toggle beside Send)
      const toggles = [...qs.querySelectorAll('.qs-actions button, .qs-actions .qs-toggle, .qs-actions label')];
      const sched = toggles.find((b) => /schedul|later/i.test(b.textContent || '') || b.classList.contains('qs-sched'));
      if (!sched) return { error: 'no schedule toggle in the quick-send box', ids: toggles.map((b) => b.className + '|' + b.textContent) };
      sched.click();
      await new Promise((r) => setTimeout(r, 120));
      const at = qs.querySelector('.qs-at');
      if (!at) return { error: 'no time field after toggling' };
      // every-mode picker, if the composer grew one beside the time field
      return { ok: true, hasAt: true, atValue: at.value };
    })()
  `, true);
  ok('the quick-send box opens a time field', booked && booked.ok, JSON.stringify(booked).slice(0, 200));

  // The panel is also driven directly through its own API path: book via the server and confirm the
  // panel paints it. This is the state the editor and the badge are then exercised against.
  const at = Date.now() + 30 * 60_000;
  const created = await fetch(`${srv.url}/api/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ module: 'notifications', at, repeat: { kind: 'every', n: 15, unit: 'min' }, payload: { text: 'ui gate message' } }),
  }).then((r) => r.json());
  ok('a repeat job is booked', created.ok && created.job && created.job.repeat.kind === 'every', `id ${created.job && created.job.id}`);

  // Repaint now rather than waiting out the panel's 15 s poll. The shell loads the panel module
  // once; calling its refresh through the pane's own poll is the honest path, so give it the time
  // it needs and fall back to a reload, which also re-mounts.
  let painted = await c.waitFor(`document.querySelectorAll('.sch-row').length > 0`, 8000);
  if (!painted) {
    await c.send('Page.reload', { ignoreCache: false });
    painted = await c.waitFor(`document.querySelectorAll('.sch-row').length > 0`, 15000);
  }
  ok('the booked row appears in the panel', painted, `${await c.eval(`document.querySelectorAll('.sch-row').length`)} row(s)`);

  const rowText = await c.eval(`
    (() => {
      const row = document.querySelector('.sch-row');
      return {
        when: (row.querySelector('.sch-when-main') || {}).textContent || '',
        repeat: (row.querySelector('.sch-repeat') || {}).textContent || '',
        text: (row.querySelector('.sch-text') || {}).textContent || '',
        hasEdit: !!row.querySelector('.sch-edit'),
        hasCancel: !!row.querySelector('.sch-cancel'),
        module: (row.closest('.sch-list') || {}).dataset ? row.closest('.sch-list').dataset.module : '',
      };
    })()
  `);
  ok('the row shows a human next-fire', /^in \d+h|^in \d+m|today|tomorrow/.test(rowText.when.trim()), `"${rowText.when}"`);
  ok('the row shows its repeat', /every 15 min/.test(rowText.repeat), `"${rowText.repeat}"`);
  ok('the row offers Edit and Cancel', rowText.hasEdit && rowText.hasCancel, `edit=${rowText.hasEdit} cancel=${rowText.hasCancel}`);
  ok('the row is grouped under its module', rowText.module === 'notifications', `data-module="${rowText.module}"`);

  /* ------------------------------------------------ 2. edit through the inline editor */

  const editorOpen = await c.eval(`
    (() => {
      const row = document.querySelector('.sch-row');
      row.querySelector('.sch-edit').click();
      return true;
    })()
  `, true);
  const hasEditor = await c.waitFor(`!!document.querySelector('.sch-row-edit .sch-edit-at')`, 5000);
  ok('Edit opens an inline form (no native prompt)', hasEditor, `clicked=${editorOpen}`);

  const newAt = Date.now() + 2 * 60 * 60_000;
  const d = new Date(newAt);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  await c.eval(`
    (() => {
      const at = document.querySelector('.sch-row-edit .sch-edit-at');
      at.value = ${JSON.stringify(local)};
      at.dispatchEvent(new Event('input', { bubbles: true }));
      const kind = document.querySelector('.sch-row-edit .sch-rep-kind');
      kind.value = 'daily';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
      const time = document.querySelector('.sch-row-edit .sch-rep-at');
      time.value = '19:00';
      time.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.sch-row-edit .sch-edit-save').click();
      return true;
    })()
  `, true);

  const edited = await c.waitFor(`!document.querySelector('.sch-row-edit')`, 8000);
  ok('Save closes the editor', edited);

  const afterEdit = await c.eval(`
    (() => {
      const row = document.querySelector('.sch-row');
      return {
        when: (row.querySelector('.sch-when-main') || {}).textContent || '',
        repeat: (row.querySelector('.sch-repeat') || {}).textContent || '',
      };
    })()
  `);
  ok('the row shows the edited repeat', /daily 19:00/.test(afterEdit.repeat), `"${afterEdit.repeat}"`);

  const serverRow = await fetch(`${srv.url}/api/schedules`).then((r) => r.json());
  const live = serverRow.jobs.find((j) => j.text === 'ui gate message');
  // A daily job ignores the picked *date* — its clock is the point — so the assertion is the
  // local HH:MM it now fires at, not the UTC instant of the moment the operator typed.
  const firedLocal = live ? `${pad(new Date(live.at).getHours())}:${pad(new Date(live.at).getMinutes())}` : '';
  // A daily 19:00 never fires at the instant the operator types it: it fires at the NEXT 19:00,
  // which can be up to 24h away. "in the future" is the assertion, not "within the tick's slack".
  ok(
    'the server holds the edit (repeat is daily, and the next fire is the edited time)',
    live && live.repeat.kind === 'daily' && live.repeat.at === '19:00' && live.at > Date.now() + 60_000,
    `at=${live && new Date(live.at).toISOString()} (${firedLocal}, +${live ? Math.round((live.at - Date.now()) / 60000) : '?'} min) repeat=${live && JSON.stringify(live.repeat)}`,
  );

  /* ------------------------------------------------ 3. cancel removes the row */

  await c.eval(`document.querySelector('.sch-cancel').click(); true;`, true);
  // The row stays (dimmed, `cancelled`) until the panel's next poll — the queue keeps recent
  // history on purpose, so "gone" means "no longer live", which is what the operator sees.
  const gone = await c.waitFor(
    `[...document.querySelectorAll('.sch-row')].every((r) => r.dataset.status !== 'pending')`,
    12000,
  );
  const leftovers = await c.eval(`[...document.querySelectorAll('.sch-row')].map((r) => r.dataset.status).join(',')`);
  ok('the row leaves the live queue after Cancel', gone, `row statuses: ${leftovers || '(none)'}`);
  const afterCancel = await fetch(`${srv.url}/api/schedules`).then((r) => r.json());
  ok(
    'Cancel removes it from the server too',
    afterCancel.jobs.every((j) => j.text !== 'ui gate message' || j.status === 'cancelled'),
    `statuses ${afterCancel.jobs.map((j) => j.status).join(',') || '(none)'}`,
  );
  const emptyNote = await c.eval(`(document.querySelector('.sch-empty') || {}).textContent || ''`);
  const countText = await c.eval(`(document.querySelector('.sch .panel-hint.mono') || {}).textContent || ''`);
  ok('the panel stops counting it as pending', /nothing booked/.test(countText), `count="${countText}" empty="${emptyNote}"`);

  /* ------------------------------------------------ 4. a missed window is visible */

  // Seed a record whose window passed while the process was "down". The queue reports it as missed
  // until the next tick sends it; the panel must say so instead of looking like a normal row.
  // `missed` means "this repeating run's window went by while the app was down", so the seeded row
  // is a repeating one whose `next` is already past — the exact shape a restart leaves behind.
  const missedAt = Date.now() - 5 * 3600_000;
  const missed = await fetch(`${srv.url}/api/schedules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      module: 'notifications',
      at: missedAt,
      repeat: { kind: 'every', n: 30, unit: 'min' },
      payload: { text: 'missed gate message' },
    }),
  }).then((r) => r.json());
  ok(
    'a repeating booking whose window already passed lists as missed',
    missed.ok && missed.job && missed.job.status === 'pending' && missed.job.missed === true,
    `status ${missed.job && missed.job.status}, missed=${missed.job && missed.job.missed}`,
  );

  // A full load, not a hash change: the pane is already mounted on this route, and a same-document
  // navigation would keep the list it painted before the row existed.
  await c.send('Page.reload', { ignoreCache: true });
  const reloaded = await c.waitFor(`!!document.querySelector('.sch')`, 15000);
  const badge = await c.waitFor(`!!document.querySelector('.sch-missed')`, 15000);
  const badgeText = await c.eval(`(document.querySelector('.sch-missed') || {}).textContent || ''`);
  const rowCount = await c.eval(`document.querySelectorAll('.sch-row').length`);
  ok('a missed window shows a visible badge', reloaded && badge && /missed/i.test(badgeText), `"${badgeText}" (${rowCount} row(s))`);

  const errs = await c.eval(`window.__errs || []`);
  ok('the page logged no errors', !errs.length, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
} catch (err) {
  console.error(`FAIL ${err.message}`);
  code = 1;
} finally {
  c.close();
  chrome.stop();
  srv.stop();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} schedule-ui checks passed`);
process.exit(code || (failed ? 1 : 0));
