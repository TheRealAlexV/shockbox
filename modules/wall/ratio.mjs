// Scene ratio forcing.
//
// Some scenes must run the wall at 16:9 whatever the operator last chose (Desktop, Theater,
// PHub, OnlyFans, CominOut): the wall is scenery there, not a portrait display. Entering one of
// them forces 16:9; leaving restores the ratio that was in force before.
//
// The state machine is edge-triggered on the *previous* scene, not on every event:
//   · OBS re-emits CurrentProgramSceneChanged for the same scene on a reconnect, and a level
//     check would re-force (harmless) but also overwrite the remembered "before" (not harmless);
//   · a change between two forcing scenes must not lose the original ratio.
// The remember slot is persisted, so a server restart inside a forcing scene restores the right
// ratio when the operator leaves it rather than the default.

import { num } from '../../core/id.mjs';

const DEFAULTS = ['Desktop', 'Theater', 'PHub', 'OnlyFans', 'CominOut'];

export function createRatioWatcher({ settings, obs, log, persist, sceneList: sceneListFn = null, effective = null }) {
  const FORCED = '16:9';
  let lastScene = null;
  let before = null;      // ratio in force before the first forcing scene was entered
  let forcing = false;    // we are the one who changed the ratio: leave must restore it
  let restore = null;     // what to restore on leave; null = nothing to do

  function sceneList() {
    const list = typeof sceneListFn === 'function' ? sceneListFn() : settings.get('forceScenes');
    return Array.isArray(list) && list.length ? list : DEFAULTS;
  }

  function isForcing(scene) {
    return Boolean(scene) && sceneList().includes(scene);
  }

  function setRatio(ratio, why) {
    // Compare what the wall is running, not the stored token: 'default' resolves through the
    // core ratio, and writing 16:9 over it would silently pin an operator who chose "default".
    const cur = typeof effective === 'function' ? effective() : settings.get('ratio');
    if (cur === ratio) return;
    settings.set('ratio', ratio);
    log.info(`ratio -> ${ratio} (${why})`);
  }

  /** Restore anything the watcher owns — used on fresh start and on a reconnect. */
  function sync(scene, { reconnect = false } = {}) {
    const next = scene || null;
    const was = lastScene;
    lastScene = next;
    // A reconnect re-reports the same scene: do not treat it as an entry.
    if (reconnect && next === was) return;

    if (isForcing(next)) {
      if (!forcing) {
        // Entering: remember what the operator had chosen, unless a restart already did.
        before = restore && restore.ratio ? restore.ratio : settings.get('ratio');
        forcing = true;
        // Persist the *entry* state (forcing + the memory), so a restart inside this scene can
        // still restore on the way out.
        restore = { ratio: before, scene: next };
        saving();
      }
      setRatio(FORCED, `scene "${next}" forces 16:9`);
      return;
    }

    // Leaving (or starting on a non-forcing scene).
    if (forcing) {
      forcing = false;
      const back = (restore && restore.ratio) || before;
      restore = null;
      saving();
      if (back && back !== FORCED) setRatio(back, 'left forced scene — restored');
      else if (back === FORCED) log.info('left forced scene — operator had 16:9 anyway');
    }
  }

  function saving() {
    try {
      if (typeof persist === 'function') persist({ lastScene, before, forcing, restore });
    } catch (err) {
      log.warn(`ratio state not saved: ${err.message}`);
    }
  }

  function load(saved) {
    if (!saved || typeof saved !== 'object') return;
    // `lastScene` too: a restart inside a forcing scene must still name the scene that forces,
    // or the pane shows off / null and a "force 16:9" has no scene to reason about.
    if (typeof saved.lastScene === 'string') lastScene = saved.lastScene;
    if (typeof saved.before === 'string') before = saved.before;
    if (typeof saved.forcing === 'boolean') forcing = saved.forcing;
    if (saved.restore && typeof saved.restore === 'object') restore = saved.restore;
  }

  /**
   * Attach to OBS. The first event after `ready` is the level check; from then on each scene
   * change is an edge. A watcher with no OBS (dev server) stays inert without erroring.
   */
  function attach() {
    if (!obs || typeof obs.subscribe !== 'function') return () => {};
    return obs.subscribe((msg) => {
      if (msg.type === 'ready') {
        Promise.resolve()
          .then(() => obs.currentScene())
          .then((s) => {
            // After a reconnect the scene may be unchanged; after a start it is the entry.
            sync(s, { reconnect: true });
            saving();
          })
          .catch((err) => log.warn(`ratio: cannot read the current scene (${err.message})`));
        return;
      }
      if (msg.type !== 'event') return;
      if (msg.eventType !== 'CurrentProgramSceneChanged' && msg.eventType !== 'SceneChanged') return;
      const name = msg.eventData?.sceneName;
      if (!name) return;
      sync(name);
    });
  }

  return {
    attach,
    load,
    sync,
    get state() {
      return { lastScene, before, forcing, restore, forced: sceneList() };
    },
    /** Re-run the level check against the live scene (deck key / pane button / reconnect). */
    enforce() {
      const scene = (obs && typeof obs.scene === 'string' && obs.scene) || lastScene;
      // reconnect:true makes this a level check: the same scene is not an entry, so the memory
      // slot survives a redundant call.
      sync(scene, { reconnect: true });
    },
  };
}

// Guard against a schema that stores the scene list as a JSON string (an older settings file).
export function normaliseSceneList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s)).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}
