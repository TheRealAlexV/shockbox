// Node test for the scheduled-send queue: booking, cancelling, firing through the delivery
// callback, and the claim rule that stops a job from being sent twice when ticks overlap.
//
//   node --test tools/test-schedule.mjs
//
// The real sender is `POST /api/<module>/…`, which needs a live server; this test stands in with a
// recording `deliver` and asserts the store's own contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScheduler } from '../core/schedule.mjs';

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  return (sub) => {
    const p = path.join(d, sub);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
}

function quietLog() {
  const lines = [];
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]) };
}

test('books a wall send and fires it once', async () => {
  const dir = tmpDir();
  const log = quietLog();
  const sent = [];
  const s = createScheduler({ dir, log, deliver: async (job, body) => { sent.push({ job, body }); return { ok: true }; } });

  const job = s.book({ module: 'wall', at: Date.now() - 10, payload: { text: 'HELLO WALL' } });
  assert.equal(job.status, 'pending');
  assert.equal(job.text, 'HELLO WALL');

  await s.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.cmd, 'text.send');
  assert.equal(sent[0].body.args.text, 'HELLO WALL');
  assert.equal(sent[0].body.origin, 'schedule');

  // a second tick must not resend a sent job
  await s.tick();
  assert.equal(sent.length, 1);
  const { jobs } = s.list({ module: 'wall' });
  assert.equal(jobs[0].status, 'sent');
});

test('a dialogs job carries the poolId through without turning into random', async () => {
  const dir = tmpDir();
  const sent = [];
  const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push(body); return {}; } });
  s.book({ module: 'dialogs', at: Date.now() - 1, payload: { poolId: 'm_abc' } });
  await s.tick();
  // the popup routes read `origin`; a settings patch would not, so it is only on message/command
  // bodies — the shape each module's own route already expects
  assert.deepEqual(sent[0], { poolId: 'm_abc' });
});

test('a notification with no text and no pool asks for a random eligible message', async () => {
  const dir = tmpDir();
  const sent = [];
  const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push(body); return {}; } });
  s.book({ module: 'notifications', at: Date.now() - 1, payload: { random: true } });
  await s.tick();
  assert.equal(sent[0].random, true);
});

test('a failing delivery marks the job failed and does not retry it', async () => {
  const dir = tmpDir();
  let calls = 0;
  const s = createScheduler({ dir, log: quietLog(), deliver: async () => { calls++; throw new Error('no route'); } });
  s.book({ module: 'dialogs', at: Date.now() - 1, payload: { poolId: 'x' } });
  await s.tick();
  await s.tick();
  assert.equal(calls, 1);
  const [job] = s.list().jobs;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /no route/);
});

test('cancel wins over a due job that has not fired yet', async () => {
  const dir = tmpDir();
  const sent = [];
  const s = createScheduler({ dir, log: quietLog(), deliver: async () => { sent.push(1); return {}; } });
  const job = s.book({ module: 'wall', at: Date.now() + 60_000, payload: { text: 'LATER' } });
  s.cancel(job.id);
  await s.tick();
  assert.equal(sent.length, 0);
  assert.throws(() => s.cancel(job.id), /already cancelled/);
});

test('runNow moves a future job into the current tick', async () => {
  const dir = tmpDir();
  const sent = [];
  const s = createScheduler({ dir, log: quietLog(), deliver: async () => { sent.push(1); return {}; } });
  const job = s.book({ module: 'wall', at: Date.now() + 3_600_000, payload: { text: 'NOW' } });
  await s.tick();
  assert.equal(sent.length, 0);
  s.runNow(job.id);
  await s.tick();
  assert.equal(sent.length, 1);
});

test('rejects a booking with nothing to send and one too far in the past', () => {
  const dir = tmpDir();
  const s = createScheduler({ dir, log: quietLog(), deliver: async () => ({}) });
  assert.throws(() => s.book({ module: 'wall', at: Date.now(), payload: {} }), /needs text, a pool message, or random/);
  assert.throws(() => s.book({ module: 'wall', at: Date.now() - 7 * 60 * 60_000, payload: { poolId: 'm_x' } }), /six hours/);
  assert.throws(() => s.book({ module: 'nope', at: Date.now(), payload: { text: 'x' } }), /module must be/);
});

test('the six-hour past limit is judged against the picked moment, not the record once stored', () => {
  const dir = tmpDir();
  const s = createScheduler({ dir, log: quietLog(), deliver: async () => ({}) });
  const past = Date.now() - 7 * 60 * 60_000;
  for (const rep of [undefined, { kind: 'every', n: 20, unit: 'min' }, { kind: 'daily', at: '19:00' }]) {
    assert.throws(() => s.book({ module: 'wall', at: past, repeat: rep, payload: { poolId: 'm_x' } }), /six hours/, `repeat ${JSON.stringify(rep)}`);
  }
});

test('an edit cannot move a send into the past either — it runs through the same rule as book()', () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const s = createScheduler({ dir, log: quietLog(), deliver: async () => ({}), now: () => clock.get() });
    const job = s.book({ module: 'wall', at: BASE + 60 * MIN, payload: { text: 'F' } });
    assert.throws(() => s.edit(job.id, { at: BASE - 7 * HOUR }), /six hours/, `now=${new Date(clock.get()).toISOString()} base=${new Date(BASE).toISOString()}`);
    // two hours back is still a legal booking (the limit is six), so the same rule as book() applies
    assert.equal(s.edit(job.id, { at: BASE - 2 * HOUR }).at, BASE - 2 * HOUR);
    s.edit(job.id, { at: BASE + 60 * MIN });
    // and the refused edit left the booking exactly where it was
    const [row] = s.list().jobs;
    assert.equal(row.at, BASE + 60 * MIN);
    assert.equal(row.text, 'F');
  } finally {
    clock.restore();
  }
});

test('a claim older than the TTL is reclaimed, so a crash mid-send does not wedge the queue', async () => {
  const dir = tmpDir();
  const s = createScheduler({ dir, log: quietLog(), deliver: async () => ({}) });
  const job = s.book({ module: 'wall', at: Date.now() - 5, payload: { text: 'STUCK' } });
  // simulate a crash: claim written, nothing sent, status still pending
  const file = path.join(dir('core'), 'schedules.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.jobs[0].claimedAt = Date.now() - 120_000;
  fs.writeFileSync(file, JSON.stringify(doc));
  const sent = [];
  const s2 = createScheduler({ dir, log: quietLog(), deliver: async (j) => { sent.push(j.id); return {}; } });
  await s2.tick();
  assert.deepEqual(sent, [job.id]);
});

/* ------------------------------------------------------------------ recurrence */

// The queue reads the wall clock through `Date.now()`, so a test drives it the same way: pin the
// clock, move it, restore it. No test here waits on real time.
function clockAt(ms) {
  const real = Date.now;
  let t = ms;
  Date.now = () => t;
  return {
    set: (v) => { t = v; },
    advance: (d) => { t += d; },
    get: () => t,
    restore: () => { Date.now = real; },
  };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
// A fixed local wall-clock moment to hang daily tests on: 2026-03-10T12:00 local.
const BASE = new Date(2026, 2, 10, 12, 0, 0, 0).getTime();

test("an 'every' job fires at each interval and advances next instead of finishing", async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const sent = [];
    const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push({ at: Date.now(), body }); return { ok: true }; } });
    const job = s.book({
      module: 'wall', at: BASE + 10 * MIN, repeat: { kind: 'every', n: 20, unit: 'min' },
      payload: { text: 'EVERY 20' },
    });
    assert.equal(job.status, 'pending');
    assert.deepEqual(job.repeat, { kind: 'every', n: 20, unit: 'min' });
    assert.equal(job.next, BASE + 10 * MIN);

    // before its time: nothing goes out
    clock.set(BASE + 9 * MIN);
    await s.tick();
    assert.equal(sent.length, 0);

    // first fire
    clock.set(BASE + 10 * MIN);
    await s.tick();
    assert.equal(sent.length, 1, 'first interval fires');
    let [row] = s.list().jobs;
    assert.equal(row.status, 'pending', 'a repeating job is still pending after a fire');
    assert.equal(row.runs, 1);
    assert.equal(row.next, BASE + 30 * MIN, 'next is one interval after the scheduled moment');
    assert.equal(row.missedAt, undefined, 'a fire on time is not late');

    // a tick that lands exactly on the next window fires again, and the row stays in the queue
    clock.set(BASE + 30 * MIN);
    await s.tick();
    assert.equal(sent.length, 2, 'second interval fires');
    [row] = s.list().jobs;
    assert.equal(row.runs, 2);
    assert.equal(row.next, BASE + 50 * MIN);
    assert.equal(row.status, 'pending');

    // nothing fires between windows
    clock.set(BASE + 49 * MIN);
    await s.tick();
    assert.equal(sent.length, 2);
  } finally {
    clock.restore();
  }
});

test("a 'daily' job fires at its local HH:MM and rolls to tomorrow", async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE); // 2026-03-10 12:00 local
  try {
    const sent = [];
    const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push(Date.now()); return { ok: true }; } });
    // booked at "today 10:00" — the clock in the repeat is the point, so it means the NEXT 19:00
    const job = s.book({
      module: 'notifications', at: new Date(2026, 2, 10, 10, 0).getTime(),
      repeat: { kind: 'daily', at: '19:00' }, payload: { random: true },
    });
    assert.deepEqual(job.repeat, { kind: 'daily', at: '19:00' });
    const first = new Date(2026, 2, 10, 19, 0).getTime();
    assert.equal(job.next, first, 'a daily booking made after its time means the next occurrence');

    clock.set(first - MIN);
    await s.tick();
    assert.equal(sent.length, 0);
    clock.set(first + 3_000);
    await s.tick();
    assert.equal(sent.length, 1, 'fires at 19:00 local');
    let [row] = s.list().jobs;
    assert.equal(row.next, new Date(2026, 2, 11, 19, 0).getTime(), 'next is tomorrow at the same clock time');

    clock.set(new Date(2026, 2, 11, 19, 0).getTime());
    await s.tick();
    assert.equal(sent.length, 2, 'fires again the next day');
    [row] = s.list().jobs;
    assert.equal(row.runs, 2);
  } finally {
    clock.restore();
  }
});

test('a repeating job survives a restart: a new scheduler on the same store still fires it', async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const first = [];
    const s1 = createScheduler({ dir, log: quietLog(), deliver: async () => { first.push(1); return {}; } });
    const job = s1.book({ module: 'dialogs', at: BASE + 5 * MIN, repeat: { kind: 'every', n: 30, unit: 'min' }, payload: { poolId: 'm_alert' } });
    clock.set(BASE + 5 * MIN);
    await s1.tick();
    assert.equal(first.length, 1);
    s1.stop();

    // the process dies here; a new scheduler is built on the same state file
    clock.set(BASE + 35 * MIN);
    const second = [];
    const s2 = createScheduler({ dir, log: quietLog(), deliver: async () => { second.push(1); return {}; } });
    await s2.tick();
    assert.equal(second.length, 1, 'the rebuilt queue fires the job at its next window');
    const [row] = s2.list().jobs;
    assert.equal(row.id, job.id);
    assert.equal(row.status, 'pending', 'and it is still repeating, not finished');
    assert.equal(row.runs, 2);
    assert.equal(row.next, BASE + 65 * MIN);
  } finally {
    clock.restore();
  }
});

test('a window missed while the process was down fires once, then reschedules forward', async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const sent = [];
    const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push(Date.now()); return {}; } });
    // every 20 minutes from 13:00; the process is down from 13:15 to 16:00 (nine windows go by)
    const start = BASE + HOUR;
    s.book({ module: 'wall', at: start, repeat: { kind: 'every', n: 20, unit: 'min' }, payload: { text: 'PING' } });
    clock.set(start - MIN);
    await s.tick();
    assert.equal(sent.length, 0, 'nothing is due before the first window');

    // The process was down: no tick for three hours. It comes back 18 minutes past the window it
    // slept through (16:18), so the late fire is measurably late.
    clock.set(start + 3 * HOUR + 18 * MIN);
    await s.tick();
    assert.equal(sent.length, 1, 'three hours of missed windows coalesce into one send, not nine');
    const [row] = s.list().jobs;
    assert.equal(row.runs, 1);
    // 16:00 minus 14:40: the send represents the newest window it slept through, and the row says
    // how far behind that window it started.
    assert.equal(row.missedAt, 18 * MIN, `the row records how late the run was; got ${row.missedAt}`);
    assert.equal(row.lateBy, 18 * MIN, 'and the readable field carries the same number');
    assert.ok(row.next > Date.now(), 'the next window is in the future');
    // The series resumes on its own grid — the next 20-minute window after 16:18 is 16:20 — not
    // 20 minutes after the late send (16:38), and not the first window it missed (13:20).
    assert.equal(row.next, start + 3 * HOUR + 20 * MIN, 'and it lands on the series, not 20 minutes after the late send');

    // the tick that follows does not replay the rest of the missed series
    clock.advance(1_000);
    await s.tick();
    assert.equal(sent.length, 1, 'no burst after the coalesced fire');

    // the pane can see the job ran late
    assert.equal(s.list().jobs[0].missed, false, 'and the row is not stuck in "missed"');
  } finally {
    clock.restore();
  }
});

test('a repeating job whose next window has passed shows as missed in the queue', async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const s = createScheduler({ dir, log: quietLog(), deliver: async () => ({}) });
    const job = s.book({ module: 'wall', at: BASE + 10 * MIN, repeat: { kind: 'every', n: 15, unit: 'min' }, payload: { text: 'LATE' } });
    assert.equal(s.list().jobs[0].missed, false);
    // the clock moves past the window without a tick (the process was down): the queue still says so
    clock.set(BASE + 2 * HOUR);
    const row = s.list().jobs.find((j) => j.id === job.id);
    assert.equal(row.missed, true, 'a pending repeat whose moment went by is visible as missed');
    // and firing clears it, recording when it actually went out
    await s.tick();
    const after = s.list().jobs.find((j) => j.id === job.id);
    assert.equal(after.missed, false);
    assert.equal(after.runs, 1);
    assert.ok(after.missedAt > 0, 'the row records that the run was late');
  } finally {
    clock.restore();
  }
});

test('PATCH-shaped edit moves a job and changes its repeat', async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const sent = [];
    const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push(body); return {}; } });
    const job = s.book({ module: 'wall', at: BASE + 60 * MIN, payload: { text: 'FIRST' } });
    assert.equal(job.repeat.kind, 'once');

    // still one-shot at the old moment: an edit that only renames keeps the booking
    const renamed = s.edit(job.id, { payload: { text: 'SECOND' } });
    assert.equal(renamed.next, undefined, 'a once job has no next');
    assert.equal(renamed.at, BASE + 60 * MIN);
    assert.equal(renamed.text, 'SECOND');

    // make it repeat, on a new moment
    const repeating = s.edit(job.id, { at: BASE + 20 * MIN, repeat: { kind: 'every', n: 10, unit: 'min' } });
    assert.deepEqual(repeating.repeat, { kind: 'every', n: 10, unit: 'min' });
    assert.equal(repeating.next, BASE + 20 * MIN, 'the edit moves the first fire');

    clock.set(BASE + 19 * MIN);
    await s.tick();
    assert.equal(sent.length, 0);
    clock.set(BASE + 20 * MIN);
    await s.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.text, 'SECOND', 'the edited payload is what goes out');
    assert.equal(s.list().jobs[0].next, BASE + 30 * MIN);

    // back to a one-shot: the repeat is dropped and `next` goes with it
    const once = s.edit(job.id, { repeat: 'once', at: BASE + 90 * MIN });
    assert.equal(once.repeat.kind, 'once');
    assert.equal(once.next, undefined);
    assert.equal(once.at, BASE + 90 * MIN);

    // an edit is held to the same rules as a booking
    assert.throws(() => s.edit(job.id, { payload: { text: null } }), /needs text, a pool message, or random/);
    assert.throws(() => s.edit(job.id, { repeat: { kind: 'every', n: 0, unit: 'min' } }), /repeat.n/);
    assert.throws(() => s.edit(job.id, { repeat: { kind: 'daily', at: '25:00' } }), /HH:MM/);
    assert.throws(() => s.edit('s_nope', { at: BASE }), /unknown schedule/);
  } finally {
    clock.restore();
  }
});

test('a command payload is scheduled without the scheduler knowing the command', async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    const sent = [];
    const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push({ job, body }); return { ok: true }; } });
    // wall blackout: a bare command, no text at all
    s.book({ module: 'wall', at: BASE + MIN, payload: { cmd: 'blackout.on' } });
    // a wall palette step, scheduled by command
    s.book({ module: 'wall', at: BASE + MIN, payload: { cmd: 'look.palette.next' } });
    // hand FX is a module too, and it reads the same {cmd, args} envelope
    s.book({ module: 'handfx', at: BASE + MIN, payload: { cmd: 'effect.next' } });
    // a notifications style change routes through the module's settings patch
    s.book({ module: 'notifications', at: BASE + MIN, payload: { action: 'settings', path: '/api/notifications/settings', payload: { style: 'macos' } } });
    clock.set(BASE + MIN);
    await s.tick();
    assert.equal(sent.length, 4);
    const bodies = sent.map((x) => x.body);
    assert.deepEqual(bodies[0], { cmd: 'blackout.on', args: {}, origin: 'schedule' });
    assert.deepEqual(bodies[1], { cmd: 'look.palette.next', args: {}, origin: 'schedule' });
    assert.deepEqual(bodies[2], { cmd: 'effect.next', args: {}, origin: 'schedule' });
    assert.deepEqual(bodies[3], { action: 'settings', payload: { style: 'macos' } });
    // the action a row shows is the command, not the module name
    const actions = s.list().jobs.map((j) => j.action).sort();
    assert.deepEqual(actions, ['blackout.on', 'effect.next', 'look.palette.next', 'settings']);
  } finally {
    clock.restore();
  }
});

test('records written before recurrence existed are read as one-shots and still fire', async () => {
  const dir = tmpDir();
  const clock = clockAt(BASE);
  try {
    // exactly what the one-shot queue wrote: no repeat, no next, no action
    const file = path.join(dir('core'), 'schedules.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      jobs: [{
        id: 's_legacy1', module: 'wall', kind: null, title: null, text: 'OLD ONE-SHOT', poolId: null,
        at: BASE + MIN, created: BASE, status: 'pending', payload: { text: 'OLD ONE-SHOT' },
      }],
    }));
    const sent = [];
    const s = createScheduler({ dir, log: quietLog(), deliver: async (job, body) => { sent.push(body); return {}; } });
    const [row] = s.list().jobs;
    assert.equal(row.repeat.kind, 'once');
    assert.equal(row.next, undefined, 'a legacy record gains no `next`');
    clock.set(BASE + MIN);
    await s.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.text, 'OLD ONE-SHOT');
    // a legacy record still ends in `sent`, not in a repeat
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0];
    assert.equal(after.status, 'sent');
    assert.equal(after.repeat, undefined, 'nothing is back-written onto an old record');
  } finally {
    clock.restore();
  }
});
