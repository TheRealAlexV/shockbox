// Stub harness for the shared stale-bundle check — no browser, no server, no clock.
//
// What it proves:
//   · a document adopts the build it boots on and never reloads for it
//   · a build change causes exactly ONE navigation, and the document that replaces it does not
//     navigate again (a38 was a cadence; this is one event per distinct build id)
//   · a poll that fails, times out or answers non-200 is not evidence of a deploy: no navigation
//   · a reload deferred because something is on air happens once, when it is safe
//
//   node test/build-check.mjs
// Exits non-zero on the first failed check.

import { createBuildCheck } from '../public/src/build-check.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => map,
  };
}

/**
 * One page's worth of check, wired to a fake server.
 * `served` is what /build answers; `healthy` false makes the request throw.
 */
function harness({ storage = memoryStorage(), served = 'aaa', healthy = true, canReload = () => true } = {}) {
  const page = {
    storage,
    served,
    healthy,
    canReload,
    reloads: [],
    polls: 0,
  };
  const check = createBuildCheck({
    url: '/api/notifications/build',
    key: 'shockbox.build.test',
    storage,
    minGapMs: 0,
    canReload: () => page.canReload(),
    reload: (id) => page.reloads.push(id),
    fetchImpl: async () => {
      page.polls += 1;
      if (!page.healthy) throw new Error('ECONNREFUSED');
      return { ok: page.healthy, json: async () => ({ build: page.served }) };
    },
  });
  return { page, check };
}

// 1. Boot adopts; the same build never moves the page.
{
  const { page, check: c } = harness();
  const a = await c.check();
  const b = await c.check();
  check('first poll adopts the served build', a === 'adopt', a);
  check('same build is a no-op on the next poll', b === 'ok', b);
  check('no navigation while the build is unchanged', page.reloads.length === 0, page.reloads.join(','));
}

// 2. A build change is exactly one navigation, and the replacement document stays put.
{
  const { page, check: c } = harness();
  await c.check(); // adopt aaa
  page.served = 'bbb';
  const first = await c.check();
  check('a build change asks for a reload', first === 'reload', first);
  check('the reload carries the new build id', page.reloads.length === 1 && page.reloads[0] === 'bbb', page.reloads.join(','));

  // The document that comes back is a new check over the same sessionStorage.
  const replacement = harness({ storage: page.storage, served: 'bbb' });
  const after = await replacement.check.check();
  check('the replacement adopts the id it was reloaded into', after === 'ok', after);
  check('the replacement does not navigate again', page.reloads.length === 1, `total ${page.reloads.length}`);

  // And a document that keeps polling the same new build cannot turn it into a cadence.
  for (let i = 0; i < 20; i += 1) await replacement.check.check();
  check('20 more polls on the new build: still exactly one navigation', page.reloads.length === 1, `total ${page.reloads.length}`);
}

// 3. A failed poll is not a deploy.
{
  const { page, check: c } = harness();
  await c.check(); // adopt aaa
  page.served = 'bbb';
  page.healthy = false;
  const verdicts = [];
  for (let i = 0; i < 5; i += 1) verdicts.push(await c.check());
  check('a refused connection never reloads', page.reloads.length === 0, JSON.stringify(verdicts));
  check('a refused connection is reported, not swallowed as ok', verdicts.every((v) => v === 'error'), JSON.stringify(verdicts));

  // A 500 that still answers JSON must not count either.
  page.healthy = true;
  const c500 = createBuildCheck({
    url: '/b',
    key: 'k',
    storage: page.storage,
    minGapMs: 0,
    reload: (id) => page.reloads.push(id),
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ build: 'bbb' }) }),
  });
  await c500.check();
  check('a non-200 answer never reloads', page.reloads.length === 0, page.reloads.join(','));

  // The page still converges once the server answers again.
  page.healthy = true;
  const late = await c.check();
  check('a recovered poll still converges on the new build', late === 'reload' && page.reloads.length === 1, late);
}

// 4. Deferred while something is on air, then exactly once when it is safe.
{
  let safe = false;
  const { page, check: c } = harness({ canReload: () => safe });
  await c.check(); // adopt aaa
  page.served = 'bbb';
  const held = await c.check();
  check('a reload is deferred while a notification is live', held === 'wait', held);
  check('deferring costs no navigation', page.reloads.length === 0, page.reloads.join(','));
  check('the deferred build id is visible to the caller', c.deferred === 'bbb', c.deferred);
  safe = true;
  const now = await c.check();
  check('the deferred reload happens once it is safe', now === 'reload' && page.reloads.length === 1, now);
  await c.check();
  check('and not twice', page.reloads.length === 1, page.reloads.join(','));
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exitCode = 1;
} else {
  console.log('\nbuild-check: all checks passed');
}
