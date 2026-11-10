// Server-side source watchdog — policy and hotkey wiring, no OBS, no timers.
//
//   node test/handfx-source-watchdog.mjs
//
// What it proves:
//   · dead document + source showing → one fire, with the browser source's Refresh hotkey
//   · dead document + source hidden  → never a fire, and the reason says hidden
//   · live document                  → never a fire
//   · backoff                        → one fire per 60 s window
//   · give-up                        → three fires, then it stops and records why
// Exits non-zero on the first failed check.

import { decide, createSourceWatchdog, WATCHDOG_DEFAULTS } from '../modules/handfx/source-watchdog.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const now = 1_000_000;
const DEAD = { lastAckAt: now - 60_000 };
const ALIVE = { lastAckAt: now - 500 };
const SHOWING = { obsReady: true, active: true, showing: true };
const HIDDEN = { obsReady: true, active: false, showing: false };

// 1. dead + showing → fires exactly once, with the right hotkey name and context name.
{
  const calls = [];
  const messages = [];
  const obs = {
    ready: () => true,
    request: async (type, data) => {
      calls.push({ type, data });
      if (type === 'GetSourceActive') return { videoActive: true, videoShowing: true };
      return {};
    },
  };
  const log = {
    info: (m) => messages.push(m),
    warn: (m) => messages.push(m),
  };
  const wd = createSourceWatchdog({
    obs,
    getSnapshot: () => ({ lastAckAt: Date.now() - 60_000 }),
    log,
  });
  const out = await wd.tick();
  const fires = calls.filter((c) => c.type === 'TriggerHotkeyByName');
  check('dead + showing fires', out.fire === true && out.decision === 'fire');
  check('fires exactly once', fires.length === 1, `got ${fires.length}`);
  check(
    'fires the browser source Refresh hotkey',
    fires[0] && fires[0].data.hotkeyName === 'ObsBrowser.Refresh',
    JSON.stringify(fires[0] && fires[0].data),
  );
  check(
    'names the ShockFX source as the hotkey context',
    fires[0] && fires[0].data.contextName === 'ShockFX',
    JSON.stringify(fires[0] && fires[0].data),
  );
  check('logs the fire', messages.some((m) => /firing ObsBrowser\.Refresh/.test(m)), messages.join(' | '));
  const second = await wd.tick();
  check('a second immediate tick does not fire again', second.fire === false && second.decision === 'backoff', second.decision);
}

// 2. dead + hidden → never fires, and logs the reason.
{
  const out = decide({ now, ...DEAD, ...HIDDEN });
  check('dead + hidden never fires', out.fire === false);
  check('dead + hidden is reported as hidden', out.decision === 'hidden', out.decision);
  check('hidden reason names the source state', /not showing \(active=false, showing=false\)/.test(out.reason), out.reason);

  // A tick that is dead while OBS is disconnected must not fire either.
  const down = decide({ now, ...DEAD, obsReady: false, active: false, showing: false });
  check('obs down never fires', down.fire === false && down.decision === 'obs-down', down.decision);
}

// 3. alive → never fires and resets every counter.
{
  const out = decide({ now, ...ALIVE, ...SHOWING, lastFireAt: now - 1000, consecutiveFires: 2, gaveUp: true });
  check('alive never fires', out.fire === false && out.decision === 'alive', out.decision);
  check(
    'alive resets the fire counters',
    out.state.lastFireAt === 0 && out.state.consecutiveFires === 0 && out.state.gaveUp === false,
    JSON.stringify(out.state),
  );
}

// 3b. A never-acked document is booting, not dead, for the first deadAfterMs after start.
{
  const young = decide({ now, startedAt: now - 5_000, lastAckAt: 0, ...SHOWING });
  check('never-acked + young watchdog is booting', young.fire === false && young.decision === 'booting', young.decision);
  check('booting reason names the grace', /boot grace/.test(young.reason), young.reason);

  const old = decide({ now, startedAt: now - 46_000, lastAckAt: 0, ...SHOWING });
  check('never-acked past the grace fires', old.fire === true && old.decision === 'fire', old.decision);

  const hiddenBoot = decide({ now, startedAt: now - 5_000, lastAckAt: 0, ...HIDDEN });
  check('booting wins over a hidden source during the grace', hiddenBoot.fire === false && hiddenBoot.decision === 'booting', hiddenBoot.decision);
}

// 4. backoff: two ticks inside 60 s produce one fire; a tick past 60 s produces a second.
{
  const first = decide({ now, ...DEAD, ...SHOWING });
  const inside = decide({
    now: now + 30_000,
    lastAckAt: now - 60_000,
    ...SHOWING,
    lastFireAt: first.state.lastFireAt,
    consecutiveFires: first.state.consecutiveFires,
    gaveUp: first.state.gaveUp,
  });
  const after = decide({
    now: now + 61_000,
    lastAckAt: now - 60_000,
    ...SHOWING,
    lastFireAt: inside.state.lastFireAt,
    consecutiveFires: inside.state.consecutiveFires,
    gaveUp: inside.state.gaveUp,
  });
  const fires = [first, inside, after].filter((o) => o.fire).length;
  check('one fire inside the 60 s window', first.fire === true && inside.fire === false, JSON.stringify([first.decision, inside.decision]));
  check('backoff is reported', inside.decision === 'backoff', inside.decision);
  check('past 60 s fires again', after.fire === true && after.decision === 'fire', after.decision);
  check('exactly two fires across the three ticks', fires === 2, `got ${fires}`);
}

// 5. give-up: four dead+showing ticks spanning enough time → exactly three fires, then stop.
{
  let state = { lastFireAt: 0, consecutiveFires: 0, gaveUp: false };
  const ticks = [0, 61_000, 122_000, 183_000];
  const outs = ticks.map((offset) => {
    const out = decide({
      now: now + offset,
      lastAckAt: now - 60_000,
      ...SHOWING,
      ...state,
    });
    state = out.state;
    return out;
  });
  const fires = outs.filter((o) => o.fire).length;
  check('give-up: exactly three fires', fires === 3, `got ${fires}`);
  check('give-up: the last fire is flagged as the last attempt', /last attempt/.test(outs[2].reason), outs[2].reason);
  check('give-up: recorded after the budget is spent', state.consecutiveFires === 3 && state.gaveUp === true, JSON.stringify(state));
  check('give-up: the fourth tick does not fire', outs[3].fire === false, String(outs[3].fire));
  check('give-up: the fourth tick reports the give-up', outs[3].decision === 'gave-up', outs[3].decision);
  check('give-up: reason is operator-readable', /gave up after 3 fires/.test(outs[3].reason), outs[3].reason);

  // Only a live document clears it.
  const revived = decide({ now: now + 190_000, lastAckAt: now + 190_000 - 500, ...SHOWING, ...state });
  check('give-up: cleared only by a live page', revived.decision === 'alive' && revived.state.gaveUp === false);
}

check('default source name is ShockFX', WATCHDOG_DEFAULTS.sourceName === 'ShockFX', WATCHDOG_DEFAULTS.sourceName);
check('default hotkey is the browser Refresh hotkey', WATCHDOG_DEFAULTS.hotkeyName === 'ObsBrowser.Refresh', WATCHDOG_DEFAULTS.hotkeyName);
check('dead threshold is 45 s', WATCHDOG_DEFAULTS.deadAfterMs === 45_000, String(WATCHDOG_DEFAULTS.deadAfterMs));
check('minimum gap is 60 s', WATCHDOG_DEFAULTS.minFireGapMs === 60_000, String(WATCHDOG_DEFAULTS.minFireGapMs));

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
