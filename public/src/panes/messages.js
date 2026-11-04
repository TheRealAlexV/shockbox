// Messages pane — the shared pool behind both Notifications and Alerts.
//
// Data:
//   GET    /api/pools                 {pools:[{id,name,count}], types, tags, counts}
//   GET    /api/pool/:id?type&tag&q&random=1
//          id ∈ all | dialogs | notifications | random   (+ random=1 returns only random-checked)
//          → {id, name, types, tags, counts, messages:[{id,text,type,tags,buttons,title,kind,random,storm}]}
//   POST   /api/pool/:id/messages     {text,type,kind,tags,buttons,title}
//   PATCH  /api/pool/:id/messages/:mid  partial
//   DELETE /api/pool/:id/messages/:mid
//   POST   /api/pool/:id/reorder      {ids:[...]}  — drag order, top to bottom
//   POST   /api/pool/:id/messages/:mid/move {to, index}
// Pools (managed here, where the messages live):
//   GET    /api/pools                 {pools:[{id,name,count}]}  — `all`/`random` are views
//   POST   /api/pools                 {label, kind}
//   PATCH  /api/pools/:id             {label?, tags?}
//   DELETE /api/pools/:id             → {moved}; held messages fall back to a pool of their kind
// Live:   SSE `pool` channel, event `pools` → the whole view for tab `all` (reason included).
//
// Tabs are views over one list; writes always go through `all`. Every stored pool is a tab.

import { el, clear, fmtWhen, debounce, actionButton } from '../ui.js';
import { toast } from '../toast.js';

const VIRTUAL = new Set(['all', 'random']);
const VIRTUAL_TABS = [
  { id: 'all', label: 'All' },
  { id: 'random', label: 'Random' },
];
// Autosave window for an inline message edit: longer than a keystroke, short enough that the
// overlay is current before the eye leaves the row.
const EDIT_SAVE_MS = 350;

const KINDS = [
  { id: 'dialog', label: 'Alert' },
  { id: 'notification', label: 'Notification' },
  { id: 'wall', label: 'Wall' },
];
const ACTIONS = [
  { id: 'close', label: 'close' },
  { id: 'closeAll', label: 'closeAll' },
  { id: 'spawn', label: 'spawn' },
  { id: 'none', label: 'none' },
];

export async function render(container, ctx) {
  const { api, events, signal } = ctx;
  const unsubs = [];
  const session = new AbortController();
  const gone = () => session.signal.aborted || signal?.aborted;

  const q = {
    tab: 'all',
    type: '',
    tags: new Set(),
    search: '',
    types: [],
    tags_: [],
    counts: {},
    pools: [],
    messages: [],
    loading: false,
  };

  // While an inline editor is open the list is not rebuilt from SSE frames: our own PATCH echo
  // would otherwise replace the textarea and lose the caret mid-word.
  let editing = null;

  // A pool id can only be validated once `GET /api/pools` lands, so remember the request.
  let wantedTab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || '';

  /* ---------------------------------------------------------- structure */

  const head = el('div', { class: 'pane-head' });
  const headStatus = el('div', { class: 'pane-head-status' });
  head.append(
    el('div', { class: 'pane-title-wrap' },
      el('h1', { class: 'pane-title', text: 'Message pool' }),
      el('p', { class: 'pane-desc', text: 'One list behind both Notifications and Alerts. Kind decides which module spawns a message.' }),
    ),
    headStatus,
  );

  const tabsRow = el('div', { class: 'tabs-row' }, el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Pool view' }));
  const tabs = tabsRow.firstElementChild;

  /* --------------------------------------------------------- pool manager */

  const manager = el('div', { class: 'pool-toolbar pool-manager' });
  const managerLabel = el('span', { class: 'filter-label', text: 'pool' });
  const poolSelect = el('select', { class: 'input input-sm pool-select', 'aria-label': 'Pool' });
  poolSelect.addEventListener('change', () => selectTab(poolSelect.value));
  const managerActions = el('div', { class: 'pool-inline' });

  // Rename happens in place: the same row swaps its controls for an input.
  const renameForm = el('form', { class: 'pool-inline', hidden: true, autocomplete: 'off' });
  const renameInput = el('input', { type: 'text', class: 'input input-sm', maxlength: '60', 'aria-label': 'Pool name' });
  const renameCancel = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: 'Cancel' });
  renameForm.append(renameInput, el('button', { type: 'submit', class: 'btn btn-primary btn-sm', text: 'Save name' }), renameCancel);
  renameCancel.addEventListener('click', () => { renameForm.hidden = true; });
  renameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = renameInput.value.trim();
    if (!label) { toast('a pool needs a name', 'error'); return; }
    try {
      await api.patch(`/api/pools/${encodeURIComponent(q.tab)}`, { label });
      renameForm.hidden = true;
      toast('pool renamed', 'ok');
      await reload();
    } catch (err) {
      toast(`rename failed: ${err.message}`, 'error');
    }
  });

  const createForm = el('form', { class: 'pool-inline', hidden: true, autocomplete: 'off' });
  const createInput = el('input', { type: 'text', class: 'input input-sm', placeholder: 'New pool name', maxlength: '60', 'aria-label': 'New pool name' });
  const createKind = el('select', { class: 'input input-sm', 'aria-label': 'New pool kind' });
  for (const k of KINDS) createKind.append(el('option', { value: k.id, text: k.label }));
  const createCancel = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: 'Cancel' });
  createForm.append(createInput, createKind, el('button', { type: 'submit', class: 'btn btn-primary btn-sm', text: 'Create pool' }), createCancel);
  createCancel.addEventListener('click', () => { createForm.hidden = true; });
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = createInput.value.trim();
    if (!label) { toast('a pool needs a name', 'error'); return; }
    try {
      const out = await api.post('/api/pools', { label, kind: createKind.value });
      createInput.value = '';
      createForm.hidden = true;
      toast(`pool ${out?.pool?.label || label} created`, 'ok');
      if (out?.pool?.id) {
        q.tab = out.pool.id;
        setUrlTab(q.tab);
      }
      await reload();
    } catch (err) {
      toast(`create failed: ${err.message}`, 'error');
    }
  });

  manager.append(managerLabel, poolSelect, managerActions, renameForm, createForm);

  const addBtn = el('button', { type: 'button', class: 'btn btn-primary', 'aria-expanded': 'false', 'aria-controls': 'add-form' });
  addBtn.append(el('span', { class: 'btn-label', text: '+ Add message' }));

  const toolbar = el('div', { class: 'pool-toolbar' });
  const searchWrap = el('div', { class: 'search' });
  const searchIcon = el('span', { class: 'search-icon' });
  const searchSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  searchSvg.setAttribute('viewBox', '0 0 16 16');
  searchSvg.setAttribute('fill', 'none');
  searchSvg.setAttribute('stroke', 'currentColor');
  searchSvg.setAttribute('stroke-width', '1.4');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '7');
  circle.setAttribute('cy', '7');
  circle.setAttribute('r', '4.2');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', 'M10.2 10.2 14 14');
  searchSvg.append(circle, line);
  searchIcon.append(searchSvg);
  searchWrap.append(searchIcon);
  const search = el('input', { type: 'search', class: 'input search-input', placeholder: 'Search text, title, tags…', 'aria-label': 'Search messages' });
  const onSearch = debounce(() => {
    q.search = search.value.trim();
    rebuildList();
  }, 140);
  search.addEventListener('input', onSearch);

  const typeFilter = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by type' });
  const tagFilter = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by tag' });

  const randomOnly = el('label', { class: 'switch-inline', title: 'Only messages checked for random spawn' });
  const randomBox = el('input', { type: 'checkbox' });
  randomBox.addEventListener('change', () => {
    q.randomOnly = randomBox.checked;
    rebuildList();
  });
  randomOnly.append(randomBox, el('span', { text: 'random only' }));

  toolbar.append(searchWrap, typeFilter, tagFilter, randomOnly);
  tabsRow.append(tabs, addBtn);

  const addForm = buildAddForm();
  addForm.root.hidden = true;
  addBtn.addEventListener('click', () => {
    const open = addForm.root.hidden;
    addForm.root.hidden = !open;
    addBtn.setAttribute('aria-expanded', String(open));
    addBtn.querySelector('.btn-label').textContent = open ? 'Close form' : '+ Add message';
    if (open) addForm.focus();
  });

  const listBox = el('div', { class: 'msg-list', role: 'list' });
  const emptyBox = el('div', { class: 'live-empty msg-empty' },
    el('span', { class: 'live-empty-mark', 'aria-hidden': 'true' }),
    el('span', { text: 'No messages match this view' }),
  );

  clear(container);
  container.append(head, manager, tabsRow, toolbar, addForm.root, el('section', { class: 'pool-list' }, listBox, emptyBox));

  /* --------------------------------------------------------------- data */

  function setUrlTab(tab) {
    const base = '#/messages';
    const next = tab === 'all' ? base : `${base}?tab=${tab}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  async function loadMeta() {
    const r = await api.get('/api/pools');
    q.pools = Array.isArray(r.pools) ? r.pools : [];
    q.types = r.types || [];
    q.tags_ = r.tags || [];
    q.counts = r.counts || {};
    if (wantedTab) {
      if (tabList().some((p) => p.id === wantedTab)) {
        q.tab = wantedTab;
        setUrlTab(wantedTab);
      }
      wantedTab = '';
    }
    addForm.setTypes(q.types);
    buildTabs();
    paintTabs();
    paintManager();
    paintChips();
  }

  async function loadMessages() {
    if (q.loading) return;
    q.loading = true;
    const params = new URLSearchParams();
    // The tab already selects the pool; `type` is only the chip filter on top of it.
    if (q.type) params.set('type', q.type);
    if (q.randomOnly) params.set('random', '1');
    // The API filters by one tag; we filter the rest client-side so chips compose.
    const tagList = [...q.tags];
    if (tagList.length === 1) params.set('tag', tagList[0]);
    const qs = params.toString();
    headStatus.dataset.state = 'loading';
    try {
      const r = await api.get(`/api/pool/${encodeURIComponent(q.tab)}${qs ? `?${qs}` : ''}`, { signal: session.signal });
      if (gone()) return;
      q.messages = Array.isArray(r.messages) ? r.messages : [];
      if (r.types) q.types = r.types;
      if (r.tags) q.tags_ = r.tags;
      if (r.counts) q.counts = r.counts;
      headStatus.dataset.state = 'ok';
      paintTabs();
      paintChips();
      rebuildList();
    } catch (err) {
      if (gone() || err?.name === 'AbortError') return;
      headStatus.dataset.state = 'bad';
      clear(listBox);
      listBox.appendChild(el('div', { class: 'live-error', text: `could not load the pool: ${err.message}` }));
      emptyBox.hidden = true;
    } finally {
      q.loading = false;
      delete headStatus.dataset.state;
    }
  }

  async function reload() {
    // Meta first: it can retarget `q.tab` (deep link, deleted pool) before messages are read.
    await Promise.allSettled([loadMeta()]);
    await loadMessages();
  }

  /* --------------------------------------------------------------- paint */

  /** Tabs = the two virtual views plus every stored pool, `random` pinned last. */
  function tabList() {
    const stored = (q.pools || [])
      .filter((p) => p && p.id && !VIRTUAL.has(p.id))
      .map((p) => ({ id: p.id, label: p.name || p.id }));
    return [VIRTUAL_TABS[0], ...stored, VIRTUAL_TABS[1]];
  }

  function selectTab(id) {
    if (!id) return;
    q.tab = id;
    setUrlTab(id);
    renameForm.hidden = true;
    createForm.hidden = true;
    paintTabs();
    paintManager();
    rebuildList();
    loadMessages();
  }

  function buildTabs() {
    const list = tabList();
    const key = list.map((p) => `${p.id}:${p.label}`).join('|');
    if (tabs.dataset.key === key) return;
    tabs.dataset.key = key;
    clear(tabs);
    for (const t of list) {
      const b = el('button', { type: 'button', class: 'tab', role: 'tab', dataset: { tab: t.id } });
      b.append(el('span', { class: 'tab-label', text: t.label }), el('span', { class: 'tab-count mono', text: '–' }));
      b.addEventListener('click', () => selectTab(t.id));
      tabs.appendChild(b);
    }
  }

  /** The picker plus rename/delete/create controls, rebuilt from the pool list. */
  function paintManager() {
    const list = tabList();
    if (!list.some((p) => p.id === q.tab)) {
      q.tab = 'all';
      setUrlTab('all');
    }
    clear(poolSelect);
    for (const p of list) {
      const n = q.counts?.[p.id];
      poolSelect.append(el('option', { value: p.id, text: n === undefined ? p.label : `${p.label} (${n})` }));
    }
    poolSelect.value = q.tab;

    clear(managerActions);
    if (VIRTUAL.has(q.tab)) {
      managerActions.append(el('span', { class: 'pool-hint dim', text: 'a view, not a pool' }));
    } else {
      const name = list.find((p) => p.id === q.tab)?.label || q.tab;
      const meta = (q.pools || []).find((p) => p.id === q.tab) || {};
      const held = q.counts?.[q.tab] || 0;
      const rename = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: 'Rename' });
      rename.addEventListener('click', () => {
        createForm.hidden = true;
        renameInput.value = name;
        renameForm.hidden = false;
        renameInput.focus();
        renameInput.select();
      });
      managerActions.append(rename);
      if (meta.builtin) {
        // No delete affordance for a seed pool: the server would refuse it, and the explanation
        // (the same sentence the API returns) is more useful than a button that always fails.
        managerActions.append(el('span', { class: 'pool-hint dim pool-builtin', text: meta.note || 'built-in pool — cannot be deleted' }));
      } else {
        const del = actionButton({
          label: 'Delete pool',
          variant: 'btn-danger btn-sm',
          title: `Delete ${name}`,
          confirm: `Delete — ${held} message${held === 1 ? '' : 's'} move?`,
          run: () => api.del(`/api/pools/${encodeURIComponent(q.tab)}`),
          onDone: async (out) => {
            renameForm.hidden = true;
            q.tab = 'all';
            setUrlTab('all');
            toast(out?.moved ? `pool deleted, ${out.moved} message(s) moved` : 'pool deleted', 'ok');
            await reload();
          },
          onError: (err) => toast(`delete failed: ${err.message}`, 'error'),
        });
        managerActions.append(del);
      }
    }
    const newBtn = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: '+ New pool' });
    newBtn.addEventListener('click', () => {
      renameForm.hidden = true;
      createForm.hidden = !createForm.hidden;
      if (!createForm.hidden) createInput.focus();
    });
    managerActions.append(newBtn);
  }

  function paintTabs() {
    for (const b of tabs.children) {
      b.setAttribute('aria-selected', String(b.dataset.tab === q.tab));
      const n = q.counts?.[b.dataset.tab];
      b.querySelector('.tab-count').textContent = n === undefined ? '–' : String(n);
    }
  }

  function paintChips() {
    clear(typeFilter);
    typeFilter.append(el('span', { class: 'filter-label', text: 'type' }));
    const all = el('button', { type: 'button', class: 'chip-btn', text: 'any' });
    all.setAttribute('aria-pressed', String(!q.type));
    all.addEventListener('click', () => {
      q.type = '';
      paintChips();
      loadMessages();
    });
    typeFilter.appendChild(all);
    for (const t of q.types) {
      const b = el('button', { type: 'button', class: 'chip-btn', text: t });
      b.setAttribute('aria-pressed', String(q.type === t));
      b.addEventListener('click', () => {
        q.type = q.type === t ? '' : t;
        paintChips();
        loadMessages();
      });
      typeFilter.appendChild(b);
    }

    clear(tagFilter);
    tagFilter.append(el('span', { class: 'filter-label', text: 'tags' }));
    if (!q.tags_.length) tagFilter.append(el('span', { class: 'chips-none dim', text: 'none yet' }));
    for (const t of q.tags_) {
      const b = el('button', { type: 'button', class: 'chip-btn', text: `#${t}` });
      b.setAttribute('aria-pressed', String(q.tags.has(t)));
      b.addEventListener('click', () => {
        if (q.tags.has(t)) q.tags.delete(t);
        else q.tags.add(t);
        paintChips();
        loadMessages();
      });
      tagFilter.appendChild(b);
    }
  }

  function visibleMessages() {
    const needle = q.search.toLowerCase();
    return q.messages.filter((m) => {
      if (q.type && (m.type || '') !== q.type) return false;
      for (const t of q.tags) if (!(m.tags || []).includes(t)) return false;
      if (q.randomOnly && !m.random) return false;
      if (!needle) return true;
      const hay = [m.text, m.title, (m.tags || []).join(' '), ...(m.buttons || []).map((b) => b.label)].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  function rebuildList() {
    // Any rebuild replaces every row, so no inline editor can survive it.
    editing = null;
    const rows = visibleMessages();
    clear(listBox);
    for (const m of rows) listBox.appendChild(rowFor(m));
    emptyBox.hidden = rows.length > 0;
    emptyBox.querySelector('span:last-child').textContent = q.messages.length
      ? `None of the ${q.messages.length} loaded messages match these filters`
      : 'The pool is empty — add a message to start';
    // drag state is rebuilt with the list
    dragId = null;
  }

  /* ----------------------------------------------------------------- rows */

  let dragId = null;

  function rowFor(m) {
    const row = el('div', { class: 'msg-row', role: 'listitem', dataset: { id: m.id, kind: m.kind || '' } });
    row.draggable = true;

    const handle = el('span', { class: 'msg-grip', title: 'Drag to reorder', 'aria-hidden': 'true' });
    handle.append(el('span'), el('span'), el('span'));

    const body = el('div', { class: 'msg-body' });
    const meta = el('div', { class: 'msg-meta' });
    meta.append(
      el('span', { class: 'msg-kind', dataset: { kind: m.kind || 'notification' }, text: m.kind === 'dialog' ? 'alert' : m.kind === 'notification' ? 'toast' : m.kind === 'wall' ? 'wall' : m.kind || '?' }),
      m.type ? el('span', { class: 'msg-type', text: m.type }) : '',
      el('span', { class: 'mono dim msg-id', text: m.id }),
      m.random ? el('span', { class: 'badge badge-light', text: 'random' }) : '',
      m.storm ? el('span', { class: 'badge badge-light', text: 'storm' }) : '',
    );
    for (const t of m.tags || []) meta.append(el('span', { class: 'msg-tag dim mono', text: `#${t}` }));

    const text = el('div', { class: 'msg-text', text: m.text || '' });
    if (m.title) body.append(el('div', { class: 'msg-title', text: m.title }));
    body.append(text);
    const btns = Array.isArray(m.buttons) ? m.buttons : [];
    if (btns.length) {
      const bl = el('div', { class: 'msg-buttons' });
      for (const b of btns) bl.append(el('span', { class: 'msg-btn' }, el('span', { class: 'msg-btn-label', text: b.label || '?' }), el('span', { class: 'msg-btn-act mono dim', text: b.action || '' })));
      body.append(bl);
    }

    const side = el('div', { class: 'msg-side' });
    const edit = el('button', { type: 'button', class: 'btn btn-quiet btn-sm btn-icon', title: 'Edit', 'aria-label': `Edit ${m.id}` });
    edit.append(svgIcon('M4 11.6 4.6 9l5.8-5.8 1.9 1.9L6.5 11zm0 0 1.9 1.9'));
    edit.addEventListener('click', () => openEditor(row, m, body));
    const del = actionButton({
      label: 'Del',
      variant: 'btn-danger btn-sm',
      title: `Delete ${m.id}`,
      confirm: 'Sure?',
      run: () => api.del(`/api/pool/all/messages/${encodeURIComponent(m.id)}`),
      onDone: () => {
        row.classList.add('leaving');
        setTimeout(() => reload(), 150);
      },
      onError: (err) => toast(`delete failed: ${err.message}`, 'error'),
    });
    del.classList.add('msg-del');
    side.append(edit, del);

    row.append(handle, body, side);
    wireDnD(row, m);
    return row;
  }

  function openEditor(row, m, bodyEl) {
    if (row.dataset.editing === 'true') return;
    row.dataset.editing = 'true';
    editing = m.id;
    const draft = {
      text: m.text || '',
      title: m.title || '',
      type: m.type || '',
      kind: m.kind || 'notification',
      tags: (m.tags || []).join(', '),
      buttons: (m.buttons || []).map((b) => ({ label: b.label || '', action: b.action || 'close' })),
      random: !!m.random,
      storm: !!m.storm,
    };
    // The last text the server confirmed. A failed save puts the row back to it instead of
    // leaving the list claiming a change that never landed.
    const confirmed = { text: draft.text, title: draft.title };
    const status = el('span', { class: 'msg-save dim', role: 'status', 'aria-live': 'polite' });
    let timer = null;
    let dirty = false;
    let seq = 0;
    let closed = false;

    const say = (text, tone) => {
      status.textContent = text;
      if (tone) status.dataset.tone = tone;
      else delete status.dataset.tone;
    };

    const payload = () => ({
      text: draft.text,
      title: draft.title,
      type: draft.type,
      kind: draft.kind,
      tags: splitTags(draft.tags),
      buttons: draft.buttons.filter((b) => b.label.trim()),
      random: draft.random,
      storm: draft.storm,
    });

    async function save() {
      if (!dirty) return;
      if (!draft.text.trim()) {
        say('text is required', 'bad');
        return;
      }
      dirty = false;
      say('saving…');
      const mine = ++seq;
      // What this request sends. `draft` keeps changing while it is in flight.
      const sent = { text: draft.text, title: draft.title };
      // Optimistic: the record the rest of the pane reads changes before the request resolves.
      m.text = draft.text;
      m.title = draft.title;
      m.type = draft.type;
      m.kind = draft.kind;
      m.tags = splitTags(draft.tags);
      try {
        const out = await api.patch(`/api/pool/all/messages/${encodeURIComponent(m.id)}`, payload());
        // A save that started after this one owns the row; its response is the truth.
        if (mine !== seq) return;
        if (out && out.message) {
          Object.assign(m, out.message);
          // Typing continued while this request was in flight: keep the optimistic text on top.
          if (dirty) {
            m.text = draft.text;
            m.title = draft.title;
            m.tags = splitTags(draft.tags);
          }
        }
        confirmed.text = sent.text;
        confirmed.title = sent.title;
        if (!dirty) say('saved', 'ok');
      } catch (err) {
        if (mine !== seq) return;
        dirty = true;
        m.text = confirmed.text;
        m.title = confirmed.title;
        say(`not saved: ${err.message}`, 'bad');
      }
    }

    function touched() {
      dirty = true;
      say('editing…');
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        save();
      }, EDIT_SAVE_MS);
    }

    async function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      timer = null;
      if (dirty) await save();
      if (dirty) {
        toast(draft.text.trim()
          ? `the edit to ${m.id} was not saved — the row keeps its last saved text`
          : 'text is required — the change was not saved', 'error');
      }
      editing = null;
      delete row.dataset.editing;
      // Rebuilding here (not on every frame) is what keeps typing smooth and, on close, gives
      // the row back its normal shape from the server's truth.
      rebuildList();
    }

    const editor = buildEditor(draft, { onDirty: touched, onClose: close, status });
    bodyEl.replaceWith(editor);
  }

  /* ----------------------------------------------------------------- DnD */

  function wireDnD(row, m) {
    row.addEventListener('dragstart', (e) => {
      dragId = m.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox needs data set to start a drag
      try {
        e.dataTransfer.setData('text/plain', m.id);
      } catch {
        /* ignore */
      }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      dragId = null;
      for (const r of listBox.children) r.classList.remove('drop-before', 'drop-after');
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragId || dragId === m.id) return;
      const rect = row.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-before', 'drop-after');
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      const realId = dragId;
      const rect = row.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      row.classList.remove('drop-before', 'drop-after');
      if (!realId || realId === m.id) return;
      await moveMessage(realId, m.id, after);
    });
  }

  async function moveMessage(id, targetId, after) {
    const visible = visibleMessages().map((x) => x.id);
    if (!visible.includes(id) || !visible.includes(targetId)) return;
    // reorder within the *full* list: keep messages hidden by a filter where they are
    const fullIds = q.messages.map((x) => x.id);
    const without = fullIds.filter((x) => x !== id);
    const targetIdx = without.indexOf(targetId);
    const insertAt = after ? targetIdx + 1 : targetIdx;
    const nextIds = [...without.slice(0, insertAt), id, ...without.slice(insertAt)];
    if (nextIds.join() === fullIds.join()) return;
    // optimistic paint so the drag feels immediate
    const byId = new Map(q.messages.map((x) => [x.id, x]));
    q.messages = nextIds.map((x) => byId.get(x)).filter(Boolean);
    rebuildList();
    try {
      // the server reorders the whole list; filtered views must not send a partial order
      const source = q.tab === 'all' && !q.type && !q.tags.size && !q.randomOnly && !q.search ? nextIds : await allIdsWith(id, targetId, after);
      await api.post('/api/pool/all/reorder', { ids: source });
    } catch (err) {
      toast(`reorder failed: ${err.message}`, 'error');
      await loadMessages();
    }
  }

  /** Build the authoritative order from the full list (drag happened in a filtered view). */
  async function allIdsWith(id, targetId, after) {
    const r = await api.get('/api/pool/all');
    const ids = (r.messages || []).map((x) => x.id).filter((x) => x !== id);
    const ti = ids.indexOf(targetId);
    if (ti < 0) return r.messages.map((x) => x.id);
    ids.splice(after ? ti + 1 : ti, 0, id);
    return ids;
  }

  /* -------------------------------------------------------------- forms */

  function buildAddForm() {
    const root = el('form', { class: 'add-form', id: 'add-form', autocomplete: 'off' });
    const draft = {
      text: '',
      title: '',
      type: '',
      kind: 'notification',
      tags: '',
      buttons: [{ label: 'OK', action: 'close' }],
      random: true,
      storm: false,
    };
    const textArea = el('textarea', { class: 'input', rows: '3', placeholder: 'Message text — what shows on stream', 'aria-label': 'Text' });
    const titleInput = el('input', { type: 'text', class: 'input', placeholder: '(optional) dialog title', 'aria-label': 'Title' });
    const listId = 'pool-types';
    const typeInput = el('input', { type: 'text', class: 'input', placeholder: 'Info', 'aria-label': 'Type', list: listId, autocomplete: 'off' });
    const datalist = el('datalist', { id: listId });
    const kindSeg = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Kind' });
    for (const k of KINDS) {
      const b = el('button', { type: 'button', class: 'seg', text: k.label, dataset: { value: k.id } });
      b.setAttribute('aria-checked', String(k.id === draft.kind));
      b.addEventListener('click', () => {
        draft.kind = k.id;
        for (const x of kindSeg.children) x.setAttribute('aria-checked', String(x === b));
      });
      kindSeg.appendChild(b);
    }
    const tagsInput = el('input', { type: 'text', class: 'input', placeholder: 'office, sales', 'aria-label': 'Tags' });
    const buttonsBox = el('div', { class: 'btn-editor' });
    const randomBox = el('input', { type: 'checkbox', checked: true });
    const stormBox = el('input', { type: 'checkbox' });

    function paintButtons() {
      clear(buttonsBox);
      draft.buttons.forEach((b, i) => {
        const row = el('div', { class: 'btn-row' });
        const label = el('input', { type: 'text', class: 'input input-sm', value: b.label, placeholder: 'OK', 'aria-label': `Button ${i + 1} label` });
        label.addEventListener('input', () => {
          b.label = label.value;
        });
        // `el` forwards every key to setAttribute: setAttribute('type', ...) on a <select>
        // switches it to a single-line <select> rendering with no value semantics, so the
        // element is created without props here and configured directly.
        const act = el('select', { class: 'input btn-action' });
        act.setAttribute('aria-label', `Button ${i + 1} action`);
        for (const a of ACTIONS) act.append(el('option', { value: a.id, text: a.label }));
        // set after the options exist: `selected` on an <option> is ignored once it is appended
        act.value = b.action;
        act.addEventListener('change', () => {
          b.action = act.value;
        });
        const rm = el('button', { type: 'button', class: 'btn btn-quiet btn-sm btn-icon', title: 'Remove button', 'aria-label': 'Remove button', text: '×' });
        rm.addEventListener('click', () => {
          draft.buttons.splice(i, 1);
          paintButtons();
        });
        row.append(label, act, rm);
        buttonsBox.appendChild(row);
      });
      const add = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: '+ button' });
      add.addEventListener('click', () => {
        draft.buttons.push({ label: '', action: 'close' });
        paintButtons();
      });
      buttonsBox.appendChild(add);
    }
    paintButtons();

    const submit = actionButton({
      label: 'Create message',
      variant: 'btn-primary',
      run: async () => {
        draft.text = textArea.value.trim();
        draft.title = titleInput.value.trim();
        const typeVec = typeInput.value.trim();
        draft.type = typeVec;
        draft.tags = tagsInput.value;
        draft.random = randomBox.checked;
        draft.storm = stormBox.checked;
        if (!draft.text) throw new Error('text is required');
        if (draft.buttons.some((b) => !b.label.trim())) throw new Error('every button needs a label');
        return api.post('/api/pool/all/messages', {
          text: draft.text,
          title: draft.title,
          type: draft.type || 'Info',
          kind: draft.kind,
          tags: splitTags(draft.tags),
          buttons: draft.buttons.map((b) => ({ label: b.label.trim(), action: b.action })),
          random: draft.random,
          storm: draft.storm,
        });
      },
      onDone: (out) => {
        toast(out?.message ? `created ${out.message.id ?? ''}`.trim() : 'message created', 'ok');
        textArea.value = '';
        titleInput.value = '';
        typeInput.value = '';
        tagsInput.value = '';
        randomBox.checked = true;
        stormBox.checked = false;
        reload();
      },
      onError: (err) => toast(`create failed: ${err.message}`, 'error'),
    });

    root.append(
      el('div', { class: 'form-grid' },
        el('label', { class: 'form-field form-field-wide' }, el('span', { class: 'form-label', text: 'Text' }), textArea),
        el('label', { class: 'form-field' }, el('span', { class: 'form-label', text: 'Title' }), titleInput),
        el('label', { class: 'form-field' }, el('span', { class: 'form-label', text: 'Type' }), typeInput, datalist),
        el('div', { class: 'form-field' }, el('span', { class: 'form-label', text: 'Kind' }), kindSeg),
        el('label', { class: 'form-field' }, el('span', { class: 'form-label', text: 'Tags' }), tagsInput),
        el('div', { class: 'form-field form-field-wide' }, el('span', { class: 'form-label', text: 'Buttons' }), buttonsBox),
        el('div', { class: 'form-field form-field-wide form-actions' },
          el('label', { class: 'switch-inline' }, randomBox, el('span', { text: 'eligible for random spawn' })),
          el('label', { class: 'switch-inline' }, stormBox, el('span', { text: 'eligible for storm' })),
          el('span', { class: 'control-spacer' }),
          submit,
        ),
      ),
    );

    return {
      root,
      focus: () => textArea.focus(),
      setTypes(types) {
        clear(datalist);
        for (const t of types) datalist.appendChild(el('option', { value: t }));
      },
    };
  }

  function buildEditor(draft, { onClose, onDirty, status }) {
    const wrap = el('form', { class: 'msg-edit', autocomplete: 'off' });
    const textArea = el('textarea', { class: 'input', rows: '2', 'aria-label': 'Text' });
    textArea.value = draft.text;
    textArea.addEventListener('input', () => {
      draft.text = textArea.value;
      onDirty();
    });
    const titleInput = el('input', { type: 'text', class: 'input input-sm', 'aria-label': 'Title', placeholder: 'title' });
    titleInput.value = draft.title;
    titleInput.addEventListener('input', () => {
      draft.title = titleInput.value;
      onDirty();
    });
    const typeInput = el('input', { type: 'text', class: 'input input-sm', 'aria-label': 'Type', list: 'pool-types' });
    typeInput.value = draft.type;
    typeInput.addEventListener('input', () => {
      draft.type = typeInput.value;
      onDirty();
    });
    const kindSeg = el('div', { class: 'segmented segmented-sm', role: 'radiogroup', 'aria-label': 'Kind' });
    for (const k of KINDS) {
      const b = el('button', { type: 'button', class: 'seg', text: k.label, dataset: { value: k.id } });
      b.setAttribute('aria-checked', String(k.id === draft.kind));
      b.addEventListener('click', () => {
        draft.kind = k.id;
        for (const x of kindSeg.children) x.setAttribute('aria-checked', String(x === b));
        onDirty();
      });
      kindSeg.appendChild(b);
    }
    const tagsInput = el('input', { type: 'text', class: 'input input-sm', 'aria-label': 'Tags' });
    tagsInput.value = draft.tags;
    tagsInput.addEventListener('input', () => {
      draft.tags = tagsInput.value;
      onDirty();
    });
    const btnBox = el('div', { class: 'btn-editor btn-editor-compact' });
    function paint() {
      clear(btnBox);
      draft.buttons.forEach((b, i) => {
        const row = el('div', { class: 'btn-row' });
        const label = el('input', { type: 'text', class: 'input input-sm', value: b.label, 'aria-label': `Button ${i + 1} label`, placeholder: 'label' });
        label.addEventListener('input', () => {
          b.label = label.value;
          onDirty();
        });
        // `el` forwards every key to setAttribute: setAttribute('type', ...) on a <select>
        // switches it to a single-line <select> rendering with no value semantics, so the
        // element is created without props here and configured directly.
        const act = el('select', { class: 'input btn-action' });
        act.setAttribute('aria-label', `Button ${i + 1} action`);
        for (const a of ACTIONS) act.append(el('option', { value: a.id, text: a.label }));
        // set after the options exist: `selected` on an <option> is ignored once it is appended
        act.value = b.action;
        act.addEventListener('change', () => {
          b.action = act.value;
          onDirty();
        });
        const rm = el('button', { type: 'button', class: 'btn btn-quiet btn-sm btn-icon', text: '×', 'aria-label': 'Remove button' });
        rm.addEventListener('click', () => {
          draft.buttons.splice(i, 1);
          paint();
          onDirty();
        });
        row.append(label, act, rm);
        btnBox.appendChild(row);
      });
      const add = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: '+ button' });
      add.addEventListener('click', () => {
        draft.buttons.push({ label: '', action: 'close' });
        paint();
        onDirty();
      });
      btnBox.appendChild(add);
    }
    paint();

    const rand = el('input', { type: 'checkbox', checked: draft.random });
    rand.addEventListener('change', () => {
      draft.random = rand.checked;
      onDirty();
    });
    const st = el('input', { type: 'checkbox', checked: draft.storm });
    st.addEventListener('change', () => {
      draft.storm = st.checked;
      onDirty();
    });

    // No Save/Cancel pair: the editor autosaves (debounced in openEditor), so the only button is
    // the one that ends the edit. `status` is the live "saving… / saved / not saved" readout.
    const done = el('button', { type: 'button', class: 'btn btn-primary btn-sm', text: 'Done' });
    done.addEventListener('click', () => onClose());

    wrap.append(
      textArea,
      el('div', { class: 'editor-row' },
        titleInput,
        typeInput,
        kindSeg,
        tagsInput,
      ),
      el('div', { class: 'editor-row editor-row-flags' },
        el('label', { class: 'switch-inline' }, rand, el('span', { text: 'random' })),
        el('label', { class: 'switch-inline' }, st, el('span', { text: 'storm' })),
        el('span', { class: 'control-spacer' }),
        status,
        done,
      ),
      btnBox,
    );
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') onClose();
    });
    // Enter in a one-line field would otherwise submit the form and navigate away.
    wrap.addEventListener('submit', (e) => e.preventDefault());
    // Focus lands after the text, so the caret is at the end of the message instead of at 0.
    queueMicrotask(() => {
      textArea.focus();
      textArea.setSelectionRange(textArea.value.length, textArea.value.length);
    });
    return wrap;
  }

  /* --------------------------------------------------------------- live */

  unsubs.push(
    events.subscribe('pool', (frame) => {
      // `pools` events carry the whole `all` view: counts plus messages, on every write
      const data = frame.event === 'pools' ? frame.data : frame.cmd === 'pools' ? frame.args : null;
      if (!data) return;
      // A pool created or deleted elsewhere shows up as a changed `counts` key set.
      const known = new Set((q.pools || []).map((p) => p.id));
      const live = new Set(Object.keys(data.counts || {}).filter((id) => id !== 'storm'));
      if ([...live].some((id) => !known.has(id)) || [...known].some((id) => !live.has(id))) loadMeta();
      // Adopting the `all` view into a filtered tab would show messages that tab excludes.
      const unfiltered = q.tab === 'all' && !q.type && !q.tags.size && !q.randomOnly;
      if (Array.isArray(data.messages) && unfiltered) {
        // a write from any client (us, the deck, the wall) → adopt the server's truth
        q.messages = data.messages;
        if (data.types) q.types = data.types;
        if (data.tags) q.tags_ = data.tags;
        if (data.counts) q.counts = data.counts;
        if (!q.loading) {
          paintTabs();
          paintChips();
          // An open inline editor owns its row: adopting the frame's messages above is fine, but
          // rebuilding the DOM would replace the textarea (and the caret) on every PATCH echo.
          if (editing) paintManager();
          else rebuildList();
        }
      } else if (data.counts) {
        q.counts = data.counts;
        paintTabs();
        paintManager();
      }
    }),
  );

  // keep the "x ago"-less list honest on tab focus: cheap re-read when the operator returns
  const onFocus = () => {
    if (editing) return;
    loadMessages();
  };
  window.addEventListener('focus', onFocus);
  unsubs.push(() => window.removeEventListener('focus', onFocus));

  await reload();

  return () => {
    session.abort();
    onSearch.cancel?.();
    for (const u of unsubs) u?.();
  };
}

function splitTags(s) {
  return String(s || '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.4');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}
