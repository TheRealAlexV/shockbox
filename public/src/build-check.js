// Stale-bundle self-heal for the shell and the two popup overlay documents.
//
// Why it exists: a browser document loads its module graph once and then keeps it for as long as
// OBS keeps the source alive. Nothing told a running document that the server had started serving
// a different bundle, so a deploy only reached the screen when a human pressed Refresh in OBS —
// which is how a live census ran six `unowned-stream` rows against code that had been fixed and
// deployed since morning.
//
// So each document compares the build the server names with the one it last loaded, on a slow
// timer, and replaces itself on a mismatch. The failure mode to design out is a reload loop
// (a38): this one reloads at most once per *distinct* build id, and it records the id **before**
// asking for the reload, so a reload that does not change what is served cannot repeat.
//
// What it deliberately is not: a socket. These documents are already why the origin sits at its
// per-origin connection budget, so the check is one short-lived, cache-bypassing GET with an
// abort timeout — no SSE, no `keepalive`, and never two in flight.

/** How often a document asks what the server serves. Slow on purpose: a deploy is not urgent to
 *  the second, and these documents must not spend their socket budget on being polite. */
export const BUILD_POLL_MS = 25000;
/** A poll that has not answered in this long is abandoned, not awaited. */
export const BUILD_TIMEOUT_MS = 5000;
/** Floor between polls, so a manual nudge (the on-air stack emptying) cannot turn into a cadence. */
export const BUILD_MIN_GAP_MS = 3000;

/**
 * Replace this document with a URL the cache cannot answer, so the reload actually fetches the
 * new bundle (a33: the poll ran, the reload re-read yesterday's bytes).
 *
 * `_b` is a different URL, and `/src` is served `no-store` as well — the two together are the
 * whole cache story. `replace` keeps the history clean.
 */
export function hardReload(id) {
  try {
    const url = new URL(location.href);
    url.searchParams.set('_b', String(id || Date.now().toString(16)));
    location.replace(url.toString());
  } catch {
    location.reload();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.url              build endpoint, e.g. `/api/notifications/build`
 * @param {string} opts.key              sessionStorage key; one per document, survives its reload
 * @param {Storage|null} [opts.storage]  sessionStorage; without it the page adopts each served id
 *                                       and never reloads (a smaller feature, never a loop)
 * @param {(id: string) => void} [opts.reload]  what to do on a mismatch (default: hardReload)
 * @param {() => boolean} [opts.canReload]      false defers the reload (an alert is on air); the
 *                                              next poll or {@link check} retries it
 * @param {number} [opts.pollMs]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.minGapMs]
 * @param {Function|null} [opts.fetchImpl]      injection point for the stub harness
 * @param {() => number} [opts.now]
 */
export function createBuildCheck({
  url = '',
  key = 'shockbox.build',
  storage = null,
  reload = hardReload,
  canReload = () => true,
  pollMs = BUILD_POLL_MS,
  timeoutMs = BUILD_TIMEOUT_MS,
  minGapMs = BUILD_MIN_GAP_MS,
  fetchImpl = null,
  now = () => Date.now(),
} = {}) {
  let timer = 0;
  let inFlight = false;
  let lastAt = 0;
  let stopped = false;
  /** A served id this document declined to reload for, because a reload was not safe yet. */
  let deferred = '';

  function read() {
    try {
      const raw = storage && storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && typeof parsed.id === 'string' ? parsed : {};
    } catch {
      return {};
    }
  }

  function write(id) {
    try {
      if (storage) storage.setItem(key, JSON.stringify({ id }));
    } catch {
      /* no storage: the next document adopts whatever is served, which is safe, just blind */
    }
  }

  /**
   * `adopt` (this document is the first to see a build — record it, do not move),
   * `ok` (served build is the one this document loaded),
   * `wait` (a different build, but reloading now would cost something on air),
   * `reload`.
   */
  function decide(served) {
    const record = read();
    if (!record.id) return 'adopt';
    // The one line that makes a second reload impossible for the same build id: the id was
    // written before the reload, so the replacement document reads it back and stops here.
    if (record.id === served) {
      deferred = '';
      return 'ok';
    }
    deferred = served;
    return canReload() ? 'reload' : 'wait';
  }

  /** One poll. Never throws, never reloads on a failed or unreadable answer. */
  async function check() {
    if (stopped || !url || inFlight) return 'skip';
    if (now() - lastAt < minGapMs) return 'skip';
    inFlight = true;
    lastAt = now();

    let served = '';
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const abort = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
    try {
      const res = await (fetchImpl || fetch)(url, {
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined,
      });
      if (!res || !res.ok) return 'error';
      const data = await res.json();
      served = String((data && data.build) || '').slice(0, 64);
    } catch {
      // A 500, a timeout, a closed port: no evidence of a deploy. Stay exactly where we are.
      return 'error';
    } finally {
      if (abort) clearTimeout(abort);
      inFlight = false;
    }
    if (!served) return 'error';

    const verdict = decide(served);
    if (verdict === 'adopt') {
      write(served);
      return verdict;
    }
    if (verdict === 'reload') {
      write(served); // spent before it is asked for: the replacement cannot spend it again
      reload(served);
      return verdict;
    }
    return verdict;
  }

  function start() {
    if (stopped || timer) return;
    check(); // immediate first poll: a document created just before a deploy must still see it
    timer = setInterval(check, pollMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
    stopped = true;
  }

  return {
    start,
    check,
    stop,
    /** The build we are holding back (empty when nothing is deferred). */
    get deferred() {
      return deferred;
    },
  };
}
