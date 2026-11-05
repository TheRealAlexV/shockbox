// Ratio commands reach the server's own handler, not the page bus.
//
// The wall's `ratio.toggle` / `ratio.force16x9` are answered by the module (settings are owned
// and persisted server-side; a forcing scene must outrank the key), so they must not be
// forwarded to the page like `blackout.toggle` is. This drives a real server over HTTP — the
// regression it catches: the handlers existed but the dispatcher forwarded them anyway, which
// made the deck's ratio key look dead (2026-10-29).
//
//   node test/ratio-commands.mjs      (spawns its own server on a free port)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Screenshots and scratch dirs go to $SHOCKBOX_SCRATCH (a per-machine convention), else the OS temp dir.
const SCRATCH = process.env.SHOCKBOX_SCRATCH || os.tmpdir();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// Per-run state dir, so the cycle starts from the shipped 'default' and never from a settings
// document a previous run left behind.
const state = fs.mkdtempSync(path.join(SCRATCH, 'sb-ratio-'));
// The port is claimed from the OS instead of guessed out of a range: 8993-9192 overlapped a live
// listener, and a stale server answering /health would have asserted against the wrong state dir.
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject).listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitUp(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const cmd = (body) =>
  fetch(`http://127.0.0.1:${port}/api/wall/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

// The ratio the wall is actually running (`render.ratio`), not the stored token: the shipped
// default is 'default', which resolves to 16:9 through `effectiveRatio()`.
const ratio = async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/wall/live`).then((x) => x.json());
  return r.render && r.render.ratio;
};

const srv = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(port), '--state', state], {
  cwd: root,
  stdio: 'ignore',
  detached: false,
});

try {
  const up = await waitUp();
  ok('server is up', up, `:${port}`);
  if (!up) throw new Error('server did not start');

  const start = await ratio();
  ok('ratio starts at the cycle entry (stored default resolves to 16:9)', start === '16:9', start);

  // Four-state cycle since f313e16: default -> 16:9 -> 9:16 -> both -> default. The wall reports
  // the *effective* ratio, so from the shipped 'default' a fresh run walks
  // 16:9 -> 9:16 -> both -> 16:9 and the fourth toggle wraps.
  const CYCLE = ['9:16', 'both', '16:9', '9:16'];
  let a;
  for (let i = 0; i < CYCLE.length; i++) {
    a = await cmd({ cmd: 'ratio.toggle' });
    const got = await ratio();
    ok(`toggle ${i + 1} lands on ${CYCLE[i]}`, a.body.ok === true && got === CYCLE[i], got);
  }
  ok('toggle answers as a command, not a bus forward', a.body.ok === true && a.body.note !== 'delivered counts SSE writes, not acknowledgements', JSON.stringify(a.body));

  // Sit on 9:16 so the forcing command has to move the wall.
  await cmd({ cmd: 'ratio.toggle' });
  const c = await cmd({ cmd: 'ratio.force16x9' });
  ok('force16x9 is a command', c.body.ok === true && (await ratio()) === '16:9', JSON.stringify(c.body));

  // A page command still goes to the bus (it is the contrast case).
  const d = await cmd({ cmd: 'blackout.toggle' });
  ok('page commands still forward to the bus', d.body.ok === true, JSON.stringify(d.body));

  // The forced list is what the watcher consults; it must survive validation and reach the state.
  const forced = await fetch(`http://127.0.0.1:${port}/api/modules/wall/state`).then((x) => x.json());
  const list = forced.state?.ratio?.forced || [];
  ok('the forced-scene list reaches the module', list.includes('Desktop') && list.includes('CominOut'), list.join(','));
} finally {
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(state, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
