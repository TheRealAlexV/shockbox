// Scene ratio forcing: unit test of the state machine (no OBS, no server).
//
// The rules under test:
//   · entering a forcing scene pins the ratio to 16:9 and remembers the operator's choice;
//   · moving between two forcing scenes keeps the original memory (no restore in the middle);
//   · leaving restores exactly once, to the remembered ratio;
//   · a repeated event for the same scene is not an entry;
//   · a reconnect that re-reports the same scene does not overwrite the memory;
//   · a server restart inside a forcing scene restores correctly when the scene is left.
//
//   node test/ratio.mjs

import { createRatioWatcher } from '../modules/wall/ratio.mjs';

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function harness({ ratio = '9:16', saved = null } = {}) {
  const doc = { ratio, forceScenes: ['Desktop', 'Theater', 'PHub', 'OnlyFans', 'CominOut'] };
  const log = [];
  const settings = {
    get: (k) => doc[k],
    set: (k, v) => {
      if (doc[k] === v) return [];
      doc[k] = v;
      log.push(`${k}=${v}`);
      return [k];
    },
  };
  const subs = new Set();
  let scene = null;
  const obs = {
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    currentScene: async () => scene,
    get scene() {
      return scene;
    },
  };
  const persisted = [];
  const w = createRatioWatcher({ settings, obs, log: { info() {}, warn() {} }, persist: (s) => persisted.push(s) });
  if (saved) w.load(saved);
  w.attach();
  return {
    w,
    doc,
    log,
    persisted,
    /** Simulate OBS reporting a scene and wait for the ready-path promises to settle. */
    async go(name) {
      scene = name;
      for (const fn of subs) fn({ type: 'event', eventType: 'CurrentProgramSceneChanged', eventData: { sceneName: name } });
      await Promise.resolve();
    },
    async ready() {
      for (const fn of subs) fn({ type: 'ready' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    current: () => doc.ratio,
  };
}

async function main() {
  // 1. Enter, leave.
  {
    const h = harness({ ratio: '9:16' });
    ok('starts at the operator ratio', h.current() === '9:16', h.current());
    await h.go('Desktop');
    ok('entering Desktop forces 16:9', h.current() === '16:9', h.current());
    await h.go('Main Live');
    ok('leaving restores 9:16', h.current() === '9:16', h.current());
  }

  // 2. Two forcing scenes in a row.
  {
    const h = harness({ ratio: '9:16' });
    await h.go('Desktop');
    await h.go('PHub');
    ok('Desktop -> PHub stays 16:9', h.current() === '16:9', h.current());
    await h.go('Main Live');
    ok('the original ratio survives a chain of forced scenes', h.current() === '9:16', h.current());
  }

  // 3. A repeated event for the same scene is not a new entry.
  {
    const h = harness({ ratio: '9:16' });
    await h.go('Desktop');
    await h.go('Desktop');
    await h.go('Main Live');
    ok('a duplicated scene event does not lose the memory', h.current() === '9:16', h.current());
  }

  // 4. A reconnect inside a forced scene.
  {
    const h = harness({ ratio: '9:16' });
    await h.go('Desktop');
    await h.ready(); // reconnect: current scene is still Desktop
    await h.go('Main Live');
    ok('a reconnect inside a forced scene keeps the memory', h.current() === '9:16', h.current());
  }

  // 5. Restart inside a forced scene: state was persisted, no fresh memory.
  {
    const first = harness({ ratio: '9:16' });
    await first.go('Desktop');
    const saved = first.persisted[first.persisted.length - 1];
    ok('state is persisted on entry', saved && saved.forcing === true, JSON.stringify(saved));
    const second = harness({ ratio: '16:9', saved });
    await second.ready(); // the reconnect reports Desktop
    await second.go('Main Live');
    ok('a restart inside a forced scene still restores 9:16', second.current() === '9:16', second.current());
  }

  // 6. Starting outside any forcing scene changes nothing.
  {
    const h = harness({ ratio: '9:16' });
    await h.go('Main Live');
    ok('a normal scene does not touch the ratio', h.current() === '9:16', h.current());
    ok('nothing is persisted when nothing happened', h.persisted.length === 0, String(h.persisted.length));
  }

  // 7. The operator already had 16:9: leaving does not write a pointless restore.
  {
    const h = harness({ ratio: '16:9' });
    await h.go('Theater');
    await h.go('Main Live');
    ok('leaving when the operator already had 16:9 is a no-op', h.current() === '16:9', h.current());
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
