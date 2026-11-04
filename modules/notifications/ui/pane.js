// Notifications control pane.
//
// The module draws toasts on a 405×720 phone stage inside OBS. This pane is the operator's
// desk next to it: the real /notify page in a live 16:9 iframe, the stack controls, a pool
// send, and the look straight from the module's settings schema.
//
// Data:
//   GET    /api/notifications/live       {rev, live:[entity], stack:{x,gap,height,used,capacity}, lastSpawnAt, settings}
//   POST   /api/notifications/live       {} (random from the pool) | {poolId} | {any:true} | {spec}
//   POST   /api/notifications/live/storm {mode:'fill'|'random', count, interval}
//   DELETE /api/notifications/live       close every live toast
//   PATCH  /api/notifications/settings   {key:value} → persists + pushes `relayout`
//   GET    /api/pool/notifications       message list for the picker
//   GET    /api/notifications/audio/list   clip names the sound directory offers (tone picker)
// Live:
//   channel `notifications`, cmd `snapshot` | `relayout`; event `sound` is informational.
//
// The preview is the module's own page (/notify), so every look class and every toast size is
// the one OBS draws. The pane never redraws a toast.

import { el, clear, dot, actionButton, fmtAgo, every } from '/src/ui.js';
import { toast } from '/src/toast.js';
import { renderSettingsForm } from '/src/settings-form.js';
import { mountQuickSend } from '/src/quicksend.js';
import { mountSchedulePanel } from '/src/schedule-panel.js';
import { mountPreview } from '/src/preview.js';

/* The canvas the module lays out in (modules/notifications/state.mjs CANVAS_W/H). */
const CANVAS_W = 405;
const CANVAS_H = 720;
const MAX_STACK = 7; // the module's capacity; a full stack is reported at capacity

const LOOKS = {
  ios: 'iOS',
  android: 'Android',
  win11: 'Windows 11',
  macos: 'macOS',
};

const TYPE_TONE = { Error: 'bad', Alert: 'warn', Warning: 'warn', System: 'info', Question: 'accent' };

/** The schema rows this pane draws with its own controls. */
const PANE_OWNED_KEYS = new Set(['style', 'height']);

function showTone(type) {
  return TYPE_TONE[type] || 'info';
}

export async function render(container, ctx) {
  const { api, events } = ctx;
  const unsubs = [];
  const timers = [];

  /* ------------------------------------------------------------ state */

  let live = []; // entities, born-order as the server sends them
  let stack = null; // {x, gap, height, used, capacity}
  let settingsMeta = ctx.settings || {};
  let lastSpawnAt = 0;
  let streamAt = 0;
  let pool = [];
  let toneNames = null; // /api/notifications/audio/list files, or null when unavailable

  /* ------------------------------------------------------------ structure */

  const header = el('div', { class: 'pane-head' });
  const headStatus = el('div', { class: 'pane-head-status' });
  header.append(
    el('div', { class: 'pane-title-wrap' },
      el('h1', { class: 'pane-title', text: 'Notifications' }),
      el('p', { class: 'pane-desc', text: ctx.module.description || 'Toasts on the phone strip.' }),
    ),
    headStatus,
  );

  /* --- controls: spawn / clear / storm ------------------------------------ */

  const spawnBtn = actionButton({
    label: 'Spawn toast',
    variant: 'btn-primary',
    title: 'Draw a random notification message from the pool',
    run: () => api.post('/api/notifications/live', {}),
    onDone: () => toast('toast spawned', 'ok'),
    onError: (err) => toast(`spawn failed: ${err.message}`, 'error'),
  });
  const clearBtn = actionButton({
    label: 'Clear all',
    variant: 'btn-danger',
    title: 'Close every live toast',
    confirm: 'Confirm clear',
    run: () => api.del('/api/notifications/live'),
    onDone: (out) => toast(`cleared ${out?.closed ?? 0}`, 'ok'),
    onError: (err) => toast(`clear failed: ${err.message}`, 'error'),
  });
  const poolLink = el('a', { class: 'btn btn-quiet', href: '#/messages?tab=notifications', text: 'Edit messages' });

  const stormMode = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Storm mode' });
  const stormModes = [
    { id: 'fill', label: 'Fill', title: 'One of every storm-eligible message' },
    { id: 'random', label: 'Random', title: 'Random picks, `count` of them' },
  ];
  const stormSegs = new Map();
  for (const m of stormModes) {
    const b = el('button', { type: 'button', class: 'seg', role: 'radio', text: m.label, dataset: { value: m.id }, title: m.title });
    b.setAttribute('aria-checked', String(m.id === 'fill'));
    b.addEventListener('click', () => { stormModeId = m.id; paintStorm(); });
    stormSegs.set(m.id, b);
    stormMode.append(b);
  }
  let stormModeId = 'fill';
  let stormCount = 6;
  let stormInterval = 320;
  const countWrap = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Storm count' });
  const countSegs = new Map();
  for (const n of [3, 6, 9, 12]) {
    const b = el('button', { type: 'button', class: 'seg mono', role: 'radio', text: String(n) });
    b.setAttribute('aria-checked', String(n === stormCount));
    b.addEventListener('click', () => { stormCount = n; paintStorm(); });
    countSegs.set(n, b);
    countWrap.append(b);
  }
  const intervalBox = el('input', { type: 'number', class: 'input input-num', min: '40', max: '4000', step: '20', value: String(stormInterval), 'aria-label': 'Storm interval (ms)' });
  intervalBox.addEventListener('change', () => {
    const n = Number(intervalBox.value);
    stormInterval = Number.isFinite(n) ? Math.max(40, Math.min(4000, Math.round(n))) : stormInterval;
    intervalBox.value = String(stormInterval);
  });
  const stormBtn = actionButton({
    label: 'Storm',
    title: 'Spawn a burst',
    run: () => api.post('/api/notifications/live/storm', { mode: stormModeId, count: stormCount, interval: stormInterval }),
    onDone: (out) => toast(`storm: ${out?.spawned ?? 0} toast${out?.spawned === 1 ? '' : 's'}`, 'ok'),
    onError: (err) => toast(`storm failed: ${err.message}`, 'error'),
  });

  const stormPanel = el('section', { class: 'panel nt-storm' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Storm' }),
      el('span', { class: 'panel-hint mono dim', text: 'pool → strip' }),
    ),
    el('div', { class: 'nt-storm-body' },
      el('span', { class: 'look-label', text: 'Mode' }), stormMode,
      el('span', { class: 'look-label', text: 'Count' }), countWrap,
      el('span', { class: 'look-label', text: 'Gap' }), intervalBox,
      el('span', { class: 'mono dim nt-unit', text: 'ms' }),
      el('span', { class: 'control-spacer' }), stormBtn,
    ),
  );

  const controlBar = el('div', { class: 'control-bar' },
    spawnBtn, clearBtn, el('span', { class: 'control-sep' }), poolLink,
  );

  function paintStorm() {
    for (const [id, b] of stormSegs) b.setAttribute('aria-checked', String(id === stormModeId));
    for (const [n, b] of countSegs) b.setAttribute('aria-checked', String(n === stormCount));
    countWrap.dataset.disabled = String(stormModeId === 'fill');
    for (const b of countSegs.values()) b.setAttribute('aria-disabled', String(stormModeId === 'fill'));
    stormBtn.title = stormModeId === 'fill' ? 'Spawn one of every storm-eligible message' : `Spawn ${stormCount} random toasts`;
  }

  /* --- pool ---- The message pool is reached through the quick-send box at the top of the page:
     one picker, searchable and tag-filterable, instead of a second <select> here. ------------- */

  function paintPool() {
    // the pool list still feeds the box (it renders its own copy); nothing local to repaint
    quickBox.refresh().catch(() => {});
  }

  /* --- preview: the module's real page, live ------------------------------
     /notify is the OBS surface itself: a 16:9 page with the 405x720 stage already drawn inside
     it. The preview is that page in a full-canvas 16:9 iframe, not a redrawn approximation. */

  const stackOut = el('span', { class: 'nt-stack-count mono', text: '0 / 0' });
  const previewHost = el('div', { class: 'nt-preview-host' });
  mountPreview(previewHost, {
    title: 'Notification window',
    hint: `${CANVAS_W} x ${CANVAS_H} · live`,
    src: '/notify',
    // the page draws its own stage inside the 16:9 surface; no crop guide needed
    fence: false,
  });

  const previewPanel = el('section', { class: 'panel nt-preview' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Notification window' }),
      stackOut,
      el('span', { class: 'panel-hint mono dim', text: `${CANVAS_W} x ${CANVAS_H} · live page` }),
    ),
    previewHost,
  );

  /** The page paints the toasts; the pane only mirrors the stack counters from the bus. */
  function paintPreview() {
    const capacity = Math.max(1, Number(stack?.capacity) || MAX_STACK);
    const shown = [...live].sort((a, b) => (a.born || 0) - (b.born || 0));
    stackOut.textContent = `${stack?.used ?? shown.length} / ${capacity}`;
    stackOut.dataset.state = (stack?.used ?? shown.length) >= capacity ? 'full' : 'ok';
  }

  /* --- live list: what is on the strip now -------------------------------- */

  const list = el('ol', { class: 'nt-log' });
  const listPanel = el('section', { class: 'panel nt-live' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'On the strip' }),
      el('span', { class: 'panel-hint mono dim', text: 'newest first' }),
    ),
    list,
  );

  function paintList() {
    const rows = [...live].sort((a, b) => (b.born || 0) - (a.born || 0)).slice(0, 8);
    clear(list);
    if (!rows.length) {
      list.appendChild(el('li', { class: 'nt-log-empty dim', text: 'nothing on the strip' }));
      return;
    }
    for (const entity of rows) {
      const row = el('li', { class: 'nt-log-row', dataset: { id: entity.id } },
        dot(showTone(entity.type), entity.type || ''),
        el('span', { class: 'nt-log-type mono', text: entity.type || '—' }),
        el('span', { class: 'nt-log-text', text: entity.title ? `${entity.title} — ${entity.text || ''}` : entity.text || '' }),
        el('span', { class: 'nt-log-when mono dim', text: fmtAgo(entity.born) }),
      );
      list.appendChild(row);
    }
  }

  /* --- status: stream + last spawn --------------------------------------- */

  const streamOut = el('span', { class: 'mono nt-stream', text: 'sse · connecting' });
  const spawnOut = el('span', { class: 'mono dim', text: '—' });
  const statusStrip = el('div', { class: 'nt-status' },
    el('span', { class: 'look-label', text: 'Bus' }), streamOut,
    el('span', { class: 'look-sep' }),
    el('span', { class: 'look-label', text: 'Last spawn' }), spawnOut,
  );

  function paintStream() {
    const age = streamAt ? Date.now() - streamAt : null;
    const fresh = age !== null && age < 90_000;
    streamOut.dataset.state = fresh ? 'live' : age === null ? 'connecting' : 'idle';
    streamOut.textContent = age === null ? 'sse · connecting' : fresh ? 'sse · live' : `sse · quiet ${Math.round(age / 60_000)}m`;
    streamOut.title = age === null ? 'waiting for the first frame' : `last frame ${Math.round(age / 1000)}s ago`;
    spawnOut.textContent = lastSpawnAt ? `${fmtAgo(lastSpawnAt)} ago` : '—';
  }
  timers.push(every(5000, () => { paintStream(); paintList(); }));

  /* --- settings slot ------------------------------------------------------ */

  const settingsSlot = el('div', { class: 'pane-settings nt-settings' });

  const body = el('div', { class: 'nt-body' },
    el('div', { class: 'nt-main' },
      previewPanel,
      stormPanel,
      settingsSlot,
    ),
    el('aside', { class: 'nt-side' },
      listPanel,
      el('section', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Live state' })),
        statusStrip,
      ),
    ),
  );

  // Quick send sits above everything: the common action on this page is "make a toast happen",
  // and the old pool panel buried it below the preview.
  const quickSlot = el('div', { class: 'qs-slot' });
  const quickBox = mountQuickSend(quickSlot, {
    title: 'Quick send',
    api,
    events,
    poolId: 'notifications',
    kinds: ['notification'],
    placeholder: 'Show a notification on the strip…',
    allowEmpty: true,
    allowRandom: true,
    onSend: (p) => api.post('/api/notifications/live', p.text ? { text: p.text, title: p.title || undefined } : { poolId: p.poolId }),
    onSchedule: (p) => api.post('/api/schedules', { module: 'notifications', at: p.at, payload: p.text ? { text: p.text, title: p.title || undefined } : { poolId: p.poolId } }),
    onSave: (p) => api.post('/api/pool/notifications/messages', { text: p.text, title: p.title || undefined, kind: 'notification' }),
    signal: ctx.signal,
  });

  clear(container);
  const schedSlot = el('div', { class: 'sch-slot' });
  mountSchedulePanel(schedSlot, { module: 'notifications', api, title: 'Scheduled notifications', signal: ctx.signal });

  container.append(header, quickSlot, schedSlot, controlBar, body);

  /* ---------------------------------------------------------------- data */

  function applyLive(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.live)) live = data.live;
    if (data.stack) stack = data.stack;
    if (data.settings) settingsMeta = data.settings;
    if (Number.isFinite(Number(data.lastSpawnAt))) lastSpawnAt = Number(data.lastSpawnAt);
    paintPreview();
    paintList();
    paintStream();
  }

  async function pull() {
    try {
      const data = await api.get('/api/notifications/live', { signal: ctx.signal });
      applyLive(data);
      if (data && data.settings) mountForm(data.settings);
    } catch (err) {
      if (ctx.signal.aborted) return;
      clear(settingsSlot);
      settingsSlot.appendChild(el('div', { class: 'live-error', text: `could not read notifications: ${err.message}` }));
    }
    try {
      const a = await api.get('/api/notifications/audio/list', { signal: ctx.signal });
      toneNames = Array.isArray(a?.files) && a.files.length ? a.files : null;
    } catch {
      toneNames = null; // not fatal: the tone row stays a plain text field
    }
    if (toneNames && form) form.refresh(settingsMeta);
    try {
      const p = await api.get('/api/pool/notifications', { signal: ctx.signal });
      pool = Array.isArray(p?.messages) ? p.messages : [];
      paintPool();
    } catch {
      pool = [];
      paintPool();
    }
  }

  let form = null;
  function mountForm(meta) {
    // The live route carries the same describe() shape as the settings form wants.
    if (form) {
      form.refresh(meta);
      return;
    }
    clear(settingsSlot);
    form = renderSettingsForm(settingsSlot, {
      settings: meta,
      title: 'Look',
      signal: ctx.signal,
      // `tone` is a string but its legal values are the clips on disk, not free text.
      choices: (key) => (key === 'tone' && toneNames && toneNames.length ? toneNames : null),
      help: (key) => (key === 'tone' && !toneNames ? 'No sound directory readable — see --sounds.' : undefined),
      onSave: async (patch) => {
        const out = await api.patch('/api/notifications/settings', patch);
        if (out && out.settings) {
          settingsMeta = out.settings;
          ctx.settings = { ...out.settings };
        }
        paintPreview();
        return out;
      },
    });
    // The style and height quick controls above own these keys; the form must not PATCH them
    // from a second place.
    form?.omitRows?.((key) => PANE_OWNED_KEYS.has(key));
    form?.renameGroup?.('general', 'Look');
    form?.omitGroupRow?.('general');
  }

  /* --- style + height as quick controls above the form ------------------- */

  const lookSeg = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Toast look' });
  const lookSegs = new Map();
  for (const [id, label] of Object.entries(LOOKS)) {
    const b = el('button', { type: 'button', class: 'seg', role: 'radio', text: label, dataset: { value: id } });
    b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', () => patchSettings({ style: id }));
    lookSegs.set(id, b);
    lookSeg.append(b);
  }
  const heightRange = el('input', { type: 'range', id: 'nt-height', min: '48', max: '160', step: '1', 'aria-label': 'Toast height' });
  const heightVal = el('span', { class: 'mono nt-height-val', text: '76' });
  let heightTimer = null;
  heightRange.addEventListener('input', () => {
    heightVal.textContent = heightRange.value;
    clearTimeout(heightTimer);
    heightTimer = setTimeout(() => patchSettings({ height: Number(heightRange.value) }), 220);
  });
  heightRange.addEventListener('change', () => {
    clearTimeout(heightTimer);
    patchSettings({ height: Number(heightRange.value) });
  });
  timers.push(() => clearTimeout(heightTimer));

  const quick = el('div', { class: 'look-bar nt-quick' },
    el('span', { class: 'look-label', text: 'Look' }), lookSeg,
    el('span', { class: 'look-sep' }),
    el('span', { class: 'look-label', text: 'Height' }), heightRange, heightVal,
    el('span', { class: 'mono dim', text: 'px' }),
  );
  // The quick line goes under the header, above the preview.
  container.insertBefore(quick, body);

  function paintQuick() {
    const styleKey = String(settingsMeta.style?.value || 'ios');
    for (const [id, b] of lookSegs) b.setAttribute('aria-checked', String(id === styleKey));
    const h = Number(settingsMeta.height?.value) || 76;
    if (document.activeElement !== heightRange) heightRange.value = String(h);
    heightVal.textContent = String(h);
  }

  async function patchSettings(patch) {
    if (ctx.signal.aborted) return null;
    try {
      const out = await api.patch('/api/notifications/settings', patch);
      if (out && out.settings) {
        settingsMeta = out.settings;
        ctx.settings = { ...out.settings };
        form?.refresh?.(out.settings);
      }
      paintQuick();
      paintPreview();
      return out;
    } catch (err) {
      toast(`not saved: ${err.message}`, 'error');
      // snap back to the server's value: callers read from settingsMeta, so re-read it
      try {
        const data = await api.get('/api/notifications/live', { signal: ctx.signal });
        if (data && data.settings) settingsMeta = data.settings;
      } catch {
        /* keep what we have; the toast already said it failed */
      }
      paintQuick();
      paintPreview();
      return null;
    }
  }

  /* ---------------------------------------------------------------- live */

  let lastStamp = '';
  function onFrame(frame) {
    if (!frame) return;
    if (frame.reset || frame.hello) {
      if (frame.reset) pull();
      return;
    }
    const stamp = `${frame.channel}|${frame.event ?? frame.cmd ?? ''}|${frame.data?.rev ?? ''}|${frame.data?.t ?? ''}`;
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    streamAt = Date.now();
    paintStream();
    if (frame.channel !== 'notifications') return;
    const d = frame.data || {};
    if (frame.event === 'sound') {
      // informational: the overlay plays it; the pane just says so on the event line
      streamOut.dataset.sound = String(Date.now());
      return;
    }
    // `snapshot` and `relayout` both carry the whole state document
    if (d.rev !== undefined || d.live || d.stack) applyLive(d);
    if (d.settings) {
      settingsMeta = d.settings;
      form?.refresh?.(d.settings);
      paintQuick();
      paintPreview();
    }
  }

  unsubs.push(events.subscribe(null, onFrame));

  // The SSE bus is long-lived and silent when nobody acts; a slow poll keeps the "ago" column
  // and the stack honest if a frame is missed (a reload, a dropped write).
  const poll = setInterval(() => {
    if (document.hidden || ctx.signal.aborted) return;
    api.get('/api/notifications/live', { signal: ctx.signal }).then((d) => {
      if (!d) return;
      applyLive(d);
      if (d.settings && !form) mountForm(d.settings);
    }).catch(() => {});
  }, 5000);
  timers.push(() => clearInterval(poll));

  /* ---------------------------------------------------------------- boot */

  await pull();
  paintStorm();
  paintQuick();
  paintStream();

  return () => {
    for (const u of unsubs) {
      try { u?.(); } catch { /* ignore */ }
    }
    for (const t of timers) {
      try { t?.(); } catch { /* ignore */ }
    }
  };
}
