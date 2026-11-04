// Alerts (dialogs) control pane.
//
// The module draws fake OS error dialogs that cascade over a 405×720 phone strip inside OBS.
// This pane is the operator's desk next to it: the real /dialogs page in a live 16:9 iframe,
// real cascade positions, the spawn controls, a pool send, and the look from the schema.
//
// Data:
//   GET    /api/dialogs/live        {rev, live:[entity], count, capacity, settings}
//   POST   /api/dialogs/live        {} (random from the pool) | {poolId} | {any:true} | {spec}
//   POST   /api/dialogs/live/storm  {mode:'fill'|'random', count, interval}
//   DELETE /api/dialogs/live        close every dialog
//   PATCH  /api/dialogs/settings    {key:value} → persists + pushes `relayout`
//   GET    /api/pool/dialogs        message list for the picker
//   GET    /api/dialogs/audio/list         clip names the sound directory offers (tone picker)
// Live:
//   channel `dialogs`, cmd `snapshot` | `relayout`; event `sound` is informational.
//
// The preview is the module's own look: the same skin class (skin-win11 / skin-win95 /
// skin-macos) on the stage, the same .dialog/.titlebar/.ttitle/.body/.icon/.msg/.buttons
// structure, drawn at the entity's x/y/w/h from the server. Only the scale is applied in CSS.

import { el, clear, dot, actionButton, fmtAgo, every } from '/src/ui.js';
import { toast } from '/src/toast.js';
import { renderSettingsForm } from '/src/settings-form.js';
import { mountQuickSend } from '/src/quicksend.js';
import { mountSchedulePanel } from '/src/schedule-panel.js';
import { mountPreview } from '/src/preview.js';

const THEMES = { win11: 'Windows 11', win95: 'Windows 95', macos: 'macOS' };

const ICON_TONE = { error: 'bad', warning: 'warn', info: 'info', question: 'accent', none: 'idle' };

/* The schema rows this pane draws with its own quick controls. */
const PANE_OWNED_KEYS = new Set(['theme', 'scale']);

export async function render(container, ctx) {
  const { api, events } = ctx;
  const unsubs = [];
  const timers = [];

  /* ------------------------------------------------------------ state */

  let live = [];
  let capacity = 80;
  let settingsMeta = ctx.settings || {};
  let streamAt = 0;
  let pool = [];

  /* ------------------------------------------------------------ structure */

  const header = el('div', { class: 'pane-head' });
  const headStatus = el('div', { class: 'pane-head-status' });
  header.append(
    el('div', { class: 'pane-title-wrap' },
      el('h1', { class: 'pane-title', text: 'Alerts' }),
      el('p', { class: 'pane-desc', text: ctx.module.description || 'Fake error dialogs on the phone strip.' }),
    ),
    headStatus,
  );

  /* --- controls ---------------------------------------------------------- */

  const spawnBtn = actionButton({
    label: 'Spawn alert',
    variant: 'btn-primary',
    title: 'Draw a random alert message from the pool',
    run: () => api.post('/api/dialogs/live', { origin: 'pane' }),
    onDone: () => toast('alert spawned', 'ok'),
    onError: (err) => toast(`spawn failed: ${err.message}`, 'error'),
  });
  const clearBtn = actionButton({
    label: 'Close all',
    variant: 'btn-danger',
    title: 'Close every live alert',
    run: () => api.del('/api/dialogs/live'),
    onDone: (out) => toast(`closed ${out?.closed ?? out?.count ?? 0}`, 'ok'),
    onError: (err) => toast(`close failed: ${err.message}`, 'error'),
  });
  const poolLink = el('a', { class: 'btn btn-quiet', href: '#/messages?tab=dialogs', text: 'Edit messages' });

  const controlBar = el('div', { class: 'control-bar' },
    spawnBtn, clearBtn, el('span', { class: 'control-sep' }), poolLink,
  );

  /* --- storm ------------------------------------------------------------- */

  let stormModeId = 'fill';
  let stormCount = 6;
  let stormInterval = 320;
  const stormMode = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Storm mode' });
  const stormSegs = new Map();
  for (const m of [
    { id: 'fill', label: 'Fill', title: 'One of every storm-eligible message' },
    { id: 'random', label: 'Random', title: 'Random picks, `count` of them' },
  ]) {
    const b = el('button', { type: 'button', class: 'seg', role: 'radio', text: m.label, title: m.title });
    b.setAttribute('aria-checked', String(m.id === stormModeId));
    b.addEventListener('click', () => { stormModeId = m.id; paintStorm(); });
    stormSegs.set(m.id, b);
    stormMode.append(b);
  }
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
    run: () => api.post('/api/dialogs/live/storm', { mode: stormModeId, count: stormCount, interval: stormInterval, origin: 'pane' }),
    onDone: (out) => toast(`storm: ${out?.spawned ?? 0} alert${out?.spawned === 1 ? '' : 's'}`, 'ok'),
    onError: (err) => toast(`storm failed: ${err.message}`, 'error'),
  });

  const stormPanel = el('section', { class: 'panel dg-storm' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Storm' }),
      el('span', { class: 'panel-hint mono dim', text: 'pool → strip' }),
    ),
    el('div', { class: 'dg-storm-body' },
      el('span', { class: 'look-label', text: 'Mode' }), stormMode,
      el('span', { class: 'look-label', text: 'Count' }), countWrap,
      el('span', { class: 'look-label', text: 'Gap' }), intervalBox,
      el('span', { class: 'mono dim dg-unit', text: 'ms' }),
      el('span', { class: 'control-spacer' }), stormBtn,
    ),
  );

  function paintStorm() {
    for (const [id, b] of stormSegs) b.setAttribute('aria-checked', String(id === stormModeId));
    for (const [n, b] of countSegs) b.setAttribute('aria-checked', String(n === stormCount));
    countWrap.dataset.disabled = String(stormModeId === 'fill');
    for (const b of countSegs.values()) b.setAttribute('aria-disabled', String(stormModeId === 'fill'));
    stormBtn.title = stormModeId === 'fill' ? 'Spawn one of every storm-eligible alert' : `Spawn ${stormCount} random alerts`;
  }

  /* --- pool picker ------------------------------------------------------- */

  const poolSelect = el('select', { class: 'input dg-select', 'aria-label': 'Message' });
  const poolSendBtn = actionButton({
    label: 'Send',
    run: () => {
      const id = poolSelect.value;
      if (!id) throw new Error('pick a message first');
      return api.post('/api/dialogs/live', { poolId: id, origin: 'pane' });
    },
    onDone: () => toast('alert sent', 'ok'),
    onError: (err) => toast(`send failed: ${err.message}`, 'error'),
  });
  const poolPanel = el('section', { class: 'panel dg-send' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Send a message' }),
      el('span', { class: 'panel-hint mono dim', text: 'from the alerts pool' }),
    ),
    el('div', { class: 'dg-send-body' }, poolSelect, poolSendBtn),
  );

  function paintPool() {
    const current = poolSelect.value;
    clear(poolSelect);
    poolSelect.appendChild(el('option', { value: '', text: pool.length ? 'Pick a message…' : 'pool is empty' }));
    for (const m of pool) {
      const label = m.title ? `${m.title} — ${m.text}` : m.text;
      poolSelect.appendChild(el('option', { value: m.id, text: label.length > 90 ? `${label.slice(0, 89)}…` : label }));
    }
    if (current && pool.some((m) => m.id === current)) poolSelect.value = current;
    poolSendBtn.disabled = !pool.length;
  }

  /* --- preview: the module's real page, live ------------------------------
     /dialogs is the OBS surface itself: a 16:9 page with the centred stage already drawn. The
     preview is that page in a full-canvas 16:9 iframe, not a redrawn dialog. */

  const countOut = el('span', { class: 'dg-count mono', text: '0' });
  const previewHost = el('div', { class: 'dg-preview-host' });
  mountPreview(previewHost, {
    title: 'Alerts page',
    hint: '810 × 1440 canvas · live',
    src: '/dialogs',
    // the page draws its own centred stage inside the 16:9 surface; no crop guide needed
    fence: false,
  });

  const previewPanel = el('section', { class: 'panel dg-preview' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Phone strip' }),
      countOut,
      el('span', { class: 'panel-hint mono dim', text: 'live page' }),
    ),
    previewHost,
  );

  /** The page paints the dialogs; the pane only mirrors the live count from the bus. */
  function paintPreview() {
    countOut.textContent = String(live.length);
  }

  /* --- live list --------------------------------------------------------- */

  const list = el('ol', { class: 'dg-log' });
  const listPanel = el('section', { class: 'panel dg-live' },
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
      list.appendChild(el('li', { class: 'dg-log-empty dim', text: 'nothing on the strip' }));
      return;
    }
    for (const entity of rows) {
      const row = el('li', { class: 'dg-log-row', dataset: { id: entity.id } },
        dot(ICON_TONE[entity.icon] || 'idle', entity.type || ''),
        el('span', { class: 'dg-log-type mono', text: entity.type || '—' }),
        el('span', { class: 'dg-log-text', text: entity.title ? `${entity.title} — ${entity.text || ''}` : entity.text || '' }),
        el('span', { class: 'dg-log-geo mono dim', text: `${Math.round(entity.x || 0)},${Math.round(entity.y || 0)}` }),
        el('span', { class: 'dg-log-when mono dim', text: fmtAgo(entity.born) }),
      );
      list.appendChild(row);
    }
  }

  /* --- status ------------------------------------------------------------ */

  const streamOut = el('span', { class: 'mono dg-stream', text: 'sse · connecting' });
  const capacityOut = el('span', { class: 'mono dim', text: '—' });
  const statusStrip = el('div', { class: 'dg-status' },
    el('span', { class: 'look-label', text: 'Bus' }), streamOut,
    el('span', { class: 'look-sep' }),
    el('span', { class: 'look-label', text: 'Capacity' }), capacityOut,
  );

  function paintStream() {
    const age = streamAt ? Date.now() - streamAt : null;
    const fresh = age !== null && age < 90_000;
    streamOut.dataset.state = fresh ? 'live' : age === null ? 'connecting' : 'idle';
    streamOut.textContent = age === null ? 'sse · connecting' : fresh ? 'sse · live' : `sse · quiet ${Math.round(age / 60_000)}m`;
    streamOut.title = age === null ? 'waiting for the first frame' : `last frame ${Math.round(age / 1000)}s ago`;
    capacityOut.textContent = capacity ? `${live.length} / ${capacity}` : String(live.length);
  }
  timers.push(every(5000, () => { paintStream(); paintList(); }));

  /* --- settings ---------------------------------------------------------- */

  const settingsSlot = el('div', { class: 'pane-settings dg-settings' });

  const body = el('div', { class: 'dg-body' },
    el('div', { class: 'dg-main' },
      previewPanel,
      stormPanel,
      poolPanel,
      settingsSlot,
    ),
    el('aside', { class: 'dg-side' },
      listPanel,
      el('section', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Live state' })),
        statusStrip,
      ),
    ),
  );

  /* --- theme + scale as quick controls ----------------------------------- */

  const themeSeg = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Window theme' });
  const themeSegs = new Map();
  for (const [id, label] of Object.entries(THEMES)) {
    const b = el('button', { type: 'button', class: 'seg', role: 'radio', text: label, dataset: { value: id } });
    b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', () => patchSettings({ theme: id }));
    themeSegs.set(id, b);
    themeSeg.append(b);
  }
  const scaleRange = el('input', { type: 'range', id: 'dg-scale', min: '0.5', max: '1.2', step: '0.01', 'aria-label': 'Dialog scale' });
  const scaleVal = el('span', { class: 'mono dg-scale-val', text: '0.70' });
  let scaleTimer = null;
  scaleRange.addEventListener('input', () => {
    scaleVal.textContent = Number(scaleRange.value).toFixed(2);
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(() => patchSettings({ scale: Number(scaleRange.value) }), 220);
  });
  scaleRange.addEventListener('change', () => {
    clearTimeout(scaleTimer);
    patchSettings({ scale: Number(scaleRange.value) });
  });
  timers.push(() => clearTimeout(scaleTimer));

  const quick = el('div', { class: 'look-bar dg-quick' },
    el('span', { class: 'look-label', text: 'Theme' }), themeSeg,
    el('span', { class: 'look-sep' }),
    el('span', { class: 'look-label', text: 'Scale' }), scaleRange, scaleVal,
  );
  // `quick` sits between the control bar and the body: one line, above the preview.
  // Quick send goes above the control bar, because "send something" is the page's main verb.
  const quickSlot = el('div', { class: 'qs-slot' });
  const quickBox = mountQuickSend(quickSlot, {
    title: 'Quick send',
    api,
    poolId: 'dialogs',
    kinds: ['dialog'],
    placeholder: 'Pop a dialog — text, or pick from the pool…',
    allowRandom: true,
    onSend: (p) => api.post('/api/dialogs/live', p.text
      ? { text: p.text, ...(p.title ? { title: p.title } : {}), origin: 'pane' }
      : { poolId: p.poolId, origin: 'pane' }),
    onSchedule: (p) => api.post('/api/schedules', {
      module: 'dialogs',
      at: p.at,
      payload: p.text ? { text: p.text, ...(p.title ? { title: p.title } : {}) } : { poolId: p.poolId },
    }),
    onSave: (p) => api.post('/api/pool/dialogs/messages', { text: p.text, title: p.title || undefined, kind: 'dialog' }),
    signal: ctx.signal,
  });

  clear(container);
  const schedSlot = el('div', { class: 'sch-slot' });
  mountSchedulePanel(schedSlot, { module: 'dialogs', api, title: 'Scheduled dialogs', signal: ctx.signal });

  container.append(header, quickSlot, schedSlot, controlBar, quick, body);

  function paintQuick() {
    const themeKey = THEMES[settingsMeta.theme?.value] ? settingsMeta.theme.value : 'win11';
    for (const [id, b] of themeSegs) b.setAttribute('aria-checked', String(id === themeKey));
    const s = Number(settingsMeta.scale?.value) || 0.7;
    if (document.activeElement !== scaleRange) scaleRange.value = String(s);
    scaleVal.textContent = s.toFixed(2);
  }

  async function patchSettings(patch) {
    if (ctx.signal.aborted) return null;
    try {
      const out = await api.patch('/api/dialogs/settings', patch);
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
      try {
        const data = await api.get('/api/dialogs/live', { signal: ctx.signal });
        if (data && data.settings) settingsMeta = data.settings;
      } catch {
        /* keep what we have; the toast already said it failed */
      }
      paintQuick();
      paintPreview();
      return null;
    }
  }

  /* ---------------------------------------------------------------- data */

  function applyLive(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.live)) live = data.live;
    if (Number.isFinite(Number(data.capacity))) capacity = Number(data.capacity);
    if (data.settings) settingsMeta = data.settings;
    paintPreview();
    paintList();
    paintStream();
  }

  async function pull() {
    try {
      const data = await api.get('/api/dialogs/live', { signal: ctx.signal });
      applyLive(data);
      if (data && data.settings) mountForm(data.settings);
    } catch (err) {
      if (ctx.signal.aborted) return;
      clear(settingsSlot);
      settingsSlot.appendChild(el('div', { class: 'live-error', text: `could not read alerts: ${err.message}` }));
    }
    try {
      const a = await api.get('/api/dialogs/audio/list', { signal: ctx.signal });
      toneNames = Array.isArray(a?.files) && a.files.length ? a.files : null;
    } catch {
      toneNames = null; // not fatal: the tone row stays a plain text field
    }
    if (toneNames && form) form.refresh(settingsMeta);
    try {
      const p = await api.get('/api/pool/dialogs', { signal: ctx.signal });
      pool = Array.isArray(p?.messages) ? p.messages : [];
      paintPool();
    } catch {
      pool = [];
      paintPool();
    }
  }

  let toneNames = null; // /api/dialogs/audio/list files, or null when unavailable
  let form = null;
  function mountForm(meta) {
    if (form) {
      form.refresh(meta);
      return;
    }
    clear(settingsSlot);
    form = renderSettingsForm(settingsSlot, {
      settings: meta,
      title: 'Look',
      // `tone` is a string but its legal values are the clips on disk, not free text.
      choices: (key) => (key === 'tone' && toneNames && toneNames.length ? toneNames : null),
      help: (key) => (key === 'tone' && !toneNames ? 'No sound directory readable — see --sounds.' : undefined),
      signal: ctx.signal,
      onSave: async (patch) => {
        const out = await api.patch('/api/dialogs/settings', patch);
        if (out && out.settings) {
          settingsMeta = out.settings;
          ctx.settings = { ...out.settings };
        }
        paintPreview();
        return out;
      },
    });
    // theme and scale have quick controls above: a schema row for them would PATCH the same
    // key from a second place and leave two controls disagreeing.
    form?.omitRows?.((key) => PANE_OWNED_KEYS.has(key));
    form?.renameGroup?.('general', 'Look');
    form?.omitGroupRow?.('general');
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
    if (frame.channel !== 'dialogs') return;
    const d = frame.data || {};
    if (frame.event === 'sound') {
      streamOut.dataset.sound = String(Date.now());
      return;
    }
    if (d.rev !== undefined || d.live || d.count !== undefined) applyLive(d);
    if (d.settings) {
      settingsMeta = d.settings;
      form?.refresh?.(d.settings);
      paintQuick();
      paintPreview();
    }
  }

  unsubs.push(events.subscribe(null, onFrame));

  const poll = setInterval(() => {
    if (document.hidden || ctx.signal.aborted) return;
    api.get('/api/dialogs/live', { signal: ctx.signal }).then((d) => {
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
