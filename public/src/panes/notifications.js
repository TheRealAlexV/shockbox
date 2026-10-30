// Notifications pane: the live toast stack on the phone strip, spawn / storm / clear,
// and the module's settings form.
//
// Data:   GET  /api/notifications/live        {rev, live:[entity], stack:{height,used,capacity}, lastSpawnAt}
//         POST /api/notifications/live        {} or {poolId}
//         POST /api/notifications/live/storm  {mode:'fill'|'random', count, interval}
//         DELETE /api/notifications/live
//         PATCH /api/notifications/settings    {key:value}
// Live:   SSE channel `notifications`, cmd `snapshot` {rev, live, stack, lastSpawnAt}
//         cmd `relayout` (settings changed) and `sound` frames are informational here.

import { el, clear, fmtWhen, fmtAgo, dot, actionButton } from '../ui.js';
import { toast } from '../toast.js';
import { liveStack, stackHeader, stormBlock } from '../live.js';

export async function render(container, ctx) {
  const { api, events, settings } = ctx;
  const unsubs = [];
  let stackMeta = null;

  /* ------------------------------------------------------------ structure */

  const header = el('div', { class: 'pane-head' });
  const titleWrap = el('div', { class: 'pane-title-wrap' },
    el('h1', { class: 'pane-title', text: 'Live toasts' }),
    el('p', { class: 'pane-desc', text: ctx.module.description || '' }),
  );
  const headerStatus = el('div', { class: 'pane-head-status' });
  header.append(titleWrap, headerStatus);

  const controls = el('div', { class: 'control-bar' });
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
  const poolBtn = el('a', { class: 'btn btn-quiet', href: '#/messages?tab=notifications', text: 'Edit messages' });

  const storm = stormBlock({
    modes: [
      { id: 'fill', label: 'Fill', title: 'One of every storm-eligible message' },
      { id: 'random', label: 'Random', title: 'Random picks, `count` of them' },
    ],
    counts: [3, 6, 9, 12],
    defaultCount: 6,
    interval: true,
    defaultInterval: 320,
    run: async ({ mode, count, interval }) => {
      const out = await api.post('/api/notifications/live/storm', { mode, count, interval });
      await pull();
      return out;
    },
  });

  controls.append(spawnBtn, clearBtn, el('span', { class: 'control-sep' }), storm, el('span', { class: 'control-spacer' }), poolBtn);

  const stackBar = el('div', { class: 'stack-bar' });
  const stackHeaderEl = el('div', { class: 'stack-meta' });
  const setHeader = stackHeader(stackHeaderEl);

  const stack = liveStack({
    emptyText: 'Stack empty — spawn a toast to see it on the strip',
    row: (n) => {
      const typeClass = String(n.type || 'info').toLowerCase();
      const wrap = el('div', { class: `live-card tone-${typeClass}`, dataset: { origin: n.origin || 'server' } });
      const main = el('div', { class: 'live-card-main' });
      const top = el('div', { class: 'live-card-top' },
        el('span', { class: 'live-type', text: n.type || 'Info' }),
        el('span', { class: 'live-id mono dim', text: n.id }),
        el('span', { class: 'live-geo mono dim', text: `y ${n.y} · h ${n.h}` }),
        n.origin ? el('span', { class: 'live-origin mono', text: n.origin }) : '',
        el('span', { class: 'live-ago mono', dataset: { ago: '1' }, text: fmtAgo(n.born) }),
      );
      const text = el('div', { class: 'live-text', text: n.text || '' });
      main.append(top, text);
      if (n.title) main.prepend(el('div', { class: 'live-title', text: n.title }));
      const side = el('div', { class: 'live-card-side' });
      side.append(
        el('span', { class: 'live-when mono dim', text: fmtWhen(n.born) }),
        n.autoCloseMs ? el('span', { class: 'live-auto mono dim', text: n.autoCloseMs === 0 ? 'never closes' : `auto ${Math.round(n.autoCloseMs / 1000)}s` }) : '',
      );
      if (Array.isArray(n.buttons) && n.buttons.length) {
        side.append(el('span', { class: 'live-buttons dim', text: n.buttons.map((b) => b.label || b.action).join(' · ') }));
      }
      wrap.append(main, side);
      return wrap;
    },
  });

  const settingsSlot = el('div', { class: 'pane-settings' });

  clear(container);
  container.append(
    header,
    controls,
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('span', { class: 'panel-title', text: 'On screen' }),
        stackMeta = el('span', { class: 'panel-extra' }),
      ),
      stackHeaderEl,
      stack.root,
    ),
    settingsSlot,
  );

  /* ---------------------------------------------------------------- data */

  function apply(snap, origin) {
    if (!snap) return;
    const live = Array.isArray(snap.live) ? snap.live : [];
    const s = snap.stack || {};
    setHeader({ used: s.used ?? live.length, capacity: s.capacity ?? 12, rev: snap.rev, lastSpawnAt: snap.lastSpawnAt });
    stack.update(live);
    clear(headerStatus);
    headerStatus.append(
      dot(live.length ? 'ok' : 'idle'),
      el('span', { class: 'chip-label', text: live.length ? `${live.length} live` : 'idle' }),
      origin ? el('span', { class: 'mono dim', text: origin }) : '',
    );
  }

  async function pull() {
    try {
      const snap = await api.get('/api/notifications/live');
      apply(snap, 'http');
    } catch (err) {
      toast(`notifications state failed: ${err.message}`, 'error');
      clear(stack.root);
      stack.root.append(el('div', { class: 'live-error', text: `could not read live state: ${err.message}` }));
    }
  }

  // settings form is rendered from the metadata the shell passed (same as /api/notifications/live.settings)
  const { renderSettingsForm } = await import('../settings-form.js');
  const form = renderSettingsForm(settingsSlot, {
    settings,
    title: 'Notification look',
    onSave: async (patch) => {
      const out = await api.patch('/api/notifications/settings', patch);
      if (out?.settings) ctx.settings = { ...out.settings };
      return out;
    },
  });

  /* --------------------------------------------------------------- live */

  unsubs.push(
    events.subscribe('notifications', (frame) => {
      if (frame.reset) {
        pull();
        return;
      }
      if (frame.event === 'sound' || frame.hello) return;
      const args = frame.cmd === 'snapshot' || frame.cmd === 'relayout' ? frame.args : frame.event ? frame.data : null;
      if (args && Array.isArray(args.live)) apply(args, frame.cmd || frame.event || 'live');
      else if (frame.cmd && frame.cmd !== 'sound') pull();
    }),
  );

  // pool edits can change what spawn picks; the count is shown on Messages, not here
  await pull();

  return () => {
    for (const u of unsubs) u?.();
    stack.dispose();
  };
}
