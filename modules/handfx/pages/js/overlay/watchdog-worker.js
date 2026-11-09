// Off-thread block witness for the ShockFX overlay.
//
// Why a worker: when a document's main thread blocks, every instrument the page owns stops with
// it. rAF stops, `setInterval` stops, and the 1 s `<img>` beat stops in the same instant — so a
// blocked page looks exactly like a gone page, and it looks like nothing at all while it stays
// blocked, because the only reporter was the thread that stalled. A worker runs on its own thread
// with its own `fetch`, so it can still say "this page went silent" while the page cannot.
//
// Protocol (from main.js, both directions fire-and-forget):
//   page → worker  {type:'hello', clientId}
//                  {type:'tick', t, ticks, draws, phase}   on the same 1 s timer as the beat
//                  {type:'bye'}                             pagehide/beforeunload, a real teardown
//   worker → server GET /api/handfx/page-blame?c=…&why=main-thread-blocked&gap=…&last=…
//
// The rule: 5 s with no tick and no bye is a block. The first blame lands after one full silent
// window (so a page that blocked at tick 0 still testifies) and repeats once per 5 s window for as
// long as the block lasts. Ticks keep arriving → no blame, ever.
//
// This is a CLASSIC worker on purpose (no `type: 'module'`): it imports nothing, and a classic
// script is the one form every CEF build the rig runs can start.
'use strict';

const GAP_MS = 5000;
const BLAME_PATH = '/api/handfx/page-blame';

/** The last payload, URL-safe and bounded: it is a status line, never a frame. */
function encodeLast(payload) {
  try {
    return encodeURIComponent(JSON.stringify(payload)).slice(0, 900);
  } catch {
    return '';
  }
}

/**
 * The whole policy as a state machine, so the test can drive the real rule with a fake clock and a
 * fake `send` instead of re-implementing it. `send(clientId, gapMs, last)` does the POST.
 */
function createWatchdog({ now, send }) {
  const s = { clientId: '', lastTickAt: 0, lastBlameAt: 0, last: '', saidBye: false, blames: 0 };
  return {
    state: s,
    hello(clientId) {
      s.clientId = String(clientId || '').slice(0, 64);
      // A page that blocks before its first tick still owes a blame: the hello is the start line.
      s.lastTickAt = now();
      s.lastBlameAt = 0;
      s.saidBye = false;
    },
    tick(payload) {
      if (s.saidBye) return;
      s.lastTickAt = now();
      s.last = encodeLast(payload);
    },
    bye() {
      s.saidBye = true;
    },
    /** Called once per timer period. True when this call posted a blame. */
    check() {
      if (!s.clientId || s.saidBye) return false;
      const gap = now() - s.lastTickAt;
      if (gap < GAP_MS) return false;
      // One blame per 5 s window, however often `check` is called: a permanently blocked page keeps
      // testifying at a bounded rate instead of flooding the node.
      if (s.lastBlameAt && now() - s.lastBlameAt < GAP_MS) return false;
      s.lastBlameAt = now();
      s.blames += 1;
      try {
        send(s.clientId, gap, s.last);
      } catch {
        /* a witness that dies reporting is no witness */
      }
      return true;
    },
  };
}

self.__handfxWatchdog = { createWatchdog, GAP_MS, BLAME_PATH: '/api/handfx/page-blame' };

/* ------------------------------------------------------------ worker runtime */

if (typeof setInterval === 'function' && typeof self.postMessage === 'function') {
  // Both fetches below are bounded, and a failed probe is counted rather than dropped: this worker's
  // own dead fetch is the one fault it cannot report through the page, so the count rides the next
  // blame URL that does reach the server.
  const PROBE_TIMEOUT_MS = 4000;
  let probeFails = 0;
  const watchdog = createWatchdog({
    now: () => Date.now(),
    send: (clientId, gap, last) => {
      const extra = probeFails ? `&probeFails=${probeFails}` : '';
      const url =
        `${BLAME_PATH}?c=${encodeURIComponent(clientId)}&why=main-thread-blocked` +
        `&gap=${Math.round(gap)}&last=${last}${extra}`;
      // The worker's own fetch on the worker's own thread. Nothing here waits on the page.
      //
      // No `keepalive`, and do not add it back. A drained keep-alive quota does not queue the
      // request: every later keepalive fetch rejects instantly with a `TypeError`, for the life of
      // the document — so the one instrument whose job is to notice silence would go silent itself,
      // in exactly the situation it exists to detect. (overlay/ack-worker.js lost 529 s to that:
      // 1057 instant `type` errors while its `lastAckAt` stayed frozen and its status looked fine.)
      //
      // And it carries a deadline: an unbounded fetch that hangs never settles, so there is no
      // failure, no retry and no evidence. The timer is cleared in `finally` either way.
      const ctrl = new AbortController();
      const timerId = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      let p;
      try {
        p = fetch(url, { cache: 'no-store', signal: ctrl.signal });
      } catch (err) {
        clearTimeout(timerId);
        probeFails += 1;
        return;
      }
      p.then((res) => {
        if (!res.ok) throw new Error(`blame ${res.status}`);
      })
        .catch(() => {
          probeFails += 1;
        })
        .finally(() => clearTimeout(timerId));
    },
  });

  self.onmessage = (event) => {
    const msg = event && event.data;
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.type === 'hello') watchdog.hello(msg.clientId);
      else if (msg.type === 'tick') watchdog.tick({ t: msg.t, ticks: msg.ticks, draws: msg.draws, phase: msg.phase });
      else if (msg.type === 'bye') watchdog.bye();
    } catch {
      /* a malformed message is not a page fault */
    }
  };

  // A worker that cannot run is a blind spot, so it reports its own failure. No postMessage to the
  // main thread: the whole point is that the main thread may be the thing that is stuck.
  self.onerror = (msg, src, line, col, err) => {
    try {
      const text = (err && err.message) || String(msg || 'worker error');
      if (watchdog.state.clientId) {
        const last = encodeLast({ error: text.slice(0, 300), line: line || 0, col: col || 0 });
        // Last-resort report: still fire-and-forget, but bounded and counted. A hang here would
        // never settle and a rejection was dropped on the floor, so a watchdog error that could not
        // be reported left no trace anywhere; the count reaches the server on the next blame URL.
        const ctrl = new AbortController();
        const timerId = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
        fetch(
          `${BLAME_PATH}?c=${encodeURIComponent(watchdog.state.clientId)}&why=watchdog-error&gap=0&last=${last}`,
          { cache: 'no-store', signal: ctrl.signal },
        )
          .catch(() => {
            probeFails += 1;
          })
          .finally(() => clearTimeout(timerId));
      }
    } catch {
      /* nothing left to report with */
    }
  };

  setInterval(() => {
    try {
      watchdog.check();
    } catch {
      /* the interval must survive a bad iteration */
    }
  }, GAP_MS);
}
