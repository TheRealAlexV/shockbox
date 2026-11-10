// Server-side watchdog for the ShockFX OBS browser source.
//
// Why this exists: when the `Main Live` scene is off air, CEF discards the long-hidden page.
// `pagehide` fires the page's `releaseSockets()` and the document is gone. The server can mark the
// client stale forever, but no server-side command can reach a document that no longer exists.
// On this OBS build the only thing that revives it is the browser source's own Refresh hotkey
// (`ObsBrowser.Refresh`, context = source name). `TriggerMediaInputAction RESTART` returns success
// and does nothing, and re-applying identical `SetInputSettings` does nothing because the reload
// only fires when the URL changes.
//
// The rule this file enforces, and why:
//   dead document + source genuinely showing  → fire the hotkey (the overlay comes back)
//   dead document + source hidden             → never fire: CEF would discard the reloaded page
//                                               again immediately, which is a reload loop
//   live document                             → never fire; reset every counter
//   OBS disconnected                          → never fire; nothing can be verified
//
// `decide()` is pure: no timers, no OBS, no logging, so the policy is testable without either.
// `createSourceWatchdog()` is the thin wrapper that polls OBS, feeds `decide()`, and fires.

export const WATCHDOG_DEFAULTS = Object.freeze({
  /** The browser source in the `Main Live` scene. */
  sourceName: 'ShockFX',
  /** The browser source's Refresh hotkey. */
  hotkeyName: 'ObsBrowser.Refresh',
  /** How often the document is checked. */
  intervalMs: 12_000,
  /**
   * No ack for this long means the document is gone. The live page acks twice a second, so 45 s
   * is 90 missed acks — unambiguous, not a GC pause.
   */
  deadAfterMs: 45_000,
  /** Minimum gap between two fires, whatever else says. */
  minFireGapMs: 60_000,
  /** Fires in a row without the document returning, then stop and say so. */
  maxConsecutiveFires: 3,
});

/**
 * Decide what one tick should do. Pure.
 *
 * Inputs (one object):
 *   now               ms epoch for this tick
 *   startedAt         ms epoch the watchdog started; with `lastAckAt === 0` this is the boot grace
 *   lastAckAt         newest page ack across clientsById (0 when nothing ever acked)
 *   obsReady          obs-websocket identified
 *   active            GetSourceActive.videoActive
 *   showing           GetSourceActive.videoShowing
 *   lastFireAt        0, or ms epoch of the last hotkey fire
 *   consecutiveFires  fires since the document was last seen alive
 *   gaveUp            the fire budget was spent and the document has not returned
 *
 * Output:
 *   fire              true when the caller must trigger `hotkeyName` for `sourceName`
 *   decision          'alive' | 'booting' | 'obs-down' | 'gave-up' | 'hidden' | 'backoff' | 'fire'
 *   reason            one operator-readable sentence
 *   deadForMs         null when no ack has ever arrived, else now - lastAckAt
 *   state             { lastFireAt, consecutiveFires, gaveUp } to carry into the next tick
 */
export function decide({
  now,
  startedAt = now,
  lastAckAt = 0,
  obsReady = false,
  active = false,
  showing = false,
  lastFireAt = 0,
  consecutiveFires = 0,
  gaveUp = false,
  config = WATCHDOG_DEFAULTS,
}) {
  const deadForMs = lastAckAt > 0 ? Math.max(0, now - lastAckAt) : null;
  const alive = lastAckAt > 0 && deadForMs <= config.deadAfterMs;
  const deadLabel = deadForMs == null ? 'never acked' : `dead ${formatMs(deadForMs)}`;

  // 1. A live document needs nothing, and every counter starts over.
  if (alive) {
    return {
      fire: false,
      decision: 'alive',
      reason: `page acked ${formatMs(deadForMs)} ago`,
      deadForMs,
      state: { lastFireAt: 0, consecutiveFires: 0, gaveUp: false },
    };
  }

  // 2. A document that has never acked is booting, not dead. Model fetch plus worker handshake
  //    takes ~10 s, and this is the normal state for the first seconds after every node restart;
  //    firing here would restart the page's boot mid-flight and can burn the whole budget before
  //    the page ever loads. The grace is measured from the watchdog's own start, not from the
  //    page, because a dead predecessor's timestamp is not a boot signal.
  const bootForMs = Math.max(0, now - startedAt);
  if (lastAckAt === 0 && bootForMs <= config.deadAfterMs) {
    return {
      fire: false,
      decision: 'booting',
      reason: `no ack yet in ${formatMs(bootForMs)} since start; within the ${formatMs(config.deadAfterMs)} boot grace`,
      deadForMs,
      state: { lastFireAt, consecutiveFires, gaveUp },
    };
  }

  // 3. Without a live obs-websocket nothing can be verified, so nothing may fire.
  if (!obsReady) {
    return {
      fire: false,
      decision: 'obs-down',
      reason: `${deadLabel}; obs-websocket is not connected`,
      deadForMs,
      state: { lastFireAt, consecutiveFires, gaveUp },
    };
  }

  // 4. The budget is spent and the document has not been seen alive since. Stop trying.
  if (gaveUp) {
    return {
      fire: false,
      decision: 'gave-up',
      reason: `${deadLabel}; gave up after ${config.maxConsecutiveFires} fires without recovery (active=${active}, showing=${showing})`,
      deadForMs,
      state: { lastFireAt, consecutiveFires, gaveUp },
    };
  }

  // 5. A hidden source must not be reloaded: CEF discards the fresh page again immediately.
  if (!active && !showing) {
    return {
      fire: false,
      decision: 'hidden',
      reason: `${deadLabel}; source not showing (active=${active}, showing=${showing}), not firing`,
      deadForMs,
      state: { lastFireAt, consecutiveFires, gaveUp },
    };
  }

  // 5. Never more than one fire per gap.
  const sinceFireMs = lastFireAt > 0 ? Math.max(0, now - lastFireAt) : null;
  if (sinceFireMs != null && sinceFireMs < config.minFireGapMs) {
    return {
      fire: false,
      decision: 'backoff',
      reason: `${deadLabel}; last fire ${formatMs(sinceFireMs)} ago, waiting for ${formatMs(config.minFireGapMs)} (active=${active}, showing=${showing})`,
      deadForMs,
      state: { lastFireAt, consecutiveFires, gaveUp },
    };
  }

  // 6. Defensive: the budget is checked here too so a caller that forgot to carry `gaveUp`
  //    cannot fire a fourth time.
  if (consecutiveFires >= config.maxConsecutiveFires) {
    return {
      fire: false,
      decision: 'gave-up',
      reason: `${deadLabel}; ${consecutiveFires} fires without recovery (active=${active}, showing=${showing})`,
      deadForMs,
      state: { lastFireAt, consecutiveFires, gaveUp: true },
    };
  }

  // 7. Dead + genuinely showing + budget left → fire.
  const nextCount = consecutiveFires + 1;
  const finalAttempt = nextCount >= config.maxConsecutiveFires;
  return {
    fire: true,
    decision: 'fire',
    reason:
      `${deadLabel}; source showing (active=${active}, showing=${showing}), ` +
      `fire ${nextCount}/${config.maxConsecutiveFires}` +
      (finalAttempt ? ' (last attempt)' : ''),
    deadForMs,
    state: { lastFireAt: now, consecutiveFires: nextCount, gaveUp: finalAttempt },
  };
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'forever';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Thin wrapper. Every `intervalMs`, ask OBS what the source is doing, let `decide()` pick, log the
 * decision on change (so a hidden source does not fill the log every tick), and fire when told.
 */
export function createSourceWatchdog({ obs, getSnapshot, log, ...overrides } = {}) {
  const config = { ...WATCHDOG_DEFAULTS, ...overrides };
  const startedAt = Date.now();
  let state = { lastFireAt: 0, consecutiveFires: 0, gaveUp: false };
  let lastDecision = null;
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) return null; // a slow OBS round-trip must not stack ticks
    ticking = true;
    try {
      const now = Date.now();
      const snap = (typeof getSnapshot === 'function' ? getSnapshot() : null) || {};
      let obsReady = false;
      let active = false;
      let showing = false;
      let obsError = null;

      try {
        obsReady = Boolean(obs && typeof obs.ready === 'function' && obs.ready());
      } catch (err) {
        obsError = err.message;
      }
      if (obsReady) {
        try {
          const r = await obs.request('GetSourceActive', { sourceName: config.sourceName });
          active = r ? r.videoActive === true : false;
          showing = r ? r.videoShowing === true : false;
        } catch (err) {
          // Not verified as showing → must not fire.
          obsReady = false;
          obsError = err.message;
        }
      }

      const out = decide({
        now,
        startedAt,
        lastAckAt: snap.lastAckAt || 0,
        obsReady,
        active,
        showing,
        ...state,
        config,
      });
      state = out.state;

      const detail =
        `active=${active} showing=${showing} ` +
        `dead=${out.deadForMs == null ? 'never-acked' : formatMs(out.deadForMs)}` +
        (obsError ? ` obsError=${obsError}` : '');
      if (out.decision !== lastDecision) {
        log.info(`watchdog ${config.sourceName}: ${out.decision} — ${out.reason} (${detail})`);
        lastDecision = out.decision;
      }

      if (out.fire) {
        log.warn(
          `watchdog ${config.sourceName}: firing ${config.hotkeyName} (context=${config.sourceName}) ` +
            `attempt ${state.consecutiveFires}/${config.maxConsecutiveFires} — ${detail}`,
        );
        try {
          await obs.request('TriggerHotkeyByName', {
            hotkeyName: config.hotkeyName,
            contextName: config.sourceName,
          });
        } catch (err) {
          log.warn(`watchdog ${config.sourceName}: ${config.hotkeyName} failed — ${err.message}`);
        }
      }
      return out;
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, config.intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    config,
    get state() {
      return { ...state };
    },
  };
}
