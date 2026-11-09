// Node-only gate for the relay's close-inside-decode race.
//
// The relay's own doc says the server ends every camera stream at its max age, so a healthy page
// sees a clean EOF every two minutes by design. The bug this gate proves: a JPEG decode that is
// still in flight when that EOF lands used to fall through into drain()'s "went live" block and
// report an attach for a connection that no longer exists — which cancelled the 0 ms reopen and
// left the page live-with-no-socket until something reloaded it.
//
// It needs no browser. `relay.js` touches `document`/`window` only inside `createRelay`, and the
// only browser-only call on the frame path is `createImageBitmap`, which is stubbed here with a
// promise the test resolves by hand. That is what makes the race deterministic instead of a
// sampled check that has to win a 10 ms window.
//
//   node test/relay-cap-race.mjs

import http from 'node:http';
import { createRelay } from '../modules/handfx/pages/js/overlay/relay.js';

const BOUNDARY = 'framebound';
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9);
const CASE_TIMEOUT = 8000;

const failures = [];
function invariant(ok, message) {
  if (!ok) throw new Error(message);
}

/** Decodes are held by the test so a frame can straddle an EOF. */
function makeDecodeQueue() {
  const held = [];
  const waiters = [];
  globalThis.createImageBitmap = () =>
    new Promise((resolve) => {
      held.push(() => resolve({ width: 8, height: 8, close() {} }));
      for (const w of waiters.splice(0)) w();
    });
  return {
    /** Resolve the next held decode (FIFO). */
    async resolveNext() {
      while (!held.length) await new Promise((r) => waiters.push(r));
      held.shift()();
    },
    get pending() {
      return held.length;
    },
  };
}

/** One multipart MJPEG response per request; the test drives every write. */
async function makeStreamServer() {
  const requests = [];
  const waiters = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-store',
    });
    res.flushHeaders();
    const conn = {
      ended: false,
      part(bytes = JPEG) {
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`);
        res.write(bytes);
        res.write('\r\n');
      },
      end() {
        conn.ended = true;
        res.end();
      },
    };
    requests.push(conn);
    for (const w of waiters.splice(0)) w();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/stream`,
    async nextRequest(index, ms = 4000) {
      const deadline = Date.now() + ms;
      while (requests.length <= index) {
        if (Date.now() > deadline) {
          throw new Error(`no request #${index + 1} arrived within ${ms} ms (requests so far: ${requests.length})`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return requests[index];
    },
    get count() {
      return requests.length;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

function makeRelay(url, events) {
  globalThis.document = { addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  return createRelay({
    url,
    onEvent: (transition, detail) => events.push({ transition, detail }),
    onFrame() {},
  });
}

async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Case A — the max-age EOF landing inside an in-flight decode.
 *
 * A live stream, then one more frame whose decode is held across the server's clean EOF. The
 * reopen is scheduled at 0 ms by that EOF. Resolving the decode now must NOT count as the stream
 * going live: it belongs to a connection that is already gone. The reopen timer must survive.
 */
async function caseA(decode) {
  const srv = await makeStreamServer();
  const events = [];
  const relay = makeRelay(srv.url, events);
  try {
    const started = relay.start();
    const conn = await srv.nextRequest(0);
    conn.part();
    await decode.resolveNext(); // frame 1 decodes normally: the stream is live
    invariant(await started, 'case A setup: the first frame did not bring the stream live');

    conn.part(); // frame 2's decode will be held across the EOF
    await waitFor(() => decode.pending === 1, 2000, 'frame 2 to enter the decoder');

    // Resolve the held decode the instant the reopen is scheduled: a microtask, which runs before
    // the 0 ms timer, exactly like the real race.
    const off = (() => {
      const target = events;
      const orig = target.push.bind(target);
      target.push = (e) => {
        const r = orig(e);
        if (e.transition === 'retry-scheduled' && decode.pending === 1) void decode.resolveNext();
        return r;
      };
      return () => {
        target.push = orig;
      };
    })();
    conn.end(); // clean EOF: close(), live=false, wantReopen(0 ms)
    await waitFor(
      () => events.some((e) => e.transition === 'retry-scheduled' || e.transition === 'reopen-suppressed'),
      2000,
      'the max-age EOF to schedule a reopen',
    );
    const afterClose = events.length;
    await sleep(50);
    off();

    let second = null;
    try {
      second = await srv.nextRequest(1, 4000);
    } catch {
      second = null;
    }
    invariant(
      Boolean(second),
      'case A: a frame from a closed connection was counted as "attached" and cancelled the 0 ms reopen — ' +
        'no second request reached the server. A dead connection must not set live, must not cancelReopen().',
    );
    invariant(
      !events.slice(afterClose).some((e) => e.transition === 'attached'),
      'case A: an "attached" was reported after the close with no new connection acquiring (phantom attach).',
    );
    second.end();
  } finally {
    relay.stop({ forget: true, why: 'case A' });
    await srv.close();
  }
}

/**
 * Case B — a dead connection's frame landing on a live new acquisition.
 *
 * The old stream's last frame is still decoding when the reopen has already opened a new
 * connection and is waiting for its first frame. That stale frame must not make the stream look
 * live, and must not satisfy the new acquisition's first-frame waiter: only a frame from the new
 * connection may do that.
 */
async function caseB(decode) {
  const srv = await makeStreamServer();
  const events = [];
  const relay = makeRelay(srv.url, events);
  try {
    const started = relay.start();
    const conn1 = await srv.nextRequest(0);
    conn1.part();
    await decode.resolveNext();
    invariant(await started, 'case B setup: the first frame did not bring the stream live');

    conn1.part(); // held across the EOF
    await waitFor(() => decode.pending === 1, 2000, 'the stale frame to enter the decoder');
    conn1.end(); // EOF: close() + immediate reopen
    await waitFor(() => events.some((e) => e.transition === 'closed'), 2000, 'the EOF to close the connection');
    const afterClose = events.length;

    const conn2 = await srv.nextRequest(1, 4000);
    // The new acquisition is open and awaiting its first frame; observe its promise directly.
    const acquisition = relay.start();

    await decode.resolveNext(); // the dead connection's frame resolves into the new acquisition
    await sleep(50);

    invariant(
      !relay.isLive(),
      'case B: a frame from the closed connection made isLive() true on the new acquisition — ' +
        'the frame must be discarded by connection identity, not by "is any controller current".',
    );
    invariant(
      !events.slice(afterClose).some((e) => e.transition === 'attached'),
      'case B: the stale frame reported an attach on the new connection.',
    );

    let settledEarly = false;
    acquisition.then(() => {
      settledEarly = true;
    }, () => {
      settledEarly = true;
    });
    await sleep(100);
    invariant(
      !settledEarly,
      'case B: the new acquisition was satisfied by the dead connection\'s frame; only a frame from ' +
        'the connection the waiter is waiting for may resolve it.',
    );

    conn2.part(); // the new connection's own first frame
    await decode.resolveNext();
    invariant(await acquisition, 'case B: the new connection\'s first frame did not complete the acquisition');
    invariant(relay.isLive(), 'case B: the stream never came live from its own frame');
    conn2.end();
  } finally {
    relay.stop({ forget: true, why: 'case B' });
    await srv.close();
  }
}

function withTimeout(name, fn, ...args) {
  return Promise.race([
    fn(...args),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${name}: no verdict within ${CASE_TIMEOUT} ms`)), CASE_TIMEOUT);
      if (t.unref) t.unref();
    }),
  ]);
}

const cases = [
  ['A: max-age EOF inside an in-flight decode must still reopen', caseA],
  ['B: a dead connection\'s frame must not satisfy the new acquisition', caseB],
];

for (const [name, fn] of cases) {
  const decode = makeDecodeQueue();
  try {
    await withTimeout(name, fn, decode);
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(`${name}\n     ${err && err.message ? err.message : err}`);
    console.log(`FAIL ${name}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} relay invariant(s) broken:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nrelay: both isolation invariants hold');
