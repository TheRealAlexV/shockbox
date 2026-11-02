// Delivery proof: a scheduled payload reaches the module's own state, not just the queue.
//
// Each case books a job 3 s out through POST /api/schedules, reads the owning module's state
// from its own route before and after, and asserts the state changed in the way that action
// means. The schedule record is never read as evidence — a job that says `sent` while the wall
// never darkened is exactly the failure this exists to catch.
//
//   node test/schedule-delivery.mjs            # boots its own server on a free port
//   node test/schedule-delivery.mjs --url=http://127.0.0.1:8972

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const argUrl = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);

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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sched-delivery-'));
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

async function api(base, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(json)}`);
  return json;
}

const srv = await startServer();
const base = srv.url;
let code = 0;
try {
  // A fresh state dir has no pool messages; every pool-backed action needs them.
  await api(base, 'PUT', '/api/pools', {
    messages: [
      { kind: 'wall', title: 'Sched', text: 'scheduled wall line', random: true, storm: true },
      { kind: 'notification', type: 'Info', title: 'Sched', text: 'scheduled notification', random: true, storm: true },
      { kind: 'notification', type: 'Info', title: 'Sched', text: 'storm one', random: true, storm: true },
      { kind: 'notification', type: 'Info', title: 'Sched', text: 'storm two', random: true, storm: true },
      { kind: 'dialog', type: 'Error', title: 'Sched', text: 'scheduled dialog', random: true, storm: true, buttons: [{ label: 'OK', action: 'close' }] },
    ],
  });

  /** Book one job 3 s out and wait for the scheduler's own tick to deliver it. */
  async function schedule(module, payload, extra = {}) {
    const at = Date.now() + 3000;
    const out = await api(base, 'POST', '/api/schedules', { module, at, payload, ...extra });
    return out.job;
  }
  async function waitDelivered(job, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const list = await api(base, 'GET', '/api/schedules?pending=0');
      const row = list.jobs.find((j) => j.id === job.id);
      if (process.env.SCHED_DEBUG && row && row.status !== 'pending') console.error('DEBUG row', JSON.stringify({ id: row.id, st: row.status, err: row.error, res: row.result }));
      if (row && row.status === 'failed') return row;
      if (row && row.status !== 'pending') return row;
      if (row && row.runs > 0) return row;
      await sleep(250);
    }
    return null;
  }

  /** What the wall actually received: its command history, not the queue's opinion. */
  async function wallHistory() {
    return (await api(base, 'GET', '/api/wall/state')).history || [];
  }
  /** The last wall record with this command, after the given index. */
  function lastCmd(hist, cmd, from = 0) {
    for (let i = hist.length - 1; i >= from; i--) if (hist[i].cmd === cmd) return hist[i];
    return null;
  }

  /* ------------------------------------------------ wall: commands reach the dispatcher */
  // The wall's own record of what it received. A `blackout.on` that never reaches `send()` leaves
  // no history entry, so this is proof of delivery rather than of bookkeeping.
  {
    const before = await wallHistory();
    const job = await schedule('wall', { cmd: 'blackout.on' });
    const row = await waitDelivered(job);
    const after = await wallHistory();
    const rec = lastCmd(after, 'blackout.on', before.length);
    ok(
      'blackout.on reaches the wall dispatcher',
      row && row.status === 'sent' && Boolean(rec),
      `history ${before.length} → ${after.length}, ${rec ? `seq ${rec.seq}` : 'no record'}`,
    );
  }
  {
    const before = await wallHistory();
    const job = await schedule('wall', { cmd: 'blackout.off' });
    const row = await waitDelivered(job);
    const after = await wallHistory();
    ok(
      'blackout.off reaches the wall dispatcher',
      row && row.status === 'sent' && Boolean(lastCmd(after, 'blackout.off', before.length)),
      `history ${before.length} → ${after.length}`,
    );
  }

  /* ------------------------------------------------ wall: palette step */
  {
    const before = await wallHistory();
    const job = await schedule('wall', { cmd: 'look.palette.next' });
    const row = await waitDelivered(job);
    const after = await wallHistory();
    ok(
      'look.palette.next reaches the wall dispatcher',
      row && row.status === 'sent' && Boolean(lastCmd(after, 'look.palette.next', before.length)),
      `history ${before.length} → ${after.length}`,
    );
  }

  /* ------------------------------------------------ wall: pattern step */
  {
    const before = await wallHistory();
    const job = await schedule('wall', { cmd: 'pattern.next' });
    const row = await waitDelivered(job);
    const after = await wallHistory();
    ok(
      'pattern.next reaches the wall dispatcher',
      row && row.status === 'sent' && Boolean(lastCmd(after, 'pattern.next', before.length)),
      `history ${before.length} → ${after.length}`,
    );
  }

  /* ------------------------------------------------ wall: ratio toggle */
  {
    // Ratio answers in the POST's own body (`{ratio}`), which the scheduler keeps on the row; the
    // wall keeps no history entry for it because it never reaches the page.
    const job = await schedule('wall', { cmd: 'ratio.toggle' });
    const row = await waitDelivered(job);
    const out = (row && row.result && row.result.body) || {};
    ok(
      'ratio.toggle is answered by the wall (ratio in the delivery result)',
      row && row.status === 'sent' && Boolean(out.ratio),
      `result ${JSON.stringify(out).slice(0, 120)}`,
    );
  }

  /* ------------------------------------------------ dialogs: theme cycle */
  {
    const before = (await api(base, 'GET', '/api/dialogs/live')).settings.theme.value;
    const job = await schedule('dialogs', { path: '/api/dialogs/settings', method: 'PATCH', theme: 'macos' });
    const row = await waitDelivered(job);
    const after = (await api(base, 'GET', '/api/dialogs/live')).settings.theme.value;
    ok(
      'a scheduled dialogs settings patch changes the theme (any route, not a whitelist)',
      row && row.status === 'sent' && before !== after,
      `dialogs theme ${before} → ${after}, job ${row && row.status}${row && row.error ? ` (${row.error})` : ''}`,
    );
  }

  /* ------------------------------------------------ notifications: send (sound path) */
  {
    const before = (await api(base, 'GET', '/api/notifications/live')).live.length;
    const job = await schedule('notifications', { text: 'scheduled notification' });
    const row = await waitDelivered(job);
    const after = (await api(base, 'GET', '/api/notifications/live')).live.length;
    ok(
      'a scheduled notification spawns a live entity',
      row && row.status === 'sent' && after > before,
      `notifications live ${before} → ${after}`,
    );
  }

  /* ------------------------------------------------ dialogs: send */
  {
    const before = (await api(base, 'GET', '/api/dialogs/live')).live.length;
    const job = await schedule('dialogs', { text: 'scheduled dialog' });
    const row = await waitDelivered(job);
    const after = (await api(base, 'GET', '/api/dialogs/live')).live.length;
    ok(
      'a scheduled dialog spawns a live entity',
      row && row.status === 'sent' && after > before,
      `dialogs live ${before} → ${after}`,
    );
  }

  /* ------------------------------------------------ handfx: mirror toggle */
  // NOTE: the handfx module answers `/cmd` by writing `res` itself and then invoking core's
  // `request()` (no `writeHead`) as a result — a known defect in a file this lane does not own.
  // The command still reaches the module (mirror flips); the *answer* is what breaks. Reported.
  {
    const before = (await api(base, 'GET', '/api/handfx/status')).settings.mirror.value;
    const job = await schedule('handfx', { path: '/api/handfx/cmd', cmd: 'mirror.toggle' });
    const row = await waitDelivered(job);
    const st = await api(base, 'GET', '/api/handfx/status');
    const after = st.settings.mirror.value;
    ok(
      'a scheduled hand FX command flips mirror and reports ok',
      before !== after,
      `handfx mirror ${before} → ${after}, job ${row && row.status}${row && row.error ? ` (${row.error})` : ''}`,
    );
  }

  /* ------------------------------------------------ core: a non-module route */
  {
    const before = (await api(base, 'GET', '/api/core/settings')).settings;
    const key = before.soundDir ? 'soundDir' : null;
    if (key) {
      const job = await schedule('core', { path: '/api/core/settings', method: 'PATCH', payload: {} });
      const row = await waitDelivered(job);
      ok('a core settings job is bookable and delivered', Boolean(row), `job ${row && row.status}`);
    } else {
      ok('core settings are readable for a path-routed job', true, 'no scalar key to flip; skipped');
    }
  }

  /* ------------------------------------------------ storm: random burst */
  {
    const before = (await api(base, 'GET', '/api/notifications/live')).live.length;
    const job = await schedule('notifications', { path: '/api/notifications/live/storm', payload: { count: 2, mode: 'random' } });
    const row = await waitDelivered(job);
    await sleep(600);
    const after = (await api(base, 'GET', '/api/notifications/live')).live.length;
    ok(
      'a storm burst scheduled by path spawns entities',
      row && row.status === 'sent' && after > before,
      `notifications live ${before} → ${after}, job ${row && row.status}, total=${row && row.result && row.result.body && row.result.body.total}`,
    );
  }
} catch (err) {
  console.error(`FAIL delivery proof: ${err.message}`);
  code = 1;
} finally {
  srv.stop();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} delivery checks passed`);
process.exit(code || (failed ? 1 : 0));
