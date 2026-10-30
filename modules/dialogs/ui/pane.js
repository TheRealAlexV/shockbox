// Alerts (dialogs) control pane.
//
// The module draws fake OS error dialogs that cascade over a 405×720 phone strip inside OBS.
// This pane is the operator's desk next to it: a scaled, live preview of the strip with the
// real cascade positions, the spawn controls, a pool send, and the look from the schema.
//
// Data:
//   GET    /api/dialogs/live        {rev, live:[entity], count, capacity, settings}
//   POST   /api/dialogs/live        {} (random from the pool) | {poolId} | {any:true} | {spec}
//   POST   /api/dialogs/live/storm  {mode:'fill'|'random', count, interval}
//   DELETE /api/dialogs/live        close every dialog
//   PATCH  /api/dialogs/settings    {key:value} → persists + pushes `relayout`
//   GET    /api/pool/dialogs        message list for the picker
// Live:
//   channel `dialogs`, cmd `snapshot` | `relayout`; event `sound` is informational.
//
// The preview is the module's own look: the same skin class (skin-win11 / skin-win95 /
// skin-macos) on the stage, the same .dialog/.titlebar/.ttitle/.body/.icon/.msg/.buttons
// structure, drawn at the entity's x/y/w/h from the server. Only the scale is applied in CSS.

import { el, clear, dot, actionButton, fmtAgo, every } from '/src/ui.js';
import { toast } from '/src/toast.js';
import { renderSettingsForm } from '/src/settings-form.js';

const CANVAS_W = 405;
const CANVAS_H = 720;

const THEMES = { win11: 'Windows 11', win95: 'Windows 95', macos: 'macOS' };

const TYPE_ICON = { Error: 'error', Alert: 'warning', Warning: 'warning', System: 'info', Question: 'question' };
const ICON_TONE = { error: 'bad', warning: 'warn', info: 'info', question: 'accent', none: 'idle' };

/* The schema rows this pane draws with its own controls (the preview's mode line, the scale). */
const PANE_OWNED_KEYS = new Set(['theme', 'scale']);

export async function render(container, ctx) {
  const { api, events } = ctx;
  const unsubs = [];
  const timers = [];

  /* ------------------------------------------------------------ state */

  let live = [];
  let capacity = 80;
  let settingsMeta = ctx.settings || {};
  let seqRev = -1;
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
    run: () => api.post('/api/dialogs/live', {}),
    onDone: () => toast('alert spawned', 'ok'),
    onError: (err) => toast(`spawn failed: ${err.message}`, 'error'),
  });
  const clearBtn = actionButton({
    label: 'Close all',
    variant: 'btn-danger',
    title: 'Close every live alert',
    confirm: 'Confirm close',
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
    run: () => api.post('/api/dialogs/live/storm', { mode: stormModeId, count: stormCount, interval: stormInterval }),
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
      return api.post('/api/dialogs/live', { poolId: id });
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

  /* --- preview: the phone strip ------------------------------------------ */

  const countOut = el('span', { class: 'dg-count mono', text: '0' });
  const stage = el('div', { class: 'dg-stage' });
  const desk = el('div', { class: 'dg-desk skin-win11' }); // the 405×720 canvas, scaled by CSS
  const emptyNote = el('div', { class: 'dg-empty' },
    el('span', { class: 'dg-empty-mark' }),
    el('span', { text: 'no alerts on the strip' }),
  );
  desk.append(emptyNote);
  stage.append(desk);

  const previewMode = el('span', { class: 'dg-mode' });
  const previewPanel = el('section', { class: 'panel dg-preview' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Phone strip' }),
      countOut,
      previewMode,
      el('span', { class: 'panel-hint mono dim', text: '405 × 720 · live cascade' }),
    ),
    stage,
  );

  /** One preview dialog: the overlay's own structure, placed at the entity's canvas box. */
  function previewDialog(entity) {
    const node = el('div', { class: 'dialog in', dataset: { id: entity.id } });
    // The overlay applies the theme per dialog; the preview's stage carries the skin, but an
    // entity spawned under a different theme keeps its own, so stamp it from the entity.
    const theme = THEMES[entity.theme] ? entity.theme : 'win11';
    node.dataset.theme = theme;
    const titlebar = el('div', { class: 'titlebar' },
      el('span', { class: 'ttitle', text: entity.title || (entity.type || 'Alert') }),
      el('button', { type: 'button', class: 'tclose', tabindex: '-1', 'aria-hidden': 'true' }),
    );
    const iconName = ICON_TONE[entity.icon] ? entity.icon : TYPE_ICON[entity.type] || 'error';
    const body = el('div', { class: 'body' },
      el('span', { class: 'icon', 'data-icon': iconName, 'aria-hidden': 'true' }, iconSvg(iconName, theme)),
      el('div', { class: 'msg', text: entity.text || '' }),
    );
    node.append(titlebar, body);
    if (Array.isArray(entity.buttons) && entity.buttons.length) {
      node.append(el('div', { class: 'buttons' }, ...entity.buttons.map((b, i) => {
        const btn = el('button', { type: 'button', class: i === 0 || b.action === 'close' ? 'btn primary' : 'btn', tabindex: '-1', text: b.label });
        return btn;
      })));
    }
    // Position in canvas px; the stage's scale is the only fitting applied.
    const x = Number(entity.x);
    const y = Number(entity.y);
    const w = Number(entity.w);
    const h = Number(entity.h);
    if (Number.isFinite(x)) node.style.left = `${x}px`;
    if (Number.isFinite(y)) node.style.top = `${y}px`;
    if (Number.isFinite(w)) node.style.width = `${w}px`;
    if (Number.isFinite(h)) node.style.height = `${h}px`;
    node.dataset.geo = `${Math.round(x) || 0},${Math.round(y) || 0} ${Math.round(w) || 0}×${Math.round(h) || 0}`;
    return node;
  }

  function iconSvg(name, theme) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-theme', theme);
    const add = (d, fill) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', fill);
      svg.appendChild(p);
    };
    // The overlay's own icon set, kept in one path each: a win11 ringed badge, a win95 flat
    // glyph, and the macOS rounded square — the theme decides which one reads as "this OS".
    const SHAPES = {
      error: 'M16 3 3 28h26z',
      warning: 'M16 3 3 28h26z',
      question: 'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26z',
      info: 'M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26z',
      none: '',
    };
    const MARKS = {
      error: 'M14 9h4v11h-4zM14 22h4v3h-4z',
      warning: 'M14 9h4v11h-4zM14 22h4v3h-4z',
      question: 'M13.4 21.4v-1.2c0-2.1 3.3-2.4 3.3-4.6 0-1.4-1-2.3-2.4-2.3-1.2 0-2 .6-2.5 1.5l-2.6-1.4c.9-1.7 2.8-2.9 5.2-2.9 3.1 0 5.3 1.8 5.3 4.6 0 3.2-3.6 3.8-3.6 5.2v1.1zm.2 4.4h3v3.2h-3z',
      info: 'M14 9h4v3h-4zM14 14h4v10h-4z',
      none: '',
    };
    const shape = SHAPES[name] || SHAPES.error;
    const mark = MARKS[name] || MARKS.error;
    // 95: flat yellow/blue on no ring; mac: rounded blue square; win11: white badge on a colour
    if (theme === 'win95' || theme === 'macos') {
      add(shape, theme === 'win95' ? '#ffffe1' : name === 'error' ? '#ff5d6a' : name === 'question' ? '#6fb3ff' : '#f2c14e');
      add(mark, theme === 'win95' ? '#000' : '#fff');
    } else {
      add('M16 2a14 14 0 1 0 0 28 14 14 0 0 0 0-28z', name === 'error' ? '#ff5d6a' : name === 'question' ? '#6fb3ff' : '#f2c14e');
      add(mark, '#1a1a1a');
    }
    return svg;
  }

  function paintPreview() {
    const themeKey = THEMES[settingsMeta.theme?.value] ? settingsMeta.theme.value : 'win11';
    const scale = Number(settingsMeta.scale?.value) || 0.7;
    desk.className = `dg-desk skin-${themeKey}`;
    desk.dataset.theme = themeKey;
    desk.dataset.scale = String(scale);
    desk.style.setProperty('--dg-scale', String(scale));
    previewMode.textContent = THEMES[themeKey];
    previewMode.dataset.theme = themeKey;
    const rows = [...live].sort((a, b) => (a.born || 0) - (b.born || 0));
    for (const node of [...desk.querySelectorAll('.dialog')]) node.remove();
    emptyNote.hidden = rows.length > 0;
    for (const entity of rows) desk.appendChild(previewDialog(entity));
    // The newest one is the one the operator just triggered: mark it so a spawn is findable
    // inside a full cascade.
    const newest = rows[rows.length - 1];
    if (newest) desk.querySelector(`.dialog[data-id="${cssId(newest.id)}"]`)?.setAttribute('data-newest', 'true');
    countOut.textContent = `${rows.length}${capacity ? ` / ${capacity}` : ''}`;
    countOut.dataset.state = capacity && rows.length >= capacity ? 'full' : 'ok';
    desk.dataset.rev = String(seqRev);
  }

  function cssId(id) {
    return String(id).replace(/["\\]/g, '\\$&');
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
      row.addEventListener('click', () => {
        const node = desk.querySelector(`.dialog[data-id="${cssId(entity.id)}"]`);
        node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        node?.animate?.([{ outline: '2px solid rgba(177,140,255,0.9)' }, { outline: '2px solid rgba(177,140,255,0)' }], { duration: 900 });
      });
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
    desk.style.setProperty('--dg-scale', scaleRange.value);
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
  clear(container);
  container.append(header, controlBar, quick, body);

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
    if (Number.isFinite(Number(data.rev))) seqRev = Number(data.rev);
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
      const p = await api.get('/api/pool/dialogs', { signal: ctx.signal });
      pool = Array.isArray(p?.messages) ? p.messages : [];
      paintPool();
    } catch {
      pool = [];
      paintPool();
    }
  }

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
