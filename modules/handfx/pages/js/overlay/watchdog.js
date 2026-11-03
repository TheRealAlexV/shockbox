// Liveness watchdog for the overlay page.
//
// Why it exists: an OBS browser source has no tab to reload. When the server restarts, the page's
// fetch streams and acks fail, the relay reader ends, and nothing in the page ever tries again —
// /status reads `cameraFeed.clients 0`, `publish.stage "stalled"`, and a `reload` command cannot
// reach a page whose own connection is gone. Only an OBS-side source refresh fixed it.
//
// So the page checks its own connection. No successful ack for `staleMs` (or a probe that fails)
// means the server is gone: probe it with capped exponential backoff, and on the first success run
// `recover`, which tears down and re-arms the whole overlay path. A hard cap on attempts per page
// life means a server that never comes back cannot become a reconnect storm.
//
// No DOM, no timers, no fetch: the page calls `tick()` from its own 1 s interval, and a stub
// harness can drive the same object with a fake clock (test/handfx-watchdog.mjs).

/**
 * @param {object} opts
 * @param {() => Promise<any>} opts.probe   asks the server something cheap; throws when it is down
 * @param {(value: any) => any} opts.recover  re-arms the page; called once per successful probe
 * @param {() => number} [opts.now]          the clock (defaults to Date.now)
 * @param {number} [opts.staleMs]            silence that means the connection is gone
 * @param {number} [opts.baseMs]             first retry gap
 * @param {number} [opts.capMs]              largest retry gap
 * @param {number} [opts.maxAttempts]        hard cap on probes per page life
 * @param {(status: object) => void} [opts.onState]  one call per attempt/give-up
 */
export function createWatchdog({
  probe,
  recover = () => {},
  now = () => Date.now(),
  staleMs = 5000,
  baseMs = 500,
  capMs = 10000,
  maxAttempts = 40,
  onState = () => {},
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('watchdog: probe is required');
  let lastOkAt = -1; // when the page last heard from the server (-1 = never)
  let streak = 0; // consecutive failed probes: the backoff index
  let attempts = 0; // probes made this page life: the hard cap
  let nextAt = 0; // earliest time the next probe may run
  let busy = false;
  let gaveUp = false;

  /** Retry gap after the n-th consecutive failure: base, 2×, 4× … capped. */
  function backoff(n) {
    return Math.min(capMs, baseMs * 2 ** Math.max(0, n - 1));
  }

  function status(at = now()) {
    const age = lastOkAt >= 0 ? at - lastOkAt : null;
    return {
      state: gaveUp ? 'gave-up' : age === null ? 'never' : age > staleMs ? 'stale' : 'ok',
      attempts,
      streak,
      lastOkAgeMs: age === null ? null : Math.round(age),
      nextRetryMs: gaveUp || !nextAt || nextAt <= at ? 0 : Math.round(nextAt - at),
      staleMs,
      maxAttempts,
    };
  }

  /** The page heard from the server (a successful ack): clear the streak and the pending gap. */
  function ok(at = now()) {
    lastOkAt = at;
    streak = 0;
    nextAt = 0;
    return status(at);
  }

  /**
   * One check. Cheap when healthy (a timestamp compare); does nothing while a probe is in flight,
   * while the backoff is still running, or after the page has spent its attempts.
   */
  async function tick(at = now()) {
    if (busy || gaveUp) return status(at);
    if (lastOkAt >= 0 && at - lastOkAt <= staleMs) return status(at);
    if (attempts >= maxAttempts) {
      gaveUp = true;
      onState(status(at));
      return status(at);
    }
    if (at < nextAt) return status(at);
    busy = true;
    attempts += 1;
    streak += 1;
    try {
      const value = await probe();
      // Probe answered: the server is back. Recovery may still fail on its own, but the page is
      // no longer deaf, and the next silence re-arms this watchdog from a fresh streak.
      lastOkAt = now();
      streak = 0;
      nextAt = 0;
      await recover(value);
    } catch {
      nextAt = now() + backoff(streak);
      onState(status());
      return status();
    } finally {
      busy = false;
    }
    onState(status());
    return status();
  }

  return { tick, ok, status, backoff };
}
