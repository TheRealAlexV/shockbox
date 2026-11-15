// Server-side self-heal for a document whose JS context is gone.
//
// The proof that it is gone, and not merely busy: `draws` frozen *and* the page heard from by
// neither signal at the same time. The two signals have different clocks and that matters:
//   · `lastAckAt` comes from `/ack`, posted by `ack-worker.js` on its own 500 ms timer, so it keeps
//     arriving through a throw, a blocked main thread or a paused compositor;
//   · `beatAt` comes from `beat()` in `main.js`, an `<img>` GET on a 1 s *main-thread* timer, so a
//     model load, a GL compile or a long JPEG decode silences it while the page is perfectly alive.
// Liveness is therefore the newer of the two, never the beat alone. A main-thread stall with acks
// still landing is a busy page and must not be reloaded; only both going quiet is death. A row that
// stops both is a document whose context died, and no server-side command can reach it: the SSE is
// still open, so `publish('reload')` is written into a socket nobody reads. What it can do is
// reach the *reconnect* after the source's own revive (source-watchdog) — and, on any page where the
// context is only wedged, the bus handler still runs it.
//
// Policy (`sweep` is the whole rule, so it is testable with no server):
//   fresh ack or beat                → never reload, and forget the attempt history
//   both quieter than `staleMs`      → reload once, then honour `gapMs` before the next
//   `max` attempts without a word     → stop: a reload loop is worse than a dead page
//   hidden document                  → never reload: CEF discards a reloaded hidden page, and both
//                                      timers are throttled while hidden, so a quiet row there is
//                                      not evidence of death
//   preview / another role / no word → never: the preview is a viewer, and the wall pages must not
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
      // Only a row that proves it is the on-air page is ever ours to reload, and that proof is its
      // ack's `role` — the beat GET carries no role at all (main.js `beat()`), so a row that has only
      // ever beaten is unclassifiable: a preview, a pane, a second document. Unknown is not a match.
      if (!c.role || c.role !== role) continue;
      // The newer of the two signals, not the beat alone: `lastAckAt` is worker-driven and survives a
      // main-thread stall, so a busy page with a late beat is still heard from. Same row-liveness
      // rule as `clientAlive` in server.js; the window here is this healer's own.
      const heard = Math.max(c.beatAt || 0, c.lastAckAt || 0);
      if (!heard) continue;
      // A hidden document is not evidence and not a candidate: CEF discards a reloaded hidden page,
      // and a hidden `setInterval` is throttled, so a quiet row there proves nothing.
      if (c.hidden === true || c.visibility === 'hidden') continue;
      const age = Math.max(0, now - heard);
      if (age <= staleMs) {
        attempts.delete(c.id); // a word arrived: alive, and its budget is whole again
        continue;
      }
      const prev = attempts.get(c.id);
      if (prev && now - prev.at < gapMs) continue;
      if (prev && prev.count >= max) continue; // gave up: leave the row for the reaper
      const count = (prev ? prev.count : 0) + 1;
      attempts.set(c.id, { count, at: now });
      fired.push({ id: c.id, count, silentMs: age });
      try {
        reload(c.id, `silent ${Math.round(age / 1000)}s (attempt ${count}/${max})`);
      } catch (err) {
        if (log && typeof log.warn === 'function') log.warn(`handfx heal: reload failed clientId=${c.id}: ${err && err.message}`);
      }
    }
    prune(rows);
    return fired;
  }

  return { sweep, attempts };
}
