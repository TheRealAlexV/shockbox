// Short-lived live polling for the popup overlay documents (`/notify`, `/dialogs`).
//
// Why this is not an EventSource: CEF gives the whole origin six HTTP/1.1 slots, and these two
// documents held one each, permanently, to learn about a toast every few minutes. With seven
// kinds of stream and six slots the ack POST could never get one, the server reaped the page for
// a stale ack, and the reap reset the live camera stream. No ownership rule fixes that
// arithmetic; only freeing the slot does.
//
// So: one small GET per tick while the document is visible, closed as soon as the body is read.
// The server's `rev` counter makes an unchanged tick free (no parse work, no repaint), and a
// changed one is applied exactly once. Nothing here retries: the next tick *is* the retry, which
// is why a failure cannot stack.

/** Toast latency is the product decision: worst case one tick plus one round trip on loopback. */
export const POLL_MS = 1000;
/** Hidden is slower, never stopped: a scene cut must find the record already painted. */
export const HIDDEN_POLL_MS = 4000;
/** A tick that has not answered in this long is abandoned; a hung origin must not stack requests. */
export const POLL_TIMEOUT_MS = 2500;

/**
 * @param {object} opts
 * @param {() => string} opts.url       the live record; recomputed per tick so `clientId` is current
 * @param {(doc: object) => void} opts.apply          the page's one render path
 * @param {number} [opts.pollMs]        visible cadence
 * @param {number} [opts.hiddenPollMs]  hidden cadence: slower, never off, so a scene cut finds
 *                                      the record already painted without needing a visibility event
 * @param {number} [opts.timeoutMs]
 * @param {() => boolean} [opts.isHidden]             default: `document.hidden`
 * @param {Function|null} [opts.fetchImpl]            injection point for the stub harness
 */
export function createLivePoll({
  url,
  apply,
  pollMs = POLL_MS,
  hiddenPollMs = HIDDEN_POLL_MS,
  timeoutMs = POLL_TIMEOUT_MS,
  isHidden = () => typeof document !== 'undefined' && Boolean(document.hidden),
  fetchImpl = null,
} = {}) {
  let timer = 0;
  let period = 0; // the interval currently armed: visible or hidden cadence
  let inFlight = false;
  let stopped = false;
  let lastRev;
  /** Fallback identity for a server without `rev`: the body itself, so it is still applied once. */
  let lastBody = '';

  async function poll() {
    if (stopped || inFlight) return 'skip';
    inFlight = true;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const abort = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
    try {
      const res = await (fetchImpl || fetch)(url(), {
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res || !res.ok) return 'error';
      const doc = await res.json();
      if (!doc || typeof doc !== 'object') return 'error';
      // `rev` moves on spawn, close, measure and sweep: the one counter that says "the picture
      // changed". Equal rev means there is nothing to render, so nothing is touched.
      if (typeof doc.rev === 'number') {
        if (doc.rev === lastRev) return 'unchanged';
        lastRev = doc.rev;
        apply(doc);
        return 'applied';
      }
      const body = JSON.stringify(doc);
      if (body === lastBody) return 'unchanged';
      lastBody = body;
      apply(doc);
      return 'applied';
    } catch {
      // A refused connection, a timeout, a 500: no state change. The stack on screen stays as it
      // is and the next tick asks again — one failure never costs an on-air overlay its alerts.
      return 'error';
    } finally {
      if (abort) clearTimeout(abort);
      inFlight = false;
    }
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) clearInterval(timer);
    period = ms;
    timer = setInterval(poll, ms);
  }

  function start() {
    if (stopped || running()) return;
    poll(); // first paint is the same read the page used to do at boot
    schedule(pollMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
    period = 0;
    stopped = true;
    detach();
  }

  function running() {
    return Boolean(timer);
  }

  // A hidden OBS source draws nothing, so it is polled slower, never stopped. CEF's visibility
  // event is an accelerator here, not the wake-up path: if it never fired for a source leaving and
  // re-entering the active scene, a stopped document would stay deaf and a scene cut would present
  // an empty stage. At the hidden cadence the record is at most one tick stale, so a toast that
  // arrived while the scene was inactive is already painted when the cut lands.
  function onVisibility() {
    if (stopped) return;
    if (isHidden()) {
      schedule(hiddenPollMs);
      return;
    }
    poll(); // the fast path: reading at once keeps the visible case at zero added delay
    schedule(pollMs);
  }

  const canListen = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
  function detach() {
    if (canListen) document.removeEventListener('visibilitychange', onVisibility);
  }
  if (canListen) document.addEventListener('visibilitychange', onVisibility);

  return {
    start,
    stop,
    poll,
    onVisibility,
    get lastRev() {
      return lastRev;
    },
    get running() {
      return running();
    },
    /** The interval currently armed (visible or hidden cadence); 0 when stopped. */
    get interval() {
      return period;
    },
  };
}
