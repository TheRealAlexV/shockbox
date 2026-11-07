/**
 * Acks and beats, on a thread the render loop cannot occupy.
 *
 * The main thread hands over its latest payload; this worker posts it on its own timer. A main
 * thread blocked by decode work therefore shows up as "ack fresh, draws stale" in the server's
 * truth table instead of as a dead page, which is what three previous fixes were judged by a
 * signal that died with the thing it was measuring.
 *
 * Nothing here reads the DOM or the page state: it only carries the body it was last given.
 */
let payload = null;
let timer = 0;
let intervalMs = 500;
let timeoutMs = 4000;
let inflight = false;

const stats = { attempts: 0, ok: 0, abort: 0, type: 0, other: 0, skipped: 0, lastStatus: 0, lastMs: 0 };

function tick() {
  // `skipped` is the case the tick counter alone cannot see: no payload, so no ack is attempted.
  if (!payload || inflight) {
    stats.skipped += 1;
    return;
  }
  inflight = true;
  stats.attempts += 1;
  const started = Date.now();
  const ctrl = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), timeoutMs);
  fetch('/api/handfx/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-handfx-via': 'worker' },
    body: payload,
    signal: ctrl.signal,
  })
    .then((res) => {
      clearTimeout(timerId);
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
      clearTimeout(timerId);
      stats.lastMs = Date.now() - started;
      const name = (err && err.name) || 'Error';
      if (name === 'AbortError') stats.abort += 1;
      else if (name === 'TypeError') stats.type += 1;
      else stats.other += 1;
      postMessage({ type: 'ack-fail', error: name });
    })
    .finally(() => {
      inflight = false;
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
 * server holds a timeline written by a thread the render loop cannot occupy. A main thread frozen
 * while these ticks keep arriving is a thread-level stall; ticks stopping with it is a wedged
 * renderer process. Nothing else can tell those two apart.
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
  try {
    void fetch('/api/handfx/page-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'worker-tick',
        phase: 'tick',
        message: String(ticks),
        // What the server cannot see from outside: this worker's own inter-tick gap, and how many
        // ticks have passed with no successful POST. Without them a large server-side tick age
        // cannot tell "the worker stopped" from "the worker is ticking and its POST cannot land".
        gapMs,
        sinceOk: ticksSinceOk,
        lastOkAt,
        // The worker's side of the ack. Without this the server sees only its own arrivals and
        // cannot tell an ack that never left from one that left and was not credited.
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
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* the tick ledger must never break the thread it measures */
  }
}, 500);
