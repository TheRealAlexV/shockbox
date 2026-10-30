// Shared building blocks for the two live-entity panes (Notifications, Alerts):
// a "now showing" live list, a spark/storm control block, and a messages pointer.
//
// The panes themselves own their module-specific bits; this file keeps the two from
// drifting apart without hiding either one's semantics behind a config blob.

import { el, clear, fmtWhen, fmtAgo, dot, actionButton, every } from './ui.js';
import { toast } from './toast.js';

/**
 * A list of currently live entities, keyed by id, reconciled in place so the DOM is not
 * rebuilt on every SSE frame (which would kill hover/selection).
 *
 * @param {object} o
 * @param {string} o.idKey
 * @param {(entity:object)=>Node} o.row       builds one row
 * @param {string} o.emptyText
 * @returns {{root:Node, update(live:Array):void, dispose():void}}
 */
export function liveStack({ idKey = 'id', row, emptyText = 'nothing on screen', header = null }) {
  const root = el('div', { class: 'live-stack' });
  const list = el('ol', { class: 'live-list' });
  const empty = el('div', { class: 'live-empty' }, el('span', { class: 'live-empty-mark', 'aria-hidden': 'true' }), el('span', { text: emptyText }));
  root.append(list, empty);
  const seen = new Map(); // id -> {node, born}
  let stopTick = null;

  function update(live, meta = {}) {
    const ids = new Set();
    for (const entity of live || []) {
      const id = String(entity[idKey]);
      ids.add(id);
      let entry = seen.get(id);
      if (!entry) {
        const node = el('li', { class: 'live-row', dataset: { id } });
        node.appendChild(row(entity));
        entry = { node, shown: 0 };
        seen.set(id, entry);
        list.appendChild(node);
        entry.shown = Date.now();
      } else {
        entry.node.replaceChildren(row(entity));
      }
      entry.entity = entity;
    }
    for (const [id, entry] of seen) {
      if (!ids.has(id)) {
        seen.delete(id);
        entry.node.classList.add('leaving');
        setTimeout(() => entry.node.remove(), 180);
      }
    }
    empty.hidden = ids.size > 0;
    if (meta.header) headerUpdate(meta.header);
    if (!stopTick) {
      stopTick = every(1000, () => {
        for (const rowEl of list.children) {
          const ago = rowEl.querySelector('[data-ago]');
          const id = rowEl.dataset.id;
          const entry = seen.get(id);
          if (ago && entry?.entity) ago.textContent = fmtAgo(entry.entity.born ?? entry.shown);
        }
      });
    }
  }

  let headerUpdate = () => {};

  return {
    root,
    update,
    setHeader(fn) {
      headerUpdate = fn;
    },
    dispose() {
      stopTick?.();
      stopTick = null;
    },
  };
}

/** The state header above a live list: used / capacity / rev, last spawn. */
export function stackHeader(slot) {
  return function header({ used, capacity, rev, lastSpawnAt, extra }) {
    clear(slot);
    slot.append(
      el('span', { class: 'stack-meter' },
        el('span', { class: 'stack-meter-fill', style: { width: `${capacity ? (used / capacity) * 100 : 0}%` } }),
      ),
      el('span', { class: 'stack-num mono', text: `${used}/${capacity}` }),
      el('span', { class: 'stack-sep', 'aria-hidden': 'true' }),
      el('span', { class: 'stack-rev mono dim', text: `rev ${rev}` }),
      extra ? el('span', { class: 'stack-extra mono dim', text: extra }) : '',
      lastSpawnAt ? el('span', { class: 'stack-when mono dim', text: `last ${fmtWhen(lastSpawnAt)}` }) : '',
    );
  };
}

/**
 * Storm control block: mode + count (+ interval for notifications) then a Fire button.
 * @param {object} o { modes:[{id,label}], counts:number[], interval:boolean, run({mode,count,interval}) }
 */
export function stormBlock(o) {
  let mode = o.modes[0].id;
  let count = o.defaultCount ?? 6;
  let interval = o.defaultInterval ?? 320;

  const root = el('div', { class: 'storm' });
  const modeWrap = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Storm mode' });
  for (const m of o.modes) {
    const b = el('button', { type: 'button', class: 'seg', text: m.label, title: m.title || '' });
    b.setAttribute('aria-checked', String(m.id === mode));
    b.addEventListener('click', () => {
      mode = m.id;
      for (const x of modeWrap.children) x.setAttribute('aria-checked', String(x === b));
    });
    modeWrap.appendChild(b);
  }

  const countWrap = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Storm count' });
  for (const n of o.counts) {
    const b = el('button', { type: 'button', class: 'seg mono', text: String(n) });
    b.setAttribute('aria-checked', String(n === count));
    b.addEventListener('click', () => {
      count = n;
      for (const x of countWrap.children) x.setAttribute('aria-checked', String(x === b));
    });
    countWrap.appendChild(b);
  }

  const intervalWrap = el('label', { class: 'storm-interval' });
  let intervalInput = null;
  if (o.interval) {
    intervalInput = el('input', { type: 'number', class: 'num num-sm', value: String(interval), min: '20', max: '10000', step: '10', 'aria-label': 'Interval between spawns (ms)' });
    intervalInput.addEventListener('change', () => {
      interval = Math.max(20, Math.min(10000, Number(intervalInput.value) || 320));
      intervalInput.value = String(interval);
    });
    intervalWrap.append(el('span', { class: 'storm-interval-label', text: 'every' }), intervalInput, el('span', { class: 'mono dim', text: 'ms' }));
  }

  const fire = actionButton({
    label: 'Storm',
    variant: 'btn-accent',
    title: o.fireTitle || 'Spawn a burst',
    run: () => o.run({ mode, count, interval }),
    onDone: (out) => {
      const n = out?.total ?? out?.spawned;
      toast(n !== undefined ? `storm: ${n} spawned` : 'storm started', 'ok');
    },
    onError: (err) => toast(`storm failed: ${err.message}`, 'error'),
  });

  root.append(modeWrap, countWrap, intervalWrap, fire);
  return root;
}

/** A one-line link block: this feature's messages live in the shared pool. */
export function poolLink({ kind, count, onOpen }) {
  const root = el('div', { class: 'pool-link' });
  root.append(
    el('span', { class: 'pool-link-label', text: 'Messages' }),
    el('span', { class: 'pool-link-text', text: kind === 'dialog' ? 'alert dialogs are edited in the shared pool' : 'toasts are edited in the shared pool' }),
    el('span', { class: 'pool-link-count mono', text: count === null || count === undefined ? '—' : String(count) }),
    el('a', { class: 'btn btn-quiet btn-sm', href: `#/messages?tab=${kind === 'dialog' ? 'dialogs' : 'notifications'}`, text: 'Open pool' }),
  );
  return root;
}

export function entityIcon(name) {
  const paths = {
    error: ['M8 4.2v4.6', 'M8 11.4v.2'],
    warning: ['M8 4.4v4.2', 'M8 11.2v.2'],
    info: ['M8 7.2v4.2', 'M8 4.6v.2'],
    question: ['M6.4 6.4a1.6 1.6 0 1 1 2.3 1.5c-.5.3-.7.6-.7 1.2', 'M8 11.2v.2'],
    none: [],
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths[name] || []) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('fill', 'none');
    svg.appendChild(p);
  }
  return svg;
}
