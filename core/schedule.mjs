// Scheduled sends: "send this at 21:30, to this view" — and every 20 minutes after that.
//
// One shared queue for every module, because a schedule is a fact about time, not about a module:
// the wall, the dialogs, the notifications and the hand FX all take a command and a moment, and the
// person booking them wants one list ("what is booked") rather than four. Each job stores the body
// of the request that would have carried it, so firing posts that body through the core HTTP
// dispatcher — the same handler a click reaches. This file therefore holds no list of commands:
// anything a module route accepts can be scheduled by naming the route.
//
// Persistence is `state/core/schedules.json`, written synchronously on every mutation. A job is
// claimed (`claimedAt`) before it fires so two overlapping ticks cannot send it twice, and a claim
// older than CLAIM_TTL is reclaimed rather than lost, because a throw in the handler must not leave
// a job wedged forever.
//
// Recurrence:
//   repeat: undefined | {kind:'once'}                        — a one-shot, the original shape
//   repeat: {kind:'every', n, unit:'sec'|'min'|'hour'|'day'}  — first at `at`, then every n units
//   repeat: {kind:'daily', at:'HH:MM'}                        — local wall-clock time, every day
//
// A repeating job is never deleted when it fires: `next` advances and `at` holds the window that
// just went out, so the row stays in the queue. The next moment is computed from the *scheduled*
// time rather than from the tick's clock, so a tick that ran late does not drag the series late.
// A window missed while the process was down fires once — the newest window it slept through — and
// the series resumes strictly after now, so hours of downtime arrive as one send, not a burst. The
// row records how late that send was (`missedAt`, in ms) so the pane can say so instead of
// pretending it went out on time.

import { randomBytes } from 'node:crypto';
import { JsonStore } from './store.mjs';
import { HttpError } from './id.mjs';

const CLAIM_TTL = 60_000;
const MAX_JOBS = 500;
const TICK_MS = 1_000;
const MAX_LATE = 6 * 60 * 60_000;
const SENT_KEEP_MS = 7 * 24 * 60 * 60_000;
/** A fire this far behind its window counts as late, not as marginally jittery. */
const PAST_SLACK_MS = 60_000;

const MODULES = ['wall', 'dialogs', 'notifications', 'handfx'];
const UNITS = { sec: 1_000, min: 60_000, hour: 3_600_000, day: 86_400_000 };

/**
 * Which route carries a payload. A payload that names its own `path` wins — that is how a new
 * command, or a module this file has never heard of, becomes schedulable without a code change.
 */
const DEFAULT_PATHS = {
  wall: '/api/wall/cmd',
  dialogs: '/api/dialogs/live',
  notifications: '/api/notifications/live',
  handfx: '/api/handfx/cmd',
  core: '/api/core/settings',
};

/** Routes whose body is a `{cmd, args}` envelope rather than the payload verbatim. */
const CMD_PATHS = new Set(['/api/wall/cmd', '/api/handfx/cmd']);

/* ------------------------------------------------------------------ shapes */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'HH:MM' (24h, local) → {h, m, text}, or null when it is not a wall-clock time. */
export function parseClock(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return { h, m: min, text: `${pad2(h)}:${pad2(min)}` };
}

const UNIT_ALIASES = {
  s: 'sec', sec: 'sec', secs: 'sec', second: 'sec', seconds: 'sec',
  m: 'min', min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  h: 'hour', hr: 'hour', hour: 'hour', hours: 'hour',
  d: 'day', day: 'day', days: 'day',
};

/**
 * Normalise a `repeat` from the wire into the stored shape. Absent or empty is `{kind:'once'}`;
 * anything malformed throws a 400 that names the field. `'daily'` and `'every 20 min'` are
 * accepted as strings because that is what a `<select>` carries.
 */
export function normRepeat(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'once') return { kind: 'once' };
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    if (t === 'daily') return { kind: 'daily' };
    if (t === 'once') return { kind: 'once' };
    const ev = /^every\s+(\d+)\s*([a-z]+)$/.exec(t);
    if (ev) return normRepeat({ kind: 'every', n: Number(ev[1]), unit: ev[2] });
    throw new HttpError(400, 'repeat must be once, daily, or {n, unit}');
  }
  if (!isObj(raw)) throw new HttpError(400, 'repeat must be an object');
  const kind = raw.kind || (raw.n !== undefined ? 'every' : raw.at !== undefined ? 'daily' : 'once');
  if (kind === 'once') return { kind: 'once' };
  if (kind === 'daily') {
    const clock = parseClock(raw.at);
    if (!clock) throw new HttpError(400, 'repeat.at must be a 24h HH:MM time');
    return { kind: 'daily', at: clock.text };
  }
  if (kind === 'every') {
    const n = Number(raw.n);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'repeat.n must be a whole number >= 1');
    const unit = UNIT_ALIASES[String(raw.unit || '').toLowerCase()];
    if (!unit) throw new HttpError(400, 'repeat.unit must be sec, min, hour or day');
    return { kind: 'every', n, unit };
  }
  throw new HttpError(400, `unknown repeat.kind "${String(kind)}" (once, every, daily)`);
}

export function isRepeating(repeat) {
  return Boolean(repeat) && repeat.kind !== 'once';
}

/** The next fire strictly after `after`, for a repeating job. */
export function nextFire(rep, after) {
  if (!isRepeating(rep)) return null;
  if (rep.kind === 'every') return after + rep.n * (UNITS[rep.unit] || UNITS.min);
  const clock = parseClock(rep.at);
  if (!clock) return after + UNITS.day;
  const d = new Date(after);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), clock.h, clock.m, 0, 0);
  if (target.getTime() <= after) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/**
 * The first fire for a booking. A daily job ignores the picked date (its clock is the point) and
 * rolls to the next occurrence of that time, unless the picked moment is that same occurrence.
 */
function firstFire(rep, when, now) {
  if (!rep || rep.kind !== 'daily') return when;
  const clock = parseClock(rep.at);
  if (!clock) return when;
  const d = new Date(when);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), clock.h, clock.m, 0, 0);
  // "19:00" booked at 20:00 today means tomorrow's 19:00, not six hours late.
  if (target.getTime() < now - PAST_SLACK_MS) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** A short label a row can carry to name what it does: 'text.send', 'blackout.on', 'settings'. */
function actionOf(module, payload) {
  if (typeof payload.cmd === 'string' && payload.cmd) return payload.cmd;
  if (typeof payload.action === 'string' && payload.action) return payload.action;
  if (payload.path) return payload.path;
  if (payload.any === true || payload.random === true) return `${module}.random`;
  return `${module}.send`;
}

/* ------------------------------------------------------------------ queue */

export function createScheduler({ dir, log, deliver, now = () => Date.now() }) {


  const store = new JsonStore({ dir: dir('core'), file: 'schedules.json', def: { version: 1, jobs: [] } });
  let timer = null;

  function doc() {
    const d = store.load();
    if (!d || typeof d !== 'object') return { version: 1, jobs: [] };
    if (!Array.isArray(d.jobs)) d.jobs = [];
    return d;
  }

  function save(d) {
    store.data = d;
    store.save();
  }

  /** The moment a record is next due: `next` once it repeats, `at` until it fires. */
  function dueAt(j) {
    return j.next === undefined || j.next === null ? j.at : j.next;
  }

  /**
   * Read a record the way everything else reads it. Old records have no `repeat`, no `next` and no
   * `action` — exactly what the one-shot queue wrote — so nothing is rewritten on load: a missing
   * `repeat` *is* 'once', and a missing `next` is `at`.
   */
  function view(j, at) {
    const rep = j.repeat && j.repeat.kind ? j.repeat : { kind: 'once' };
    const due = dueAt(j);
    const out = { ...j, repeat: rep, due };
    if (isRepeating(rep)) out.next = due;
    out.every = rep.kind === 'every' ? `${rep.n}${rep.unit}` : rep.kind === 'daily' ? `daily ${rep.at}` : null;
    // `missed` is a state of the queue, not of history: a repeating job whose window went by
    // without a tick (the process was down) is visible as such until it fires.
    out.missed = isRepeating(rep) && j.status === 'pending' && due < at - PAST_SLACK_MS;
    if (j.missedAt) out.lateBy = j.missedAt;
    return out;
  }

  function prune(jobs, at) {
    // Finished jobs are kept for a while so the pane can show what ran; the cap bounds the file. A
    // repeating job is never finished, so age never removes it.
    const keep = [];
    for (const j of jobs) {
      const done = j.status === 'sent' || j.status === 'failed' || j.status === 'cancelled';
      if (done && at - (j.finishedAt || j.at || 0) > SENT_KEEP_MS) continue;
      keep.push(j);
    }
    return keep.sort((a, b) => dueAt(a) - dueAt(b)).slice(-MAX_JOBS);
  }

  function list(filter = {}) {
    const at = now();
    const d = doc();
    let jobs = d.jobs.slice().sort((a, b) => dueAt(a) - dueAt(b)).map((j) => view(j, at));
    if (filter.module) jobs = jobs.filter((j) => j.module === filter.module);
    if (filter.pending === true) jobs = jobs.filter((j) => j.status === 'pending');
    // The pane groups by module; these counts are what a header needs at a glance.
    const byModule = {};
    for (const j of jobs) {
      const b = byModule[j.module] || (byModule[j.module] = { total: 0, pending: 0, missed: 0 });
      b.total += 1;
      if (j.status === 'pending') b.pending += 1;
      if (j.missed) b.missed += 1;
    }
    return { now: at, jobs, byModule, modules: MODULES };
  }

  /**
   * Validate what goes out — not when. The loose request verbs (`path`, `cmd`, `args`, `action`)
   * are folded into the payload, because downstream only ever reads the payload.
   */
  function payloadOf({ payload, path, cmd, args, action }) {
    const body = isObj(payload) ? { ...payload } : {};
    if (path !== undefined && path !== null) body.path = path;
    if (cmd !== undefined && cmd !== null) body.cmd = cmd;
    if (args !== undefined && args !== null) body.args = args;
    if (action !== undefined && action !== null) body.action = action;
    if (body.path !== undefined && (typeof body.path !== 'string' || !body.path.startsWith('/api/'))) {
      throw new HttpError(400, 'payload.path must be an /api/ route');
    }
    if (body.cmd !== undefined && (typeof body.cmd !== 'string' || !body.cmd)) {
      throw new HttpError(400, 'payload.cmd must be a non-empty string');
    }
    if (body.args !== undefined && !isObj(body.args)) throw new HttpError(400, 'payload.args must be an object');
    return body;
  }

  /**
   * Everything a record needs before it can be trusted: a module, something to send, a repeat and a
   * moment. `book()` and `edit()` both call this and nothing else, so an edit cannot be held to a
   * different rule than a booking.
   */
  function apply(input, at) {
    const { module, kind, text, poolId, title, at: when0, repeat } = input;
    if (!MODULES.includes(module)) throw new HttpError(400, `module must be one of ${MODULES.join(', ')}`);
    const rep = normRepeat(repeat);
    // `at` is serialised as `when` by `merge()`, and Number(undefined) is NaN — NOT "no timestamp".
    // Everything else here reads `when0` directly; this line must too, or a merge that carries the
    // moment under `at` (which is how a record stores it) is refused as "at must be a timestamp".
    const when = Number(when0 !== undefined ? when0 : input.at);
    if (!Number.isFinite(when)) throw new HttpError(400, 'at must be a millisecond timestamp');
    const late = at - when;
    if (late > MAX_LATE) throw new HttpError(400, 'that time is more than six hours in the past');
    const body = payloadOf(input);
    // A message send needs something to send: literal text, a pool message, or a variant flag the
    // module resolves itself (`random`, `any`). A command payload carries its own verb, so it is its
    // own answer to "what goes out" — which is the whole point of routing by path.
    const carriesMessage = Boolean(poolId) || Boolean(body.text) || Boolean(body.poolId) || Boolean(body.spec) ||
      body.random === true || body.any === true;
    const carriesAction = body.cmd !== undefined || body.action !== undefined || body.path !== undefined;
    if (!carriesMessage && !carriesAction) {
      throw new HttpError(400, 'a scheduled send needs text, a pool message, or random (or a command: cmd/action/path)');
    }
    return {
      module,
      kind: kind || body.kind || null,
      title: title || body.title || null,
      text: typeof body.text === 'string' ? body.text : (text || null),
      poolId: poolId || body.poolId || null,
      at: firstFire(rep, when, at),
      action: actionOf(module, body),
      payload: body,
      repeat: isRepeating(rep) ? rep : null,
    };
  }

  /** Write validated fields onto a record. `once` carries no `repeat`/`next` at all. */
  function commit(rec, applied) {
    rec.module = applied.module;
    rec.kind = applied.kind;
    rec.title = applied.title;
    rec.text = applied.text;
    rec.poolId = applied.poolId;
    rec.at = applied.at;
    rec.action = applied.action;
    rec.payload = applied.payload;
    if (applied.repeat) {
      rec.repeat = applied.repeat;
      rec.next = applied.at;
    } else {
      delete rec.repeat;
      delete rec.next;
    }
    return rec;
  }

  function describeRepeat(rep) {
    if (!rep) return '';
    return rep.kind === 'every' ? ` (every ${rep.n}${rep.unit})` : ` (daily ${rep.at})`;
  }

  function newId(at) {
    return `s_${at.toString(36)}${randomBytes(3).toString('hex')}`;
  }

  /**
   * Book one send. `payload` is what the module's own route takes; `path` (or `payload.path`) names
   * the route, which is what makes a storm, a blackout, a palette step or a settings patch
   * schedulable without this file knowing the command exists.
   */
  function book(input) {
    const at = now();
    const d = doc();
    const job = commit({ id: newId(at), created: at, status: 'pending' }, apply(input || {}, at));
    d.jobs.push(job);
    d.jobs = prune(d.jobs, at);
    save(d);
    log.info(`scheduled ${job.id} ${job.module} ${job.action} at ${new Date(job.at).toISOString()}${describeRepeat(job.repeat)}`);
    return view(job, at);
  }

  function find(d, jobId) {
    const j = d.jobs.find((x) => x.id === jobId);
    if (!j) throw new HttpError(404, `unknown schedule ${jobId}`);
    return j;
  }

  /**
   * Change a booked job: its moment, its repeat, or what it sends. Fields the caller did not touch
   * keep their value, and the merged record goes through `apply()` — the function `book()` uses.
   */
  function edit(jobId, input) {
    // the clock, through the scheduler's own reader — the same `now()` every other rule uses, so a
    // pinned clock in a test (or a real one) cannot diverge between book() and edit()
    const at = now();
    const patch = isObj(input) ? input : {};
    const d = doc();
    const j = find(d, jobId);
    if (j.status !== 'pending') throw new HttpError(409, `schedule is already ${j.status}`);
    const merged = {
      module: patch.module !== undefined ? patch.module : j.module,
      kind: patch.kind !== undefined ? patch.kind : j.kind,
      title: patch.title !== undefined ? patch.title : j.title,
      text: patch.text !== undefined ? patch.text : j.text,
      poolId: patch.poolId !== undefined ? patch.poolId : j.poolId,
      at: patch.at !== undefined ? patch.at : dueAt(j),
      repeat: patch.repeat !== undefined ? patch.repeat : j.repeat,
      payload: isObj(patch.payload) ? patch.payload : (j.payload || {}),
      ...(patch.path !== undefined ? { path: patch.path } : {}),
      ...(patch.cmd !== undefined ? { cmd: patch.cmd } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.action !== undefined ? { action: patch.action } : {}),
    };
    const applied = apply(merged, at);
    // An edit starts a fresh booking: the claim, the last result and a missed window all belong to
    // the old moment, not to the new one.
    delete j.claimedAt;
    delete j.missedAt;
    delete j.error;
    delete j.result;
    commit(j, applied);
    save(d);
    log.info(`edited ${j.id} ${j.module} → ${new Date(j.at).toISOString()}${describeRepeat(j.repeat)}`);
    return view(j, at);
  }

  function cancel(jobId) {
    const at = now();
    const d = doc();
    const j = find(d, jobId);
    if (j.status !== 'pending') throw new HttpError(409, `schedule is already ${j.status}`);
    j.status = 'cancelled';
    j.finishedAt = at;
    save(d);
    return view(j, at);
  }

  /** Send a booked job now, whatever its time — the pane's "run" button. */
  function runNow(jobId) {
    const at = now();
    const d = doc();
    const j = find(d, jobId);
    if (j.status !== 'pending') throw new HttpError(409, `schedule is already ${j.status}`);
    // A repeat keeps its series: running it early does not delete the next window.
    if (isRepeating(j.repeat)) j.next = at;
    else j.at = at;
    save(d);
    return view(j, at);
  }

  /** The route this record posts to. */
  function routeOf(j) {
    const p = j.payload || {};
    return p.path || DEFAULT_PATHS[j.module] || DEFAULT_PATHS.core;
  }

  /**
   * The body that route takes. A module that reads a command envelope gets one; every other route
   * gets the payload as booked, plus `origin` so a popup can say where it came from.
   */
  function deliveryBody(j) {
    const body = { ...(j.payload || {}) };
    delete body.path;
    delete body.module;
    delete body.method;
    // A module that reads `{cmd, args}` gets the envelope, and a message booked without one (the
    // quick-send box) is the command it means: `text.send`. The command and its arguments are
    // passed through as booked rather than rebuilt.
    if (body.cmd) {
      const args = { ...(body.args || {}) };
      return { cmd: body.cmd, args, origin: 'schedule' };
    }
    if (CMD_PATHS.has(routeOf(j))) {
      const args = j.text ? { text: j.text } : { poolId: j.poolId };
      return { cmd: 'text.send', args, origin: 'schedule' };
    }
    // `origin` is what the popup modules read to say who sent this; a settings patch must not see
    // it, so it goes on the originator the server sets, not into a payload handed to a schema.
    const out = { ...body };
    const carries = out.text || out.poolId || out.spec || out.any === true || out.random === true;
    if (!carries && (j.poolId || j.text)) {
      if (j.poolId) out.poolId = j.poolId;
      else out.text = j.text;
    }
    return out;
  }

  /**
   * Walk a repeating job past every window that has gone by and return the one send this tick makes:
   * `{fireAt, next}`, or null when nothing is due.
   *
   * The series is walked from the scheduled moment, not from the tick clock, so a tick that ran late
   * does not push every later fire late with it. A process that was down for three hours wakes up
   * and sends once — the newest window it slept through — and resumes on the series strictly after
   * now, so the missed hours do not arrive as a burst.
   */
  function advance(j, at, rep) {
    const due = dueAt(j);
    if (due > at) return null;
    if (rep.kind === 'every') {
      const step = rep.n * (UNITS[rep.unit] || UNITS.min);
      const count = Math.floor((at - due) / step) + 1;
      return { fireAt: due + (count - 1) * step, next: due + count * step };
    }
    // daily: step the wall-clock series (a couple of iterations for any realistic downtime, and
    // stepping keeps DST and month ends the calendar's business).
    let next = due;
    let last = due;
    for (let guard = 0; guard < 4000; guard++) {
      last = next;
      next = nextFire(rep, next);
      if (next === null) return null;
      if (next > at) break;
    }
    return { fireAt: last, next };
  }

  async function tick() {
    const startedAt = now();
    const d = doc();
    const plan = [];
    for (const j of d.jobs) {
      if (j.status !== 'pending') continue;
      if (j.claimedAt && startedAt - j.claimedAt <= CLAIM_TTL) continue;
      if (!isRepeating(j.repeat)) {
        if (j.at <= startedAt) plan.push({ job: j, fireAt: j.at, next: null });
        continue;
      }
      const step = advance(j, startedAt, j.repeat);
      if (step) plan.push({ job: j, fireAt: step.fireAt, next: step.next });
    }
    if (!plan.length) return;
    for (const p of plan) p.job.claimedAt = startedAt;
    save(d); // claim first, so a crash mid-send cannot double-book

    const results = await Promise.allSettled(plan.map(async (p) => {
      try {
        const out = await deliver(p.job, deliveryBody(p.job));
        return { plan: p, out };
      } catch (err) {
        err.plan = p;
        throw err;
      }
    }));

    // Read the clock once, after the sends: the store writes and the awaits above take real time.
    const finishedAt = now();
    const d2 = doc();
    // Settled results carry the *plan*, so a rejection still names the row it belongs to.
    for (const r of results) {
      const p = r.status === 'fulfilled' ? r.value.plan : r.reason && r.reason.plan;
      if (!p) continue;
      const j = d2.jobs.find((x) => x.id === p.job.id);
      if (!j) continue;
      delete j.claimedAt;
      if (r.status === 'fulfilled') {
        j.result = r.value.out ?? null;
        delete j.error;
      } else {
        j.error = String(r.reason && r.reason.message ? r.reason.message : r.reason);
        log.warn(`scheduled ${j.id} ${j.module} failed: ${j.error}`);
      }
      if (p.next !== null && isRepeating(j.repeat)) {
        // A repeating job survives a failed send: the next window is still worth having, and the
        // error stays on the row until it fires again.
        const lateness = finishedAt - p.fireAt;
        if (lateness > PAST_SLACK_MS) {
          j.missedAt = lateness;
          log.info(`scheduled ${j.id} ${j.module} ran ${Math.round(lateness / 60_000)}m late (window ${new Date(p.fireAt).toISOString()})`);
        } else {
          delete j.missedAt;
        }
        j.at = p.fireAt;
        j.next = p.next;
        j.status = 'pending';
        j.runs = (j.runs || 0) + 1;
        log.info(`scheduled ${j.id} ${j.module} ${r.status === 'fulfilled' ? 'sent' : 'failed'} (run ${j.runs}), next ${new Date(j.next).toISOString()}`);
      } else if (r.status === 'fulfilled') {
        j.status = 'sent';
        j.finishedAt = finishedAt;
        log.info(`scheduled ${j.id} ${j.module} sent`);
      } else {
        j.status = 'failed';
        j.finishedAt = finishedAt;
      }
    }
    save(d2);
  }

  function start() {
    if (timer) return;
    // A tick that throws must not kill the queue: log it and keep the interval.
    timer = setInterval(() => {
      tick().catch((err) => log.warn(`scheduler tick: ${err.message}`));
    }, TICK_MS);
    timer.unref?.();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const routes = [
    {
      method: 'GET',
      path: '/api/schedules',
      handler(req, res, url) {
        const q = Object.fromEntries(url.searchParams.entries());
        return { ok: true, ...list({ module: q.module || null, pending: q.pending === '1' }) };
      },
    },
    {
      method: 'POST',
      path: '/api/schedules',
      handler(req, res, url, body) {
        return { ok: true, job: book(body || {}) };
      },
    },
    {
      method: 'PATCH',
      path: /^\/api\/schedules\/([^/]+)$/,
      handler(req, res, url, body, params) {
        return { ok: true, job: edit(decodeURIComponent(params[0]), body || {}) };
      },
    },
    {
      method: 'POST',
      path: /^\/api\/schedules\/([^/]+)\/run$/,
      handler(req, res, url, body, params) {
        return { ok: true, job: runNow(decodeURIComponent(params[0])) };
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/schedules\/([^/]+)$/,
      handler(req, res, url, body, params) {
        return { ok: true, job: cancel(decodeURIComponent(params[0])) };
      },
    },
  ];

  return { book, edit, cancel, runNow, list, tick, start, stop, routes, deliveryBody, routeOf, view };
}
