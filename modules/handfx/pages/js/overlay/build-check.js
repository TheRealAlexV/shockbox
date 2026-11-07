// Build self-heal for the overlay page.
//
// Why it exists: the page learns its build once, at boot (`overlay.html` fetches /api/handfx/build
// then imports `main.js?v=<build>`). Nothing ever tells a running document that the server now
// serves a different bundle, so a deploy reached a page only when a human clicked Refresh in OBS.
// On the rig that cost 231 polls over 20 minutes of synthetic frames while every downstream field
// still read healthy.
//
// So the page compares its own build with the server's on a slow timer and reloads itself on a
// mismatch. A reload loop is the obvious failure mode, so the budget is per *observed server
// build*, persisted across the reload it causes: three self-reloads, then stop and report. A build
// that never matches becomes a visible stale page, never an infinite reload spinner.
//
// No DOM, no timers, no fetch: the page calls `observe()` with what /api/handfx/build answered and
// a stub harness drives the same object with a fake clock (test/handfx-watchdog.mjs).

/** At most this many self-reloads per observed server build, across documents. */
export const MAX_BUILD_RELOADS = 3;

/**
 * @param {object} opts
 * @param {string} opts.ownBuild          the build this document loaded with (`?v=`)
 * @param {() => void} [opts.reload]      restart the document; called at most `maxReloads` times
 * @param {() => number} [opts.now]       the clock (defaults to Date.now)
 * @param {number} [opts.maxReloads]      per-build budget
 * @param {{getItem(k:string):string|null,setItem(k:string,v:string):void}|null} [opts.storage]
 *        survives the reload (sessionStorage); without it the budget is one per document
 * @param {string} [opts.key]             the storage key
 */
export function createBuildCheck({
  ownBuild,
  reload = () => {},
  now = () => Date.now(),
  maxReloads = MAX_BUILD_RELOADS,
  storage = null,
  key = 'handfx.buildReloads',
} = {}) {
  const own = String(ownBuild || '');
  let observed = ''; // last server build seen
  let staleSince = 0; // first mismatch against `observed`, 0 while matched or unknown
  let reloads = 0; // self-reloads spent on `observed`, restored across documents
  let lastReloadAt = 0;
  let stopped = false;
  let reloadedHere = false; // this document already asked to be replaced

  function readAll() {
    try {
      const raw = storage && storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** The persisted budget for one server build. A new build starts a fresh one. */
  function load(build) {
    const rec = readAll()[build];
    reloads = rec && Number.isFinite(rec.reloads) ? Math.max(0, rec.reloads | 0) : 0;
    lastReloadAt = rec && Number.isFinite(rec.lastReloadAt) ? Math.max(0, rec.lastReloadAt) : 0;
    stopped = reloads >= maxReloads;
  }

  function save() {
    if (!storage) return;
    try {
      const all = readAll();
      all[observed] = { reloads, lastReloadAt };
      // A build id is a content hash: keep only the newest few so this cannot grow in the source.
      const builds = Object.keys(all).slice(-4);
      const trimmed = {};
      for (const b of builds) trimmed[b] = all[b];
      storage.setItem(key, JSON.stringify(trimmed));
    } catch {
      /* no storage is a smaller budget, not a failure */
    }
  }

  /**
   * Feed the server's current build in. Returns what the caller should do:
   * `ok` (matched), `reload` (a reload was requested), `reloading` (it already was, this
   * document is about to be replaced), `stop` (budget spent — report it), `unknown` (no build on
   * either side yet).
   */
  function observe(serverBuild) {
    const seen = String(serverBuild || '');
    if (!own || !seen) return 'unknown';
    if (seen === own) {
      observed = seen;
      staleSince = 0;
      stopped = false;
      return 'ok';
    }
    if (seen !== observed) {
      // A different server build is a different mismatch: its own budget, its own clock.
      observed = seen;
      staleSince = 0;
      reloadedHere = false;
      load(seen);
    }
    if (!staleSince) staleSince = now();
    // One reload per document, whatever the poll cadence: a reload that did not take effect
    // (a blocked or ignored `location.reload`) must not become three presses.
    if (reloadedHere) return 'reloading';
    if (stopped || reloads >= maxReloads) {
      stopped = true;
      return 'stop';
    }
    reloads += 1;
    lastReloadAt = now();
    reloadedHere = true;
    save();
    reload();
    return 'reload';
  }

  /** What the ack carries, so /status can show the reload happened instead of guessing. */
  function state() {
    return {
      stale: Boolean(staleSince) && observed !== own,
      staleSince,
      reloads,
      lastReloadAt,
      stopped,
      observed,
    };
  }

  return { observe, state };
}
