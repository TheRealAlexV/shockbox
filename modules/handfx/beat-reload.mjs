// Server-side self-heal for a document whose JS context is gone.
//
// The proof that it is gone, and not merely busy: `draws` frozen *and* `lastAckAt` frozen at the
// same millisecond. Acks and beats run on a worker with their own 500 ms and 1 s timers
// (`ack-worker.js`), so a throw, a blocked main thread or a paused compositor all still ack. A row
// that stops both is a document whose context died, and no server-side command can reach it: the
// SSE is still open, so `publish('reload')` is written into a socket nobody reads. What it can do is
// reach the *reconnect* after the source's own revive (source-watchdog) — and, on any page where the
// context is only wedged, the bus handler still runs it.
//
// Policy (`sweep` is the whole rule, so it is testable with no server):
//   fresh beat                       → never reload, and forget the attempt history
//   beat older than `staleMs`        → reload once, then honour `gapMs` before the next
//   `max` attempts without a beat    → stop: a reload loop is worse than a dead page
//   hidden document                  → never reload: CEF discards a reloaded hidden page, and the
//                                      beat's `setInterval` is throttled while hidden, so a quiet
//                                      beat there is not evidence of death
//   preview / another role / no beat → never: the preview is a viewer, and the wall pages must not
//                                      be touched on air
//
// The wall pages are safe twice over: they do not live on the `handfx` bus channel.

export const BEAT_HEAL_DEFAULTS = Object.freeze({
  /** Ten times the beat's own cadence, and far past the ~2 s software-GL shader compile at boot. */
  staleMs: 15_000,
  /** Between two reloads of the same client: long enough for a document to boot and beat once. */
  gapMs: 30_000,
  /** Attempts per client without a beat in between. A wedged document gets three, then quiet. */
  max: 3,
  /** Only the ShockFX overlay's own role. */
  role: '/shockfx',
});

/**
 * One healer, one map of attempts. `reload(clientId, reason)` is the effect (the server publishes
 * the bus command); everything else here is policy. Attempt history is dropped as soon as a beat
 * arrives, so a document that recovers — or that is replaced by a reload — starts clean.
 */
export function createBeatHealer({ reload, staleMs = BEAT_HEAL_DEFAULTS.staleMs, gapMs = BEAT_HEAL_DEFAULTS.gapMs, max = BEAT_HEAL_DEFAULTS.max, role = BEAT_HEAL_DEFAULTS.role, log = null } = {}) {
  if (typeof reload !== 'function') throw new Error('createBeatHealer needs a reload() effect');
  const attempts = new Map(); // clientId -> { count, at }

  /** Forget a client's history: a beat means it is alive, and a gone row means a new document. */
  function prune(rows) {
    const live = new Set();
    for (const c of rows || []) if (c && c.id) live.add(c.id);
    for (const id of attempts.keys()) if (!live.has(id)) attempts.delete(id);
  }

  /**
   * Which live clients to reload now. Pure in the sense that matters: every input is an argument,
   * and the only output besides the returned list is `reload()` per chosen client.
   */
  function sweep(rows, now = Date.now()) {
    const fired = [];
    for (const c of rows || []) {
      if (!c || !c.id) continue;
      if (c.preview === true) continue;
      if (role && c.role && c.role !== role) continue;
      // A row nobody has heard from yet has no beat to be stale against.
      const beatAt = Math.max(c.beatAt || 0, 0);
      if (!beatAt) continue;
      // A hidden document is not evidence and not a candidate: CEF discards a reloaded hidden page,
      // and a hidden `setInterval` is throttled, so a quiet beat there proves nothing.
      if (c.hidden === true || c.visibility === 'hidden') continue;
      const age = Math.max(0, now - beatAt);
      if (age <= staleMs) {
        attempts.delete(c.id); // a beat arrived: alive, and its budget is whole again
        continue;
      }
      const prev = attempts.get(c.id);
      if (prev && now - prev.at < gapMs) continue;
      if (prev && prev.count >= max) continue; // gave up: leave the row for the reaper
      const count = (prev ? prev.count : 0) + 1;
      attempts.set(c.id, { count, at: now });
      fired.push({ id: c.id, count, staleMs: age });
      try {
        reload(c.id, `beat-stale ${Math.round(age / 1000)}s (attempt ${count}/${max})`);
      } catch (err) {
        if (log && typeof log.warn === 'function') log.warn(`handfx heal: reload failed clientId=${c.id}: ${err && err.message}`);
      }
    }
    prune(rows);
    return fired;
  }

  return { sweep, attempts };
}
