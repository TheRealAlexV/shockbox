// Scheduled sends — the booked queue, as a panel each module's pane shows under quick send.
//
// Booking lives in the quick-send box; this is the other half: what is booked, when it next fires,
// and the verbs an operator needs on a booked send (run now, edit, drop). It polls while visible
// rather than subscribing, because the queue changes rarely and an SSE channel per pane for a
// handful of rows is more machinery than the feature deserves.
//
// Editing is inline, never a native prompt: the OBS browser source has no dialog surface and the
// headless test has no way to answer one. An edit replaces the row with a small form carrying the
// same three fields the booking used — when, how often, and what — and PATCHes only what changed.
//
// `missed` is the honest state the queue reports about itself: a row whose window went by while
// the process was down. It is shown, never hidden, because a send that silently never happened is
// worse than one that says so.

import { el, clear } from './ui.js';
import { toast } from './toast.js';

const UNITS = [
  ['min', 'minutes'],
  ['sec', 'seconds'],
  ['hour', 'hours'],
  ['day', 'days'],
];

const MODULE_LABELS = {
  wall: 'Wall',
  dialogs: 'Dialogs',
  notifications: 'Notifications',
  handfx: 'Hand FX',
  core: 'Core',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'HH:MM' from a moment, in local time. */
function hhmm(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A short, human sentence for when a row fires next. */
function fmtWhen(ms, now) {
  const d = new Date(ms);
  const diff = ms - now;
  const abs = Math.abs(diff);
  const time = hhmm(ms);
  if (diff < -60_000) return `${Math.round(abs / 60_000)}m late`;
  if (abs < 60_000) return diff >= 0 ? 'in <1m' : 'due now';
  if (abs < 3_600_000) return `in ${Math.round(abs / 60_000)}m`;
  if (abs < 6 * 3_600_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    return `in ${h}h${m ? ` ${m}m` : ''}`;
  }
  if (d.toDateString() === new Date(now).toDateString()) return `today ${time}`;
  const tomorrow = new Date(now + 86_400_000);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** How a repeat reads in the row: 'every 20 min', 'daily 19:00', or nothing for a one-shot. */
function fmtRepeat(rep) {
  if (!rep || rep.kind === 'once' || !rep.kind) return '';
  if (rep.kind === 'daily') return `daily ${rep.at}`;
  if (rep.kind === 'every') return `every ${rep.n} ${rep.n === 1 ? rep.unit : `${rep.unit}s`}`;
  return rep.kind;
}

/** What the row says it will send. */
function fmtWhat(j) {
  if (j.title) return j.title;
  if (j.text) return j.text;
  if (j.poolId) return `pool ${j.poolId}`;
  if (j.action && !/\.send$/.test(j.action)) return j.action;
  return 'random message';
}

/** An `every` repeat as {n, unit}, defaulting to what an operator reaches for most. */
function everyParts(rep) {
  if (rep && rep.kind === 'every') return { n: rep.n, unit: rep.unit };
  return { n: 20, unit: 'min' };
}

/**
 * The repeat picker: one select plus two inputs that appear only for the mode they belong to.
 * The same control books and edits, so the two forms cannot drift apart.
 */
function repeatPicker(initial) {
  const rep = initial || { kind: 'once' };
  const kind = el('select', { class: 'input sch-rep-kind', 'aria-label': 'How often' },
    el('option', { value: 'once', text: 'Once' }),
    el('option', { value: 'every', text: 'Every' }),
    el('option', { value: 'daily', text: 'Daily at' }),
  );
  kind.value = rep.kind === 'every' ? 'every' : rep.kind === 'daily' ? 'daily' : 'once';
  const { n, unit } = everyParts(rep);
  const nInput = el('input', { type: 'number', class: 'input sch-rep-n', min: '1', step: '1', value: String(n), 'aria-label': 'Count' });
  const unitSel = el('select', { class: 'input sch-rep-unit', 'aria-label': 'Unit' },
    UNITS.map(([v, label]) => el('option', { value: v, text: label })),
  );
  unitSel.value = unit;
  const atInput = el('input', { type: 'time', class: 'input sch-rep-at', value: rep.kind === 'daily' ? rep.at : '19:00', 'aria-label': 'Time of day' });

  const everyWrap = el('span', { class: 'sch-rep-every', hidden: true }, nInput, unitSel);
  const dailyWrap = el('span', { class: 'sch-rep-daily', hidden: true }, atInput);
  function sync() {
    everyWrap.hidden = kind.value !== 'every';
    dailyWrap.hidden = kind.value !== 'daily';
  }
  sync();
  kind.addEventListener('change', sync);

  const node = el('span', { class: 'sch-rep' }, kind, everyWrap, dailyWrap);

  /** The `repeat` value for the wire: `{kind:'once'}` is sent explicitly so an edit can clear one. */
  function value() {
    if (kind.value === 'every') return { kind: 'every', n: Math.max(1, Math.round(Number(nInput.value) || 1)), unit: unitSel.value };
    if (kind.value === 'daily') return { kind: 'daily', at: atInput.value || '19:00' };
    return { kind: 'once' };
  }

  return { node, value };
}

/**
 * @param {HTMLElement} container
 * @param {{ module?: string, api: object, title?: string, grouped?: boolean, signal?: AbortSignal }} opts
 *   `module` scopes the panel to one module's rows (the mode the three panes use). Without it the
 *   panel lists every module grouped by heading, which is what the control page wants.
 * @returns {{ refresh: () => Promise<void>, destroy: () => void }}
 */
export function mountSchedulePanel(container, opts) {
  clear(container);
  const body = el('div', { class: 'sch-body' });
  const countEl = el('span', { class: 'panel-hint mono dim', text: '—' });
  const panel = el('section', { class: 'panel sch' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: opts.title || 'Scheduled' }),
      el('span', { class: 'panel-hint dim', text: 'books from quick send' }),
      countEl,
    ),
    body,
  );
  container.append(panel);

  let timer = null;
  let destroyed = false;
  let editing = null; // the id whose inline editor is open, so a poll does not close it

  /** Run one verb and repaint; a failure says so and leaves the row alone. */
  async function verb(job, label, fn) {
    try {
      await fn();
      toast(label, 'ok');
      await refresh();
    } catch (err) {
      toast(`${label} failed: ${err.message}`, 'error');
    }
  }

  function editRow(job, now) {
    const whenInput = el('input', {
      type: 'datetime-local',
      class: 'input sch-edit-at',
      value: toLocalInput(job.due || job.at),
      'aria-label': 'When',
    });
    const picker = repeatPicker(job.repeat);
    // A command payload keeps its verb; a message keeps its text. Editing "what" is only offered
    // for text, because a command's arguments are the booking's shape, not a sentence.
    const isText = Boolean(job.text) || (!job.action || /\.send$/.test(job.action));
    const textInput = isText
      ? el('input', { type: 'text', class: 'input sch-edit-text', value: job.text || '', placeholder: 'message text', 'aria-label': 'What to send' })
      : null;
    const saveBtn = el('button', { type: 'button', class: 'btn btn-sm sch-edit-save', text: 'Save' });
    const cancelBtn = el('button', { type: 'button', class: 'btn btn-sm btn-icon sch-edit-cancel', text: '×', 'aria-label': 'Cancel editing', title: 'Cancel' });

    const form = el('div', { class: 'sch-edit' },
      whenInput,
      picker.node,
      textInput,
      saveBtn,
      cancelBtn,
    );

    saveBtn.addEventListener('click', async () => {
      const patch = { at: fromLocalInput(whenInput.value) };
      if (!Number.isFinite(patch.at)) {
        toast('pick a time first', 'error');
        return;
      }
      patch.repeat = picker.value();
      if (textInput && textInput.value !== (job.text || '')) patch.text = textInput.value;
      saveBtn.disabled = true;
      try {
        await opts.api.patch(`/api/schedules/${encodeURIComponent(job.id)}`, patch);
        editing = null;
        toast('schedule updated', 'ok');
        await refresh();
      } catch (err) {
        saveBtn.disabled = false;
        toast(`edit failed: ${err.message}`, 'error');
      }
    });
    cancelBtn.addEventListener('click', () => {
      editing = null;
      refresh().catch(() => {});
    });
    for (const input of [whenInput, textInput]) {
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void saveBtn.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          void cancelBtn.click();
        }
      });
    }

    const li = el('li', { class: 'sch-row sch-row-edit', dataset: { id: job.id } }, form);
    queueMicrotask(() => whenInput.focus());
    return li;
  }

  function row(job, now) {
    const pending = job.status === 'pending';
    const repeats = job.repeat && job.repeat.kind && job.repeat.kind !== 'once';
    const when = pending ? fmtWhen(job.due || job.at, now) : job.status;
    const what = fmtWhat(job);
    const repeatText = repeats ? fmtRepeat(job.repeat) : '';

    const whenCell = el('span', { class: 'sch-when' },
      el('span', { class: 'sch-when-main mono', text: when }),
      repeatText ? el('span', { class: 'sch-repeat mono dim', text: repeatText }) : null,
      // The window the app slept through, said out loud rather than silently swallowed.
      job.missed ? el('span', { class: 'sch-badge sch-missed', text: 'missed', title: 'this window passed while the app was down — it fires once on the next tick' }) : null,
      job.lateBy ? el('span', { class: 'sch-badge sch-late', text: `${Math.round(job.lateBy / 60_000)}m late` }) : null,
    );
    const whatCell = el('span', { class: 'sch-text', text: what.length > 90 ? `${what.slice(0, 89)}…` : what, title: what });
    const li = el('li', { class: 'sch-row', dataset: { id: job.id, status: job.status, repeat: repeats ? job.repeat.kind : 'once' } }, whenCell, whatCell);

    if (job.missed) li.dataset.missed = 'true';

    if (pending) {
      const run = el('button', { type: 'button', class: 'btn btn-sm sch-run', text: 'Run', title: 'Send on the next tick' });
      run.addEventListener('click', () => {
        run.disabled = true;
        void verb(job, 'queued for the next tick', () => opts.api.post(`/api/schedules/${encodeURIComponent(job.id)}/run`));
      });
      const edit = el('button', { type: 'button', class: 'btn btn-sm sch-edit', text: 'Edit', title: 'Change when, how often, or what' });
      edit.addEventListener('click', () => {
        editing = job.id;
        refresh().catch(() => {});
      });
      const drop = el('button', { type: 'button', class: 'btn btn-sm sch-cancel', text: 'Cancel' });
      drop.addEventListener('click', () => {
        drop.disabled = true;
        void verb(job, 'cancelled', () => opts.api.del(`/api/schedules/${encodeURIComponent(job.id)}`));
      });
      li.append(run, edit, drop);
    } else if (job.error) {
      li.append(el('span', { class: 'sch-error dim mono', text: job.error.slice(0, 60), title: job.error }));
    }
    return li;
  }

  async function refresh() {
    if (destroyed) return;
    let r;
    try {
      r = await opts.api.get('/api/schedules');
    } catch {
      return; // a dead scheduler endpoint must not spam the pane
    }
    if (destroyed) return;
    const now = r.now || Date.now();
    const all = (r.jobs || []).filter((j) => !opts.module || j.module === opts.module);
    const pending = all.filter((j) => j.status === 'pending');
    const recent = all.filter((j) => j.status !== 'pending').slice(-3).reverse();
    const rows = [...pending, ...recent];

    const missed = pending.filter((j) => j.missed).length;
    countEl.textContent = pending.length
      ? `${pending.length} pending${missed ? ` · ${missed} missed` : ''}`
      : 'nothing booked';

    clear(body);
    if (!rows.length) {
      body.append(el('div', { class: 'sch-empty dim', text: opts.module ? 'nothing booked for this module' : 'nothing booked' }));
      return;
    }

    // Grouped by module when the panel spans modules; a single module needs no heading.
    const groups = new Map();
    for (const j of rows) {
      if (!groups.has(j.module)) groups.set(j.module, []);
      groups.get(j.module).push(j);
    }
    for (const [mod, jobs] of groups) {
      if (!opts.module) {
        const g = r.byModule && r.byModule[mod];
        body.append(el('div', { class: 'sch-group-head', dataset: { module: mod } },
          el('span', { class: 'sch-group-title', text: MODULE_LABELS[mod] || mod }),
          g ? el('span', { class: 'sch-group-count mono dim', text: `${g.pending} pending${g.missed ? ` · ${g.missed} missed` : ''}` }) : null,
        ));
      }
      const list = el('ul', { class: 'sch-list', dataset: { module: mod } });
      for (const j of jobs) {
        list.append(editing === j.id && j.status === 'pending' ? editRow(j, now) : row(j, now));
      }
      body.append(list);
    }
  }

  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), 15_000);
  opts.signal?.addEventListener('abort', () => destroy());

  function destroy() {
    destroyed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, destroy };
}

/** ms → the value a `datetime-local` input wants ('YYYY-MM-DDTHH:MM'), in local time. */
export function toLocalInput(ms) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `datetime-local` value → ms. A minute with no seconds is the minute the operator picked. */
export function fromLocalInput(text) {
  if (!text) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
}
