// Notifications control pane.
//
// The module draws toasts on a 405×720 phone strip inside OBS. This pane is the operator's
// desk next to it: a scaled, live preview of the strip, the stack controls, a pool send,
// and the look straight from the module's settings schema.
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
// The preview is a still of the module's own CSS: the same look class (t-ios … t-macos), the
// same lead/title/text/acts structure, at the strip's own px sizes inside a scaled wrapper —
// so what the operator tunes is what OBS draws, not an approximation of it.

import { el, clear, dot, actionButton, fmtAgo, every } from '/src/ui.js';
import { toast } from '/src/toast.js';
import { renderSettingsForm } from '/src/settings-form.js';

/* The canvas the module lays out in (modules/notifications/state.mjs CANVAS_W/H). */
const CANVAS_W = 405;
const CANVAS_H = 720;
const MAX_STACK = 7; // the module's capacity; the preview's own ruler is drawn to it

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
  let seqRev = -1;
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

  /* --- pool picker: send one exact message ------------------------------- */

  const poolSelect = el('select', { class: 'input nt-select', 'aria-label': 'Message' });
  const poolSendBtn = actionButton({
    label: 'Send',
    run: () => {
      const id = poolSelect.value;
      if (!id) throw new Error('pick a message first');
      return api.post('/api/notifications/live', { poolId: id });
    },
    onDone: () => toast('message sent', 'ok'),
    onError: (err) => toast(`send failed: ${err.message}`, 'error'),
  });
  const poolPanel = el('section', { class: 'panel nt-send' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Send a message' }),
      el('span', { class: 'panel-hint mono dim', text: 'from the notifications pool' }),
    ),
    el('div', { class: 'nt-send-body' }, poolSelect, poolSendBtn),
  );

  function paintPool() {
    const current = poolSelect.value;
    clear(poolSelect);
    poolSelect.appendChild(el('option', { value: '', text: pool.length ? 'Pick a message…' : 'pool is empty' }));
    for (const m of pool) {
      const label = m.title ? `${m.title} — ${m.text}` : m.text;
      poolSelect.appendChild(el('option', { value: m.id, text: label.length > 90 ? `${label.slice(0, 89)}…` : label }));
    }
    // keep the operator's pick across a refresh when the message still exists
    if (current && pool.some((m) => m.id === current)) poolSelect.value = current;
    poolSendBtn.disabled = !pool.length;
  }

  /* --- preview: the phone strip ------------------------------------------ */

  const stackOut = el('span', { class: 'nt-stack-count mono', text: '0 / 0' });
  const stage = el('div', { class: 'nt-stage' });
  const strip = el('div', { class: 'nt-strip' }); // the 405×720 canvas, scaled by CSS
  const ruler = el('div', { class: 'nt-ruler', 'aria-hidden': 'true' });
  const emptyNote = el('div', { class: 'nt-empty' },
    el('span', { class: 'nt-empty-mark' }),
    el('span', { text: 'no toasts on the strip' }),
  );
  strip.append(ruler, emptyNote);
  stage.append(strip);

  const previewMode = el('span', { class: 'nt-mode' });
  const previewPanel = el('section', { class: 'panel nt-preview' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Phone strip' }),
      stackOut,
      previewMode,
      el('span', { class: 'panel-hint mono dim', text: '405 × 720 · live' }),
    ),
    stage,
  );

  // ruler: one tick per stack slot, so "used / capacity" has a shape, not just a number
  for (let i = 0; i < MAX_STACK; i++) ruler.appendChild(el('span', { class: 'nt-ruler-tick', dataset: { i } }));

  function lookClass(style) {
    const key = String(style || 'ios').toLowerCase();
    return `t-${LOOKS[key] ? key : 'ios'}`;
  }

  /** One preview toast: the same nodes the overlay builds. */
  function previewToast(entity) {
    const node = el('div', { class: `toast in ${lookClass(entity.style || settingsMeta.style?.value)}`, dataset: { id: entity.id } });
    node.append(
      el('div', { class: 'lead', 'aria-hidden': 'true' },
        el('svg', { class: 'glyph', viewBox: '0 0 16 16' }, glyphPath(entity.type))),
      el('div', { class: 'body' },
        entity.title ? el('div', { class: 'title', text: entity.title }) : null,
        el('div', { class: 'text', text: entity.text || '' }),
      ),
      entity.buttons && entity.buttons.length
        ? el('div', { class: 'acts' }, ...entity.buttons.map((b) => el('button', { type: 'button', class: 'btn', tabindex: '-1', text: b.label })))
        : null,
    );
    // The overlay positions rows in canvas px; the preview does the same, in the scaled canvas.
    const y = Number(entity.y);
    const h = Number(entity.h);
    if (Number.isFinite(y)) node.style.top = `${y}px`;
    if (Number.isFinite(h)) node.style.height = `${h}px`;
    return node;
  }

  function glyphPath(type) {
    const ns = 'http://www.w3.org/2000/svg';
    const p = document.createElementNS(ns, 'path');
    // The overlay's own four glyphs, simplified to one path each.
    const d = {
      Error: 'M8 1.6 1.2 13.4h13.6zM7.2 5.6h1.6v4H7.2zM7.2 10.8h1.6v1.4H7.2z',
      Warning: 'M8 1.6 1.2 13.4h13.6zM7.2 5.6h1.6v4H7.2zM7.2 10.8h1.6v1.4H7.2z',
      Question: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zm-.1 9.6h1.5v1.4H7.9zm1.5-2.1c0-1 .9-1.4.9-2.4 0-.9-.7-1.4-1.5-1.4-.7 0-1.3.4-1.5 1l1.2.5c.1-.3.4-.5.7-.5.3 0 .5.2.5.5 0 .6-.9 1-.9 2.3z',
      Info: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zM7.2 6h1.6v6.2H7.2zm0-2.2h1.6v1.4H7.2z',
      System: 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zM7.2 6h1.6v6.2H7.2zm0-2.2h1.6v1.4H7.2z',
    }[type] || 'M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6zM7.2 6h1.6v6.2H7.2zm0-2.2h1.6v1.4H7.2z';
    p.setAttribute('d', d);
    return p;
  }

  function paintPreview() {
    const styleKey = String(settingsMeta.style?.value || 'ios');
    const height = Number(settingsMeta.height?.value) || 76;
    // One class on the strip repaints every toast's look; the module also does this per row.
    strip.className = `nt-strip ${lookClass(styleKey)}`;
    strip.style.setProperty('--nt-h', `${height}px`);
    strip.dataset.style = styleKey;
    previewMode.textContent = LOOKS[styleKey] || styleKey;
    previewMode.dataset.look = styleKey;
    // the ruler is the server's capacity, not a guess
    const capacity = Math.max(1, Number(stack?.capacity) || MAX_STACK);
    for (const tick of ruler.children) {
      const on = Number(tick.dataset.i) < capacity;
      tick.hidden = !on;
    }
    const rev = seqRev;
    const shown = [...live].sort((a, b) => (a.born || 0) - (b.born || 0));
    for (const node of [...strip.querySelectorAll('.toast')]) node.remove();
    emptyNote.hidden = shown.length > 0;
    for (const entity of shown) strip.appendChild(previewToast(entity));
    // mark which row is newest, so a spawn is visible even before its slide settles
    const newest = shown[shown.length - 1];
    if (newest) strip.querySelector(`.toast[data-id="${cssId(newest.id)}"]`)?.setAttribute('data-newest', 'true');
    stackOut.textContent = `${stack?.used ?? shown.length} / ${capacity}`;
    stackOut.dataset.state = (stack?.used ?? shown.length) >= capacity ? 'full' : 'ok';
    strip.dataset.rev = String(rev);
  }

  function cssId(id) {
    return String(id).replace(/["\\]/g, '\\$&');
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
      row.addEventListener('click', () => {
        // Clicking a row spawns nothing; it just points the preview at that toast.
        const node = strip.querySelector(`.toast[data-id="${cssId(entity.id)}"]`);
        node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        node?.animate?.([{ outline: '1px solid rgba(177,140,255,0.9)' }, { outline: '1px solid rgba(177,140,255,0)' }], { duration: 900 });
      });
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
      poolPanel,
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

  clear(container);
  container.append(header, controlBar, body);

  /* ---------------------------------------------------------------- data */

  function applyLive(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.live)) live = data.live;
    if (data.stack) stack = data.stack;
    if (data.settings) settingsMeta = data.settings;
    if (Number.isFinite(Number(data.rev))) seqRev = Number(data.rev);
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
    // The style and height rows are drawn above (the preview's own mode line and the strip's
    // height); leaving them in the form would PATCH the same keys from a second place.
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
    strip.style.setProperty('--nt-h', `${heightRange.value}px`);
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
