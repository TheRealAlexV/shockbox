// Quick send — the top-of-page send box every messaging module shares.
//
// One box, four jobs: pick something from this module's pool (searchable, filterable by tag), type
// something new, send it, or book it for later. It exists so the wall, the dialogs and the
// notifications stop each growing their own half-implemented send strip, and so a message can be
// answered with the keyboard alone: type, Enter sends, Tab reaches the list.
//
// Ownership: this file renders and talks to `/api/schedules` and the module's own send route. The
// module passes `onSend`, `onSchedule` and `onSave`; it does not pass markup.

import { el, clear } from './ui.js';
import { toast } from './toast.js';

const MAX_TAGS = 16;

/** Local time for a <input type="datetime-local"> value. */
function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v) {
  if (!v) return NaN;
  return new Date(v).getTime();
}

function inMinutes(n) {
  return toLocalInput(Date.now() + n * 60_000);
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   title: string,
 *   kinds: string[],
 *   api: object,
 *   events?: object,
 *   poolId: string,
 *   placeholder?: string,
 *   who?: string,
 *   onSend: (payload) => Promise<any>,
 *   onSchedule: (payload) => Promise<any>,
 *   onSave?: (payload) => Promise<any>,
 *   allowEmpty?: boolean,
 *   allowRandom?: boolean,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {{ refresh: () => Promise<void>, get selected: () => object|null }}
 */
export function mountQuickSend(container, opts) {
  clear(container);
  let messages = [];
  let selected = null;
  let query = '';
  let activeTags = new Set();
  // The pool the list reads from. `all` is the virtual view over every record; a stored pool id
  // narrows it server-side, so the filter below never has to guess at a message's pool.
  let activePool = 'all';
  const NEW_POOL = '__new';

  const kinds = opts.kinds || ['wall'];
  // The pane's module owns the kind: kinds[0] is its own kind (`dialog`, `notification`, `wall`);
  // poolId is the fallback for older mounts that pass only a pool name.
  const paneKind = kinds[0] || String(opts.poolId || '').replace(/s$/, '') || 'dialog';
  const allowEmpty = opts.allowEmpty === true;
  const allowRandom = opts.allowRandom === true;

  /* ------------------------------------------------------------ pool list */

  const search = el('input', {
    type: 'search',
    class: 'qs-search',
    placeholder: 'Search messages…',
    autocomplete: 'off',
    'aria-label': `Search ${opts.title} messages`,
  });
  const tagBar = el('div', { class: 'qs-tags', role: 'group', 'aria-label': 'Filter by tag' });
  const list = el('div', { class: 'qs-list', role: 'listbox', 'aria-label': `${opts.title} messages` });
  const count = el('span', { class: 'panel-hint dim mono' });
  const poolSelect = el('select', {
    class: 'qs-search qs-pool-select',
    style: { flex: '0 1 auto', maxWidth: '48%' },
    'aria-label': `Pool to read ${opts.title} messages from`,
    title: 'Pool to read messages from',
  });

  /* ------------------------------------------------------------ composer */

  const titleInput = el('input', {
    type: 'text',
    class: 'qs-title',
    placeholder: 'Title (optional)',
    maxlength: '80',
    autocomplete: 'off',
  });
  const textArea = el('textarea', {
    class: 'qs-text',
    placeholder: opts.placeholder || 'Type a message…',
    rows: '3',
    maxlength: '4000',
    'aria-label': `${opts.title} message`,
  });
  const atInput = el('input', {
    type: 'datetime-local',
    class: 'qs-at',
    'aria-label': 'Send at',
    title: 'Leave empty to send now',
  });
  atInput.hidden = true;
  const keepBox = el('input', { type: 'checkbox' });
  const keepLabel = el('label', { class: 'qs-save', title: 'Also save this as a message in the pool' });
  keepLabel.append(keepBox, el('span', { text: 'save to pool' }));

  const sendBtn = el('button', { type: 'button', class: 'btn btn-primary qs-send', text: 'Send now' });
  const schedToggle = el('button', {
    type: 'button',
    class: 'btn btn-sm',
    text: 'Schedule',
    title: 'Book this message for a later time',
  });
  const hint = el('span', { class: 'qs-hint dim' });

  const body = el('div', { class: 'qs-body' });
  const box = el('section', { class: 'qs panel' });
  const head = el('div', { class: 'panel-head' },
    el('span', { class: 'panel-title', text: opts.title }),
    el('span', { class: 'panel-hint dim', text: 'pool + free text' }),
    count,
  );

  body.append(
    el('div', { class: 'qs-pool' },
      el('div', { class: 'qs-pool-head' }, search, poolSelect),
      tagBar,
      list,
    ),
    el('div', { class: 'qs-compose' },
      titleInput,
      textArea,
      el('div', { class: 'qs-row' }, keepLabel, hint),
      el('div', { class: 'qs-row qs-actions' }, atInput, schedToggle, sendBtn),
    ),
  );
  box.append(head, body);
  container.append(box);

  /* ------------------------------------------------------------ filtering */

  function allTags() {
    const t = new Map();
    for (const m of messages) {
      for (const tag of m.tags || []) t.set(tag, (t.get(tag) || 0) + 1);
    }
    return [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function paintTags() {
    clear(tagBar);
    const tags = allTags();
    if (!tags.length) return;
    // most-used first, because the useful filter is usually the common one, but cap the bar so a
    // richly tagged pool does not push the list off screen
    for (const [tag, n] of tags.slice(0, 22)) {
      const on = activeTags.has(tag);
      const b = el('button', {
        type: 'button',
        class: 'qs-tag',
        'aria-pressed': on ? 'true' : 'false',
        title: `${n} message${n === 1 ? '' : 's'}`,
        text: tag,
      });
      b.addEventListener('click', () => {
        if (activeTags.has(tag)) activeTags.delete(tag);
        else activeTags.add(tag);
        paintTags();
        paintList();
      });
      tagBar.append(b);
    }
    if (activeTags.size) {
      const clearBtn = el('button', { type: 'button', class: 'qs-tag qs-tag-clear', text: 'clear' });
      clearBtn.addEventListener('click', () => {
        activeTags.clear();
        paintTags();
        paintList();
      });
      tagBar.append(clearBtn);
    }
  }

  function matches(m) {
    if (activeTags.size) {
      const tags = new Set(m.tags || []);
      for (const t of activeTags) if (!tags.has(t)) return false;
    }
    if (!query) return true;
    const q = query.toLowerCase();
    return (m.text || '').toLowerCase().includes(q)
      || (m.title || '').toLowerCase().includes(q)
      || (m.tags || []).some((t) => t.includes(q));
  }

  function paintList() {
    clear(list);
    const shown = messages
      .filter(matches)
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.uses || 0) - (a.uses || 0));
    count.textContent = `${shown.length}/${messages.length}`;
    if (!shown.length) {
      list.append(el('div', { class: 'qs-empty dim', text: messages.length ? 'nothing matches that filter' : `no ${opts.title.toLowerCase()} messages yet` }));
      return;
    }
    for (const m of shown.slice(0, 200)) {
      const text = m.text || '';
      const btn = el('button', {
        type: 'button',
        class: 'qs-item',
        role: 'option',
        'aria-selected': selected && selected.id === m.id ? 'true' : 'false',
        title: text,
      });
      btn.append(
        el('span', { class: 'qs-item-kind', 'data-kind': m.kind || 'wall', text: m.pool || m.kind || '' }),
        el('span', { class: 'qs-item-text' },
          m.title ? el('span', { class: 'qs-item-title', text: m.title }) : null,
          el('span', { class: 'qs-item-body', text: text || '(no text)' }),
          m.tags && m.tags.length
            ? el('span', { class: 'qs-item-tags dim', text: m.tags.slice(0, 6).join(' · ') })
            : null,
        ),
        m.pinned ? el('span', { class: 'qs-pin', text: '●' }) : null,
      );
      btn.addEventListener('click', () => {
        selected = m;
        textArea.value = m.text || '';
        titleInput.value = m.title || '';
        paintList();
        textArea.focus();
      });
      list.append(btn);
    }
  }

  search.addEventListener('input', () => {
    query = search.value.trim();
    paintList();
  });
  function paintPools(pools) {
    const rows = Array.isArray(pools) && pools.length ? pools.slice() : [{ id: 'all', name: 'All messages' }];
    rows.sort((a, b) => (b.id === 'all' ? 1 : 0) - (a.id === 'all' ? 1 : 0));
    clear(poolSelect);
    for (const p of rows) poolSelect.append(el('option', { value: p.id, text: p.name || p.label || p.id }));
    poolSelect.append(el('option', { value: NEW_POOL, text: '＋ New pool…' }));
    if (!rows.some((p) => p.id === activePool)) activePool = 'all';
    poolSelect.value = activePool;
  }

  poolSelect.addEventListener('change', () => {
    const id = poolSelect.value;
    if (id !== NEW_POOL) {
      activePool = id;
      refresh().catch((err) => toast(`pool failed to load: ${err.message}`, 'error'));
      return;
    }
    const label = (window.prompt('Name the new pool') || '').trim();
    if (!label) {
      poolSelect.value = activePool;
      return;
    }
    // The pool takes the kind of the message on screen, or the kind of the pane it was made in.
    const kind = (selected && selected.kind) || paneKind;
    opts.api.post('/api/pools', { label, kind })
      .then((res) => {
        activePool = (res && res.pool && res.pool.id) || 'all';
        return refresh();
      })
      .catch((err) => {
        toast(`could not create the pool: ${err.message}`, 'error');
        poolSelect.value = activePool;
      });
  });

  /* ------------------------------------------------------------ sending */

  function payload() {
    const text = textArea.value.trim();
    const base = {};
    if (selected && !text.trim()) base.poolId = selected.id;
    else if (text) base.text = text;
    if (titleInput.value.trim()) base.title = titleInput.value.trim();
    if (selected && selected.kind && !base.kind) base.kind = selected.kind;
    return base;
  }

  let busy = false;
  async function fire(scheduled) {
    if (busy) return;
    const body2 = payload();
    if (!body2.text && !body2.poolId) {
      toast('nothing to send — type a message or pick one', 'error');
      return;
    }
    const at = scheduled ? fromLocalInput(atInput.value) : NaN;
    if (scheduled && !Number.isFinite(at)) {
      toast('pick a date and time first', 'error');
      atInput.focus();
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    schedToggle.disabled = true;
    try {
      if (scheduled) {
        await opts.onSchedule({ ...body2, at });
        toast(`booked for ${new Date(at).toLocaleString()}`, 'ok');
        atInput.hidden = true;
        schedToggle.dataset.on = '';
        sendBtn.textContent = 'Send now';
      } else {
        const res = await opts.onSend(body2);
        // The answer is in hand, so the toast reports it instead of assuming it: a refusal
        // (ok:false), a send held back by auto-apply, and a send no render page was listening
        // for are three different outcomes and none of them is "sent".
        const said = res && typeof res === 'object' ? res : null;
        const label = opts.title.toLowerCase();
        if (said && said.ok === false) {
          toast(`${label}: ${said.note || 'refused'}`, 'error');
          return;
        }
        if (said && said.queued) {
          toast(`${label} queued — press Apply to send it`, 'ok');
          return;
        }
        if (said && said.delivered === 0 && said.seq !== undefined) {
          toast(`${label}: no render page connected — nothing is on the wall`, 'warn');
          return;
        }
        toast(`${label} sent`, 'ok');
      }
      if (keepBox.checked && body2.text && opts.onSave) {
        try {
          await opts.onSave({ text: body2.text, title: body2.title, kind: body2.kind, tags: [] });
          keepBox.checked = false;
          await refresh();
        } catch (err) {
          toast(`saved send, but pool save failed: ${err.message}`, 'error');
        }
      }
      selected = null;
      textArea.value = '';
      titleInput.value = '';
      atInput.value = '';
      paintList();
    } catch (err) {
      toast(`${scheduled ? 'schedule' : 'send'} failed: ${err.message}`, 'error');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      schedToggle.disabled = false;
    }
  }

  sendBtn.addEventListener('click', () => {
    const wantsLater = !atInput.hidden && !!atInput.value;
    fire(wantsLater);
  });

  schedToggle.addEventListener('click', () => {
    const on = !atInput.hidden;
    atInput.hidden = on;
    schedToggle.dataset.on = on ? '' : 'true';
    if (on) {
      sendBtn.textContent = 'Send now';
      atInput.value = '';
    } else {
      if (!atInput.value) atInput.value = inMinutes(5);
      sendBtn.textContent = 'Schedule';
      atInput.focus();
    }
  });

  // Enter sends from the composer; Shift+Enter is a newline. The textarea keeps its own meaning for
  // Enter once the message is more than one line, so this only fires for a plain single keystroke.
  textArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      textArea.focus();
    }
  });

  /* ------------------------------------------------------------ data */

  async function refresh() {
    const r = await opts.api.get('/api/pools');
    paintPools(Array.isArray(r) ? r : r && r.pools);
    // `/api/pools` carries counts only; the pool view carries the message bodies.
    const one = await opts.api.get(`/api/pool/${encodeURIComponent(activePool)}`);
    messages = one && Array.isArray(one.messages) ? one.messages : [];
    paintTags();
    paintList();
  }

  refresh().catch((err) => {
    list.append(el('div', { class: 'qs-empty dim', text: `pool unavailable: ${err.message}` }));
  });

  // A pool deleted or created anywhere (this pane, the messages pane, the deck) reaches the
  // picker through the shell's SSE bus, so the dropdown is current without a page reload.
  if (opts.events && typeof opts.events.subscribe === 'function') {
    const stop = opts.events.subscribe('pool', () => {
      const before = activePool;
      opts.api.get('/api/pools')
        .then((r) => {
          paintPools(Array.isArray(r) ? r : r && r.pools);
          // The pool this box was reading is gone: `paintPools` fell back to `all`, so re-read.
          if (activePool !== before) return refresh();
          return null;
        })
        .catch(() => {
          /* the next explicit refresh reports the failure */
        });
    });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => stop(), { once: true });
    }
  }

  return {
    refresh,
    get selected() {
      return selected;
    },
    select(message) {
      selected = message;
      textArea.value = message ? message.text || '' : '';
      paintList();
    },
    setText(text) {
      textArea.value = text;
    },
    focus() {
      textArea.focus();
    },
  };
}

export { MAX_TAGS };
