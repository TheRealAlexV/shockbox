/**
 * Acks and beats, on a thread the render loop cannot occupy.
 *
 * The main thread hands over its latest payload; this worker posts it on its own timer. A main
 * thread blocked by decode work therefore shows up as "ack fresh, draws stale" in the server's
 * truth table instead of as a dead page.
 *
 * Both POSTs here have the same shape: at most one in flight, skipped while one is outstanding,
 * a 4 s abort, and a `.finally` that clears the latch. Neither carries `keepalive`; see the tick
 * interval for why.
 */
let payload = null;
let timer = 0;
let intervalMs = 500;
let timeoutMs = 4000;

const stats = {
  attempts: 0,
  ok: 0,
  abort: 0,
  type: 0,
  other: 0,
  skipped: 0,
  latchBreaks: 0,
  tickSkipped: 0,
  tickLatchBreaks: 0,
  lastStatus: 0,
  lastMs: 0,
};

/** Abort lifetime plus margin: past this a latch has no request behind it. */
const grace = () => timeoutMs * 3;

let inflight = false;
let inflightSince = 0;
let tickInflight = false;
let tickSince = 0;

function tick() {
  if (!payload) {
    stats.skipped += 1;
    return;
  }
  const now = Date.now();
  if (inflight) {
    // The abort settles the promise per spec, so a hung request cannot stick this. A `fetch` that
    // throws before returning its promise skips `.finally` entirely, and then this latch would skip
    // every later tick with no error anywhere. Break it, count it, and say so once.
    if (now - inflightSince <= grace()) {
      stats.skipped += 1;
      return;
    }
    stats.latchBreaks += 1;
    postMessage({ type: 'latch-break', kind: 'ack', heldMs: now - inflightSince });
  }
  inflight = true;
  inflightSince = now;
  const started = Date.now();
  const ctrl = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), timeoutMs);
  let req;
  try {
    req = fetch('/api/handfx/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-handfx-via': 'worker' },
      body: payload,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timerId);
    inflight = false;
    inflightSince = 0;
    stats.other += 1;
    postMessage({ type: 'ack-fail', error: (err && err.name) || 'sync' });
    return;
  }
  req
    .then((res) => {
      stats.lastStatus = res.status;
      stats.lastMs = Date.now() - started;
      if (res.ok) {
        stats.ok += 1;
        lastOkAt = Date.now();
        ticksSinceOk = 0;
        postMessage({ type: 'ack-ok', at: Date.now() });
      } else postMessage({ type: 'ack-fail', status: res.status });
    })
    .catch((err) => {
      stats.lastMs = Date.now() - started;
      const name = (err && err.name) || 'Error';
      if (name === 'AbortError') stats.abort += 1;
      else if (name === 'TypeError') stats.type += 1;
      else stats.other += 1;
      postMessage({ type: 'ack-fail', error: name });
    })
    .finally(() => {
      clearTimeout(timerId);
      inflight = false;
      inflightSince = 0;
    });
}

onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'config') {
    if (Number.isFinite(data.intervalMs) && data.intervalMs > 0) intervalMs = data.intervalMs;
    if (Number.isFinite(data.timeoutMs) && data.timeoutMs > 0) timeoutMs = data.timeoutMs;
    return;
  }
  if (data.type === 'payload') {
    payload = typeof data.body === 'string' ? data.body : null;
    if (!timer) {
      timer = setInterval(tick, intervalMs);
      tick();
    }
  }
};

/**
 * The worker's own clock. It posts a tick every 500 ms whether or not an ack succeeds, so the
 * server holds a timeline written by a thread the render loop cannot occupy.
 *
 * Deliberately no `keepalive`: this runs at 2/s for the lifetime of an overlay source and has no
 * unload-survival need. Keepalive requests draw on a separate 64 KiB per-fetch-group quota that a
 * hanging request drains, after which new keepalive fetches fail immediately rather than queueing -
 * a second starvation surface sitting on the channel that carries this worker's own diagnostics.
 * Do not add it back.
 */
let ticks = 0;
let lastTickAt = 0;
let lastOkAt = 0;
let ticksSinceOk = 0;
setInterval(() => {
  ticks += 1;
  const now = Date.now();
  const gapMs = lastTickAt ? now - lastTickAt : 0;
  lastTickAt = now;
  ticksSinceOk += 1;
  if (tickInflight) {
    if (now - tickSince <= grace()) {
      stats.tickSkipped += 1;
      return;
    }
    stats.tickLatchBreaks += 1;
    postMessage({ type: 'latch-break', kind: 'tick', heldMs: now - tickSince });
  }
  tickInflight = true;
  tickSince = now;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  let req;
  try {
    req = fetch('/api/handfx/page-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'worker-tick',
        phase: 'tick',
        message: String(ticks),
        gapMs,
        sinceOk: ticksSinceOk,
        lastOkAt,
        ack: {
          ...stats,
          clientId: (() => {
            try {
              return String(JSON.parse(payload).clientId || '');
            } catch {
              return '';
            }
          })(),
        },
      }),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(tid);
    tickInflight = false;
    tickSince = 0;
    stats.tickLatchBreaks += 1;
    return;
  }
  req
    .catch(() => {})
    .finally(() => {
      clearTimeout(tid);
      tickInflight = false;
      tickSince = 0;
    });
}, 500);
