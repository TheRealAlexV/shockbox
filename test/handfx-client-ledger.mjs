// Per-owner live-response ledger — the invariant a28 and a72 both specified and neither encoded.
//
// Browser-free on purpose: the census this asserts is already published by
// `/api/handfx/status`, so the invariant is checkable from a plain Node client against a server
// this file spawns itself. Do not turn any of it into a page-driving test.
//
// What is pinned here:
//   1. eight same-role /events attaches by one owner leave at most one response open. The
//      per-owner rule is LONG_LIVED_PER_CLIENT = 2; SOCKET_BUDGET is the origin-wide ceiling, not
//      an allowance any one owner may consume
//   2. a re-attach with the same clientId supersedes its predecessor; it does not accumulate
//   3. the budget is per owner, so distinct owners are never penalised for each other
//   4. an attach with no clientId is still reported, and clears when the response is destroyed
//
// Assertion 2 pins the clientId-keyed supersede. It was red before `core/events.mjs` gained the
// clientId guard in its `attach` predicate; the pre-fix expression it flips is quoted in its
// comment, so the case still fails if that guard is ever removed.
//
// Run: node test/handfx-client-ledger.mjs   (boots its own server on a free port)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The budget is read from the producer, never restated here: a hardcoded 6 goes stale the moment
// the cap moves, and then this gate asserts yesterday's number and misses the regression.
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'modules/handfx/server.js'), 'utf8');
const budgetOf = (name) => {
  const m = SERVER_SRC.match(new RegExp(`const ${name} = (\\d+);`));
  if (!m) throw new Error(`client-ledger: ${name} not found in modules/handfx/server.js`);
  return Number(m[1]);
};
const SOCKET_BUDGET = budgetOf('SOCKET_BUDGET');
// The per-owner allowance: one bus response + at most one camera stream.
const LONG_LIVED_PER_CLIENT = budgetOf('LONG_LIVED_PER_CLIENT');
// The spec's "six distinct owners"; derived from the cap so it tracks the real number.
const DISTINCT_OWNERS = SOCKET_BUDGET;

const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let failures = 0;
function ok(cond, label, extra) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  }
}

// Bounded poll: every wait in this file goes through here or a fixed sleep, so a broken server can
// never hang the gate. Returns true if the predicate held before the deadline.
async function waitFor(pred, { timeout = 2000, step = 50 } = {}) {
  const end = Date.now() + timeout;
  do {
    if (await pred()) return true;
    await sleep(step);
  } while (Date.now() < end);
  return false;
}

let base = '';
let server = null;
let stateDir = '';
// Every response this file holds open. Destroyed in `finally`, on pass or on failure.
const opened = [];

async function req(method, p, body) {
  const r = await fetch(base + p, {
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

const statusDoc = async () => (await req('GET', '/api/handfx/status')).data;
const rowsOf = (doc) => (doc && doc.sockets && Array.isArray(doc.sockets.streams) ? doc.sockets.streams : []);
const closedOf = (doc) => (doc && doc.sockets && Array.isArray(doc.sockets.closed) ? doc.sockets.closed : []);
// Absent is null, never []: a /status that stopped publishing the census must not read as clean.
const violationsOf = (doc) => (doc && doc.census && Array.isArray(doc.census.violations) ? doc.census.violations : null);
const rowsFor = (doc, clientId) => rowsOf(doc).filter((r) => r.clientId === clientId);
const eventsRows = (doc) => rowsOf(doc).filter((r) => r.path === '/events');

// Attach a real long-lived response and hold it open: the bus here, and the camera relay in the
// guard case below. Resolves once the headers are in, which is after the server recorded the row
// (handfx wraps `attach` and calls `openStream` before the hub writes; the camera route does the
// same before it hands the response to the relay). `ended` is socket-level evidence, not census
// evidence: it flips only when the response this client holds is actually finished.
//
// `tolerant` is for the supersede case: a predecessor is destroyed by the server the instant its
// successor attaches, and the RST can land before this client has read the headers, so the
// request errors instead of emitting a response. That is the behaviour under test, not a harness
// failure — resolve anyway with `res: null` so the count is read from the census, not the socket.
function openHeld(pathAndQuery, { tolerant = false } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.get(`${base}${pathAndQuery}`, (res) => {
      const handle = { res, call, ended: false };
      res.on('data', () => {}); // drain; never end — the row exists only while attached
      res.on('error', () => {});
      res.on('end', () => {
        handle.ended = true;
      });
      res.on('close', () => {
        handle.ended = true;
      });
      opened.push(handle);
      resolve(handle);
    });
    call.on('error', (err) => {
      if (tolerant) return resolve({ res: null, call, ended: true });
      reject(err);
    });
  });
}

function openEvents(query = '', opts) {
  return openHeld(`/events${query ? `?${query}` : ''}`, opts);
}

// Fire a request that may never send a byte, and do not wait for headers. The camera relay writes
// its head and then waits for frames; with no producer on this host nothing is flushed, so waiting
// for the response would hang the gate. The census row and `socket.destroyed` are the evidence.
function openSilent(pathAndQuery) {
  const handle = { res: null, call: null, ended: false };
  handle.call = http.get(`${base}${pathAndQuery}`, (res) => {
    handle.res = res;
    res.on('data', () => {});
    res.on('error', () => {});
    res.on('end', () => {
      handle.ended = true;
    });
    res.on('close', () => {
      handle.ended = true;
    });
  });
  handle.call.on('error', () => {
    handle.ended = true;
  });
  opened.push(handle);
  return handle;
}

async function closeAll(handles) {
  for (const { res, call } of handles) {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
    try {
      call.destroy();
    } catch {
      /* already gone */
    }
  }
  // Let the server's `res.on('close')` reap the row before the next census read.
  await sleep(80);
}

// A row is owned only if its clientId acked on this server; without this, every row below would
// also read as `unowned-stream: clientId never acked`, which is not what these cases are about.
const ack = (clientId, role) =>
  req('POST', '/api/handfx/ack', { clientId, role, build: 'ledger', anchors: 'none', draws: 0, loopTicks: 0 });

try {
  const port = await freePort();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ledger-'));
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: 'ignore',
  });
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
  if (!up) throw new Error('server did not start');

  console.log(`ShockBox per-owner live-response ledger — ${base}`);
  console.log(`budget: SOCKET_BUDGET=${SOCKET_BUDGET}, per-owner LONG_LIVED_PER_CLIENT=${LONG_LIVED_PER_CLIENT}\n`);

  const shape = await statusDoc();
  ok(
    violationsOf(shape) !== null,
    '/status publishes census.violations as an array (an absent census is not "clean")',
    shape && shape.census ? { census: shape.census } : { census: 'missing' },
  );

  // --- 0. a preview registers and stays invisible to every liveness answer ---------------------
  // The pane's preview iframe is a viewer, not a page. It has to be *traceable* (the build rule can
  // only end a stale document it can see) and *invisible* (/status answers about the source). Both
  // halves are asserted here, before any real page exists, so a preview cannot be propped up by a
  // healthy source: `pageState`/`clientBuild` compare against the same server with no page at all.
  const buildNow = (await req('GET', '/api/handfx/build')).data.build;
  const beforePreview = await statusDoc();
  const previewAck = await req('POST', '/api/handfx/ack', { clientId: 'ledger-preview-1', preview: true, build: buildNow });
  ok(previewAck.status === 200 && previewAck.data.preview === true, 'a preview:true ack is accepted as a preview', previewAck.data);
  const afterPreview = await statusDoc();
  const feedBefore = beforePreview.cameraFeed || {};
  const feedAfter = afterPreview.cameraFeed || {};
  ok(feedAfter.previewClients === 1, '/status counts the preview on its own (previewClients: 1)', {
    previewClients: feedAfter.previewClients,
    clientCount: feedAfter.clientCount,
  });
  ok(
    feedAfter.clientCount === feedBefore.clientCount,
    'a preview does not inflate cameraFeed.clientCount',
    { before: feedBefore.clientCount, after: feedAfter.clientCount },
  );
  ok(
    !(feedAfter.clientList || []).some((c) => c.id === 'ledger-preview-1'),
    'a preview is absent from cameraFeed.clientList (the page list)',
    (feedAfter.clientList || []).map((c) => c.id),
  );
  ok(
    afterPreview.pageState === beforePreview.pageState && (afterPreview.clientBuild || null) === (beforePreview.clientBuild || null),
    'freshestPage is unchanged by a registered preview (pageState and clientBuild identical)',
    {
      before: { pageState: beforePreview.pageState, clientBuild: beforePreview.clientBuild },
      after: { pageState: afterPreview.pageState, clientBuild: afterPreview.clientBuild },
    },
  );
  const previewRow = ((await req('GET', '/api/handfx/clients')).data.clients || []).find((c) => c.clientId === 'ledger-preview-1');
  ok(
    Boolean(previewRow && previewRow.preview === true && previewRow.stale === false),
    '/clients lists the preview with preview:true and stale:false (it is on the served build)',
    previewRow || null,
  );

  // --- 1. eight attaches to one owner leave at most one response open ------------------------
  // The invariant is the *open* count, not the reason a predecessor left. Eight same-role attaches
  // must collapse to at most one live /events response for this owner; how the other seven left
  // (superseded, max age, the close wrapper) is a property of the hub's implementation and is
  // reported, never asserted. A prior version demanded `why === 'superseded'` on at least
  // SOCKET_BUDGET + 1 of them and read 5 against correct code: the label depends on whether a
  // newer stream was still live when the old one's `close` fired, not on whether it was reaped.
  const owner1 = 'ledger-budget-1';
  const ack1 = await ack(owner1, 'probe');
  ok(ack1.status === 200, 'the owner is registered before its stream (else it reads as unacked)', ack1.data);

  const ATTACHES = SOCKET_BUDGET + 2;
  const ownerEvents = (doc) => rowsFor(doc, owner1).filter((r) => r.path === '/events');
  const held1 = await Promise.all(
    Array.from({ length: ATTACHES }, () => openEvents(`clientId=${owner1}&role=probe`, { tolerant: true })),
  );
  await waitFor(async () => ownerEvents(await statusDoc()).length <= 1);
  const doc1 = await statusDoc();
  const live1 = ownerEvents(doc1);
  ok(
    live1.length <= 1,
    `${ATTACHES} attaches to one owner leave at most one /events response open (open: ${live1.length})`,
    live1.map((r) => ({ clientId: r.clientId, path: r.path, ageMs: r.ageMs })),
  );

  // The other half of the same invariant: a response that is not open has to be in the closed
  // ring, whatever label it carries. The distribution itself is printed so a wrong or unhelpful
  // `why` is visible rather than normalised into the pass condition.
  const accounted = async () => {
    const d = await statusDoc();
    const closed = closedOf(d).filter((c) => c.clientId === owner1 && c.path === '/events');
    return ownerEvents(d).length + closed.length;
  };
  await waitFor(async () => (await accounted()) === ATTACHES, { timeout: 5000 });
  const doc1b = await statusDoc();
  const ended1 = closedOf(doc1b).filter((c) => c.clientId === owner1 && c.path === '/events');
  const live1b = ownerEvents(doc1b);
  const whyCounts = ended1.reduce((m, c) => {
    const key = c.why || '(empty)';
    m[key] = (m[key] || 0) + 1;
    return m;
  }, {});
  console.log(`  why distribution across ${ended1.length} closed /events for ${owner1}: ${JSON.stringify(whyCounts)}`);
  ok(
    ended1.length + live1b.length === ATTACHES,
    `${ATTACHES} attaches are each open or in the closed ring (open: ${live1b.length}, closed: ${ended1.length})`,
    { why: whyCounts },
  );
  await closeAll(held1);

  // --- 2. a re-attach supersedes rather than accumulates ------------------------------------
  // PRE-FIX EXPRESSION THAT FLIPS THIS — core/events.mjs:320-324:
  //
  //     if (c.role) {
  //       for (const old of [...clients.values()]) {
  //         if (old !== c && (old.role === c.role || (!old.role && old.ref === c.role))) drop(old, 'superseded');
  //       }
  //     }
  //
  // The predicate is keyed on `role`, never on `clientId`. A re-attach that carries `?clientId=`
  // and no `?role=` has `c.role === null`, so the guard is skipped and the predecessor is never a
  // candidate. Two such attaches leave TWO rows under one owner. Against the code as it stands
  // this prints:
  //     FAIL a re-attach with the same clientId supersedes its predecessor, not accumulates — {"open":2}
  // That is the rig's failure in one line: owner present, supersede never fires. A fix keys the
  // predicate on `clientId` as well (and must not drop a *different* owner's row).
  const owner2 = 'ledger-reattach-2';
  await ack(owner2, null);

  const held2 = [];
  held2.push(await openEvents(`clientId=${owner2}`));
  const first2 = rowsFor(await statusDoc(), owner2);
  ok(first2.length === 1, 'the first attach is one row for the owner', { open: first2.length, first2 });

  held2.push(await openEvents(`clientId=${owner2}`));
  await waitFor(async () => rowsFor(await statusDoc(), owner2).length <= 1, { timeout: 1500 });
  const second2 = rowsFor(await statusDoc(), owner2);
  ok(
    second2.length === 1,
    'a re-attach with the same clientId supersedes its predecessor, not accumulates',
    { open: second2.length, rows: second2.map((r) => ({ clientId: r.clientId, role: r.role, ageMs: r.ageMs })) },
  );
  ok(
    1 <= LONG_LIVED_PER_CLIENT,
    `one bus response is inside the per-owner allowance (${LONG_LIVED_PER_CLIENT})`,
    { allowed: LONG_LIVED_PER_CLIENT },
  );
  await closeAll(held2);

  // --- 2b. the supersede must not reach the owner's other long-lived stream ------------------
  // One owner is allowed LONG_LIVED_PER_CLIENT = 2 responses: one bus plus at most one camera
  // stream (modules/handfx/server.js:160, by design). That is why the supersede key cannot be
  // `clientId` alone: the moment the bus re-attaches it would end the owner's own camera response.
  // This case is the guard against over-fixing — it must stay green before AND after the fix.
  const ownerG = 'ledger-guard-camera-2b';
  await ack(ownerG, null);
  const heldG = [];
  const firstBusG = await openEvents(`clientId=${ownerG}`);
  // Headers are not evidence here: the camera relay writes its head then waits for frames, and with
  // no producer on this host nothing is flushed. The census row is the evidence, and the closed
  // ring is how a row that *was* ended shows up without the socket.
  const camG = openSilent(`/api/handfx/camera/stream?clientId=${ownerG}`);
  heldG.push(camG);
  await waitFor(
    async () => rowsFor(await statusDoc(), ownerG).some((r) => r.path === '/api/handfx/camera/stream'),
    { timeout: 3000 },
  );
  const bothG = rowsFor(await statusDoc(), ownerG);
  ok(
    bothG.length === LONG_LIVED_PER_CLIENT,
    `one owner holds a bus and a camera stream, its full allowance (${LONG_LIVED_PER_CLIENT})`,
    { open: bothG.length, rows: bothG.map((r) => r.path) },
  );

  heldG.push(await openEvents(`clientId=${ownerG}`));
  await waitFor(
    async () => rowsFor(await statusDoc(), ownerG).filter((r) => r.path === '/events').length <= 1,
    { timeout: 1500 },
  );
  await sleep(100); // let the superseded response's close land on this side
  const docG = await statusDoc();
  const afterG = rowsFor(docG, ownerG);
  ok(
    afterG.filter((r) => r.path === '/events').length === 1 && firstBusG.ended,
    'the older /events is gone after the same-clientId re-attach',
    { open: afterG.length, rows: afterG.map((r) => r.path), firstEnded: firstBusG.ended },
  );
  ok(
    !camG.ended && afterG.some((r) => r.path === '/api/handfx/camera/stream') &&
      !closedOf(docG).some((s) => s.path === '/api/handfx/camera/stream' && s.clientId === ownerG),
    'the camera stream under the same clientId is still open',
    {
      ended: camG.ended,
      rows: afterG.map((r) => r.path),
      closed: closedOf(docG).filter((s) => s.clientId === ownerG),
    },
  );
  await closeAll(heldG);

  // --- 3. the origin cap is real; the old blame field was not ---------------------------------
  // Two separate facts, which the old `budget-exhausted` name conflated into one wrong story:
  //
  //  (a) PER OWNER. The allowance is LONG_LIVED_PER_CLIENT = 2 (server.js:160). Six different
  //      documents each holding one /events are each well inside it, so `owner-over-budget`
  //      (server.js:1053) must not appear. That kind is the genuine attribution and stays separate.
  //  (b) PER ORIGIN. The origin genuinely has a six-socket cap (SOCKET_BUDGET = CEF's per-origin
  //      limit), so six legitimate long-lived responses do fill it and should be reported — it is
  //      the attribution that was wrong, not the count. The row must be `origin-sockets-exhausted`
  //      with `open: 6` and `oldestClientId` (the oldest row's owner, for orientation) and must
  //      carry no `owner` field. Read alone, it may not be mistaken for "this client is over".
  //
  // The old kind `budget-exhausted` reported `open: 8, owner: <arbitrary clientId>` on a healthy
  // origin and got read as a per-client overrun in production; the next read flipped the same
  // `open: 8` to `owner: null` because the oldest row had changed. That instability is the tell:
  // the field was never attribution.
  const owners3 = Array.from({ length: DISTINCT_OWNERS }, (_, i) => `ledger-multi-${i}`);
  const held3 = [];
  for (let i = 0; i < owners3.length; i++) {
    await ack(owners3[i], `/probe-${i}`);
    held3.push(await openEvents(`clientId=${owners3[i]}&role=${encodeURIComponent(`/probe-${i}`)}`));
  }
  await sleep(150);
  const doc3 = await statusDoc();
  const viol3 = violationsOf(doc3) || [];
  const over3 = viol3.filter((v) => v.kind === 'owner-over-budget');
  ok(
    over3.length === 0,
    `${owners3.length} distinct owners with one /events each raise no owner-over-budget (each is inside LONG_LIVED_PER_CLIENT=${LONG_LIVED_PER_CLIENT})`,
    over3,
  );
  const origin3 = viol3.filter((v) => v.kind === 'origin-sockets-exhausted');
  ok(
    origin3.length === 1 &&
      origin3[0].open === owners3.length &&
      origin3[0].budget === SOCKET_BUDGET &&
      origin3[0].path === '/events' &&
      typeof origin3[0].oldestClientId === 'string' &&
      owners3.includes(origin3[0].oldestClientId) &&
      !('owner' in origin3[0]),
    `the full origin reports origin-sockets-exhausted open: ${owners3.length} with oldestClientId and no owner field`,
    origin3,
  );
  await closeAll(held3);

  // --- 4. an unowned attach is still reported -----------------------------------------------
  // The other half: a response that declared no clientId can never be ended by `endClient`, so the
  // census must name it. Exactly one row, and it must clear once the response is destroyed.
  const held4 = [await openEvents('')];
  await waitFor(async () => {
    const d = await statusDoc();
    return (violationsOf(d) || []).some((v) => v.kind === 'unowned-stream' && v.path === '/events');
  });
  const doc4 = await statusDoc();
  const unowned4 = (violationsOf(doc4) || []).filter((v) => v.kind === 'unowned-stream' && v.path === '/events');
  ok(
    unowned4.length === 1,
    'an attach with no clientId is reported as exactly one unowned-stream naming /events',
    unowned4,
  );
  ok(
    unowned4[0] && unowned4[0].reason === 'request carried no clientId',
    'the unowned row names which half of the identity is missing',
    unowned4[0],
  );

  await closeAll(held4);
  const cleared = await waitFor(async () => {
    const d = await statusDoc();
    const noViolation = !(violationsOf(d) || []).some((v) => v.kind === 'unowned-stream' && v.path === '/events');
    const noRow = !rowsOf(d).some((r) => r.path === '/events' && !r.clientId);
    return noViolation && noRow;
  });
  ok(cleared, 'destroying the unowned response clears both the row and the violation', { cleared });
} catch (err) {
  failures++;
  console.error(`  FAIL harness — ${err && err.message ? err.message : err}`);
} finally {
  // Every opened response, the spawned server, and its state dir, on pass or on failure.
  for (const { res, call } of opened) {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
    try {
      call.destroy();
    } catch {
      /* already gone */
    }
  }
  if (server) {
    try {
      server.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (stateDir) {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

if (failures > 0) {
  console.error(`\nclient-ledger: ${failures} failed`);
  process.exit(1);
}
console.log('\nclient-ledger: ok');
