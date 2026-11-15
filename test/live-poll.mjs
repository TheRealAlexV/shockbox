// Stub harness for the shared live poll — no browser, no server, no clock.
//
// What it proves, per the conversion off a held EventSource:
//   · an unchanged `rev` renders nothing (a quiet rig costs no repaints)
//   · a `rev` bump renders exactly once, not once per poll
//   · a failed poll leaves the on-screen live set alone and is reported, not swallowed as "empty"
//   · a hidden document keeps polling on a slower cadence and still applies a change that landed
//     while hidden, so a scene cut never presents an empty stage and no visibility event is load
//     bearing; becoming visible reads at once
//   · every request is bounded and cache-bypassing: no `keepalive`, one in flight
//
//   node test/live-poll.mjs
// Exits non-zero on the first failed check.

import { createLivePoll, HIDDEN_POLL_MS, POLL_MS } from '../public/src/live-poll.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * One overlay document's poll, wired to a fake server.
 * `served` is the live record the endpoint answers; `healthy` false makes the request throw.
 */
function harness({ served = { rev: 0, live: [] }, healthy = true } = {}) {
  const page = {
    served,
    healthy,
    hidden: false,
    applied: [],
    opts: [],
    aborted: 0,
  };
  const poll = createLivePoll({
    url: () => '/api/notifications/live?clientId=abc&role=%2Fnotify',
    apply: (doc) => page.applied.push(doc),
    isHidden: () => page.hidden,
    fetchImpl: async (url, opts) => {
      page.opts.push(opts);
      if (!page.healthy) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => page.served };
    },
  });
  return { page, poll };
}

// 1. An unchanged rev renders nothing; a bump renders exactly once.
{
  const { page, poll } = harness();
  const first = await poll.poll();
  const again = await poll.poll();
  const third = await poll.poll();
  check('the first tick renders the record', first === 'applied', first);
  check('an unchanged rev renders nothing', again === 'unchanged' && third === 'unchanged', `${again}/${third}`);
  check('exactly one render so far', page.applied.length === 1, String(page.applied.length));

  page.served = { rev: 1, live: [{ id: 'n1' }] };
  const bumped = await poll.poll();
  const echoed = await poll.poll();
  check('a rev bump renders exactly once', bumped === 'applied' && echoed === 'unchanged', `${bumped}/${echoed}`);
  check('two renders total', page.applied.length === 2, String(page.applied.length));
  check('the render carried the new record', page.applied[1].live.length === 1, JSON.stringify(page.applied[1]));
}

// 2. A failed poll changes nothing on screen.
{
  const { page, poll } = harness();
  await poll.poll(); // rev 0 applied
  page.healthy = false;
  const verdicts = [];
  for (let i = 0; i < 4; i += 1) verdicts.push(await poll.poll());
  check('a refused connection reports an error', verdicts.every((v) => v === 'error'), JSON.stringify(verdicts));
  check('a failed poll never re-renders (the live set is untouched)', page.applied.length === 1, String(page.applied.length));

  // A non-200 with a valid-looking body must not be adopted either.
  const { page: p2, poll: poll2 } = harness();
  await poll2.poll();
  const bad = createLivePoll({
    url: () => '/live',
    apply: (d) => p2.applied.push(d),
    isHidden: () => false,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ rev: 9, live: [] }) }),
  });
  const v = await bad.poll();
  check('a non-200 answer is not adopted', v === 'error' && p2.applied.length === 1, `${v}/${p2.applied.length}`);
}

// 3. Bounded, cache-bypassing, non-persistent requests.
{
  const { page, poll } = harness();
  await poll.poll();
  const opts = page.opts[0] || {};
  check('the poll asks the cache to stand aside', opts.cache === 'no-store', JSON.stringify(opts.cache));
  check('the poll carries no keepalive', opts.keepalive !== true, JSON.stringify(opts.keepalive));
  check('the poll is abortable', Boolean(opts.signal), typeof opts.signal);
}

// 4. Hidden slows the poll, never stops it: a scene cut cannot present an empty stage.
{
  const { page, poll } = harness();
  poll.start();
  // `start()` polls immediately but does not await it; let that first read land before counting.
  await new Promise((resolve) => setImmediate(resolve));
  check('a visible document polls at the visible cadence', poll.running === true && poll.interval === POLL_MS, String(poll.interval));
  const before = page.applied.length;
  check('the immediate read painted the record', before === 1, String(before));

  page.hidden = true;
  poll.onVisibility(); // the visibilitychange event, faked
  check(
    'going hidden keeps the timer, at the slower interval',
    poll.running === true && poll.interval === HIDDEN_POLL_MS,
    `running=${poll.running} interval=${poll.interval}`,
  );

  // The notification that arrives while the scene is inactive must already be painted for the cut.
  page.served = { rev: 3, live: [{ id: 'hidden-1' }] };
  const hiddenRead = await poll.poll();
  check(
    'a change that lands while hidden is still applied',
    hiddenRead === 'applied' && page.applied.length === before + 1,
    `${hiddenRead} / ${page.applied.length}`,
  );

  const again = await poll.poll();
  check('an unchanged record renders nothing even while hidden', again === 'unchanged', again);

  page.hidden = false;
  page.served = { rev: 4, live: [{ id: 'back' }] };
  poll.onVisibility();
  await new Promise((resolve) => setImmediate(resolve)); // let the immediate read land
  check('becoming visible reads at once', page.applied.length === before + 2, String(page.applied.length));
  check('the timer returns to the visible interval', poll.interval === POLL_MS, String(poll.interval));
  poll.stop();
  check('stop() ends the timer', poll.running === false, String(poll.running));
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exitCode = 1;
} else {
  console.log('\nlive-poll: all checks passed');
}
