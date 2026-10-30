// Alerts pane: the live dialog stack on the phone strip, spawn / storm / clear, theme + scale,
// and the module's full settings form.
//
// Data:   GET  /api/dialogs/live             {rev, live:[entity], count, capacity, settings}
//         POST /api/dialogs/live             {} or {poolId}
//         POST /api/dialogs/live/storm       {count}
//         DELETE /api/dialogs/live[?id=]
//         PATCH /api/dialogs/settings        {key:value}
// Live:   SSE channel `dialogs`, cmd `snapshot` {rev, live, count, capacity}
//         cmd `relayout` after a settings change, `sound` frames informational.

import { el, clear, fmtWhen, fmtAgo, dot, actionButton } from '../ui.js';
import { toast } from '../toast.js';
import { liveStack, stackHeader, stormBlock, entityIcon } from '../live.js';
import { renderSettingsForm } from '../settings-form.js';

const THEMES = [
  { id: 'win95', label: '95' },
  { id: 'win11', label: '11' },
  { id: 'macos', label: 'macOS' },
];
const SCALES = [0.5, 0.6, 0.7, 0.85, 1.0, 1.2];

export async function render(container, ctx) {
  const { api, events } = ctx;
  const unsubs = [];
  let settingsMap = { ...(ctx.settings || {}) };
  let capacity = 80;

  const header = el('div', { class: 'pane-head' });
  const headerStatus = el('div', { class: 'pane-head-status' });
  header.append(
    el('div', { class: 'pane-title-wrap' },
      el('h1', { class: 'pane-title', text: 'Live alerts' }),
      el('p', { class: 'pane-desc', text: ctx.module.description || '' }),
    ),
    headerStatus,
  );

  /* ------------------------------------------------- look: theme + scale */

  const look = el('div', { class: 'look-bar' });
  const themeSeg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Window theme' });
  const scaleSeg = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Layer scale' });
  let lookBusy = false;

  async function patchLook(patch, from) {
    if (lookBusy) return;
    lookBusy = true;
    look.dataset.busy = 'true';
    try {
      const out = await api.patch('/api/dialogs/settings', patch);
      if (out?.settings) {
        settingsMap = { ...out.settings };
        ctx.settings = settingsMap;
        paintLook();
        form?.refresh(settingsMap);
      }
    } catch (err) {
      toast(`look change failed: ${err.message}`, 'error');
      paintLook(); // snap back to the last value we know the server accepted
      from?.setAttribute('data-fail', 'true');
      setTimeout(() => from?.removeAttribute('data-fail'), 1200);
    } finally {
      lookBusy = false;
      delete look.dataset.busy;
    }
  }

  function paintLook() {
    const theme = settingsMap.theme?.value;
    const scale = Number(settingsMap.scale?.value ?? 0.7);
    for (const b of themeSeg.children) b.setAttribute('aria-checked', String(b.dataset.value === theme));
    for (const b of scaleSeg.children) b.setAttribute('aria-checked', String(Math.abs(Number(b.dataset.value) - scale) < 1e-6));
    themeSeg.dataset.value = String(theme ?? '');
    scaleSeg.dataset.value = String(scale);
  }

  for (const t of THEMES) {
    const b = el('button', { type: 'button', class: 'seg', text: t.label, dataset: { value: t.id } });
    b.addEventListener('click', () => patchLook({ theme: t.id }, b));
    themeSeg.appendChild(b);
  }
  for (const s of SCALES) {
    const b = el('button', { type: 'button', class: 'seg mono', text: s.toFixed(2), dataset: { value: String(s) } });
    b.addEventListener('click', () => patchLook({ scale: s }, b));
    scaleSeg.appendChild(b);
  }
  look.append(
    el('span', { class: 'look-label', text: 'Theme' }),
    themeSeg,
    el('span', { class: 'look-sep', 'aria-hidden': 'true' }),
    el('span', { class: 'look-label', text: 'Scale' }),
    scaleSeg,
  );

  /* ----------------------------------------------------------- controls */

  const controls = el('div', { class: 'control-bar' });
  const spawnBtn = actionButton({
    label: 'Spawn alert',
    variant: 'btn-primary',
    run: () => api.post('/api/dialogs/live', {}),
    onDone: () => toast('alert spawned', 'ok'),
    onError: (err) => toast(`spawn failed: ${err.message}`, 'error'),
  });
  const storm = stormBlock({
    modes: [{ id: 'count', label: 'Count' }],
    counts: [3, 6, 12, 24],
    defaultCount: 6,
    run: async ({ count }) => {
      const out = await api.post('/api/dialogs/live/storm', { count });
      await pull();
      return out;
    },
    fireTitle: 'Spawn a burst of alerts',
  });
  // single-mode storm: hide the mode radio group (it has one option)
  storm.querySelector('.segmented')?.setAttribute('data-single', 'true');
  const clearBtn = actionButton({
    label: 'Clear all',
    variant: 'btn-danger',
    confirm: 'Confirm clear',
    run: () => api.del('/api/dialogs/live'),
    onDone: (out) => toast(`cleared ${out?.closed ?? 0}`, 'ok'),
    onError: (err) => toast(`clear failed: ${err.message}`, 'error'),
  });
  controls.append(
    spawnBtn,
    clearBtn,
    el('span', { class: 'control-sep' }),
    storm,
    el('span', { class: 'control-spacer' }),
    el('a', { class: 'btn btn-quiet', href: '#/messages?tab=dialogs', text: 'Edit messages' }),
  );

  /* -------------------------------------------------------------- stack */

  const metaEl = el('div', { class: 'stack-meta' });
  const setMetaHeader = stackHeader(metaEl);

  const stack = liveStack({
    emptyText: 'No alerts open — spawn one to cascade it over the strip',
    row: (d) => {
      const wrap = el('div', { class: 'live-card live-card-dialog', dataset: { origin: d.origin || 'server' } });
      const iconEl = el('span', { class: `live-icon tone-${String(d.type || 'error').toLowerCase()}` });
      iconEl.appendChild(entityIcon(d.icon || 'error'));
      const main = el('div', { class: 'live-card-main' });
      main.append(
        el('div', { class: 'live-card-top' },
          el('span', { class: 'live-type', text: d.type || 'Error' }),
          el('span', { class: 'live-id mono dim', text: d.id }),
          el('span', { class: 'live-geo mono dim', text: `${d.w}×${d.h} @ ${d.x},${d.y}` }),
          d.origin ? el('span', { class: 'live-origin mono', text: d.origin }) : '',
          el('span', { class: 'live-ago mono', dataset: { ago: '1' }, text: fmtAgo(d.born) }),
        ),
        d.title ? el('div', { class: 'live-title', text: d.title }) : '',
        el('div', { class: 'live-text', text: d.text || '' }),
      );
      const side = el('div', { class: 'live-card-side' });
      const btns = Array.isArray(d.buttons) ? d.buttons : [];
      if (btns.length) {
        const row = el('span', { class: 'live-buttons' });
        for (const b of btns) row.appendChild(el('span', { class: 'live-btn-chip', text: b.label || b.action || '?' }));
        side.append(row);
      }
      side.append(el('span', { class: 'live-when mono dim', text: fmtWhen(d.born) }));
      wrap.title = 'Click to close this alert';
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'button');
      const close = async () => {
        wrap.dataset.closing = 'true';
        try {
          await api.del(`/api/dialogs/live?id=${encodeURIComponent(d.id)}`);
        } catch (err) {
          delete wrap.dataset.closing;
          toast(`close failed: ${err.message}`, 'error');
        }
      };
      wrap.addEventListener('click', close);
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          close();
        }
      });
      wrap.append(iconEl, main, side);
      return wrap;
    },
  });
  // the stack's internal header hook expects a single header slot; use the module-level one
  stack.setHeader((m) => setMetaHeader(m));

  const settingsSlot = el('div', { class: 'pane-settings' });

  clear(container);
  container.append(
    header,
    look,
    controls,
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title', text: 'On screen' }),
        el('span', { class: 'panel-hint dim', text: 'click a row to close it' }),
      ),
      metaEl,
      stack.root,
    ),
    settingsSlot,
  );

  /* --------------------------------------------------------------- data */

  function apply(snap, origin) {
    if (!snap) return;
    const live = Array.isArray(snap.live) ? snap.live : [];
    if (snap.capacity) capacity = snap.capacity;
    setMetaHeader({ used: snap.count ?? live.length, capacity, rev: snap.rev });
    if (snap.settings && typeof snap.settings === 'object' && !Array.isArray(snap.settings)) {
      // GET /live also carries settings; adopt them only if the pane has none yet
      if (!settingsMap.theme) {
        settingsMap = { ...snap.settings };
        ctx.settings = settingsMap;
        paintLook();
        form?.refresh(settingsMap);
      }
    }
    stack.update(live);
    clear(headerStatus);
    headerStatus.append(
      dot(live.length ? 'ok' : 'idle'),
      el('span', { class: 'chip-label', text: live.length ? `${live.length} open` : 'idle' }),
      origin ? el('span', { class: 'mono dim', text: origin }) : '',
    );
  }

  let form = null;
  async function pull() {
    try {
      const snap = await api.get('/api/dialogs/live');
      apply(snap, 'http');
    } catch (err) {
      clear(stack.root);
      stack.root.append(el('div', { class: 'live-error', text: `could not read live state: ${err.message}` }));
      toast(`alerts state failed: ${err.message}`, 'error');
    }
  }

  paintLook();
  form = renderSettingsForm(settingsSlot, {
    settings: settingsMap,
    title: 'Alert settings',
    onSave: async (patch) => {
      const out = await api.patch('/api/dialogs/settings', patch);
      if (out?.settings) {
        settingsMap = { ...out.settings };
        ctx.settings = settingsMap;
        paintLook();
      }
      return out;
    },
  });

  unsubs.push(
    events.subscribe('dialogs', (frame) => {
      if (frame.reset) {
        pull();
        return;
      }
      if (frame.hello || frame.event === 'sound') return;
      const args = frame.cmd === 'snapshot' || frame.cmd === 'relayout' ? frame.args : frame.event ? frame.data : null;
      if (args && Array.isArray(args.live)) apply(args, frame.cmd || frame.event || 'live');
      else if (args && args.count !== undefined && !args.live) apply({ ...args, live: null }, 'meta');
    }),
  );

  await pull();

  return () => {
    for (const u of unsubs) u?.();
    stack.dispose();
  };
}
