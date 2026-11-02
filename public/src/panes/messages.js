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
// Live:   SSE `pool` channel, event `pools` → the whole view for tab `all` (reason included).
//
// Tabs are views over one list; writes always go through `all`.

import { el, clear, fmtWhen, debounce, actionButton } from '../ui.js';
import { toast } from '../toast.js';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'dialogs', label: 'Alerts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'wall', label: 'Wall' },
  { id: 'random', label: 'Random' },
];

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
    messages: [],
    loading: false,
  };

  const initialTab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
  if (initialTab && TABS.some((t) => t.id === initialTab)) q.tab = initialTab;

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
  const tabCount = new Map();
  for (const t of TABS) {
    const b = el('button', { type: 'button', class: 'tab', role: 'tab', dataset: { tab: t.id } });
    b.append(el('span', { class: 'tab-label', text: t.label }), el('span', { class: 'tab-count mono', text: '–' }));
    b.addEventListener('click', () => {
      q.tab = t.id;
      setUrlTab(t.id);
      paintTabs();
      rebuildList();
    });
    tabs.appendChild(b);
  }

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
  container.append(head, tabsRow, toolbar, addForm.root, el('section', { class: 'pool-list' }, listBox, emptyBox));

  /* --------------------------------------------------------------- data */

  function setUrlTab(tab) {
    const base = '#/messages';
    const next = tab === 'all' ? base : `${base}?tab=${tab}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  async function loadMeta() {
    const r = await api.get('/api/pools');
    q.types = r.types || [];
    q.tags_ = r.tags || [];
    q.counts = r.counts || {};
    addForm.setTypes(q.types);
    paintTabs();
    paintChips();
  }

  async function loadMessages() {
    if (q.loading) return;
    q.loading = true;
    const params = new URLSearchParams();
    if (q.tab !== 'all' && q.tab !== 'random') params.set('type', q.tab);
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
    await Promise.allSettled([loadMeta(), loadMessages()]);
  }

  /* --------------------------------------------------------------- paint */

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
    const editor = buildEditor(draft, {
      onCancel: () => {
        delete row.dataset.editing;
        editor.remove();
      },
      onSave: async () => {
        const payload = {
          text: draft.text,
          title: draft.title,
          type: draft.type,
          kind: draft.kind,
          tags: splitTags(draft.tags),
          buttons: draft.buttons.filter((b) => b.label.trim()),
          random: draft.random,
          storm: draft.storm,
        };
        await api.patch(`/api/pool/all/messages/${encodeURIComponent(m.id)}`, payload);
        toast(`${m.id} saved`, 'ok');
        await reload();
      },
    });
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

  function buildEditor(draft, { onCancel, onSave }) {
    const wrap = el('form', { class: 'msg-editor', autocomplete: 'off' });
    const textArea = el('textarea', { class: 'input', rows: '2', 'aria-label': 'Text' });
    textArea.value = draft.text;
    textArea.addEventListener('input', () => {
      draft.text = textArea.value;
    });
    const titleInput = el('input', { type: 'text', class: 'input input-sm', 'aria-label': 'Title', placeholder: 'title' });
    titleInput.value = draft.title;
    titleInput.addEventListener('input', () => {
      draft.title = titleInput.value;
    });
    const typeInput = el('input', { type: 'text', class: 'input input-sm', 'aria-label': 'Type', list: 'pool-types' });
    typeInput.value = draft.type;
    typeInput.addEventListener('input', () => {
      draft.type = typeInput.value;
    });
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
    const tagsInput = el('input', { type: 'text', class: 'input input-sm', 'aria-label': 'Tags' });
    tagsInput.value = draft.tags;
    tagsInput.addEventListener('input', () => {
      draft.tags = tagsInput.value;
    });
    const btnBox = el('div', { class: 'btn-editor btn-editor-compact' });
    function paint() {
      clear(btnBox);
      draft.buttons.forEach((b, i) => {
        const row = el('div', { class: 'btn-row' });
        const label = el('input', { type: 'text', class: 'input input-sm', value: b.label, 'aria-label': `Button ${i + 1} label`, placeholder: 'label' });
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
        const rm = el('button', { type: 'button', class: 'btn btn-quiet btn-sm btn-icon', text: '×', 'aria-label': 'Remove button' });
        rm.addEventListener('click', () => {
          draft.buttons.splice(i, 1);
          paint();
        });
        row.append(label, act, rm);
        btnBox.appendChild(row);
      });
      const add = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: '+ button' });
      add.addEventListener('click', () => {
        draft.buttons.push({ label: '', action: 'close' });
        paint();
      });
      btnBox.appendChild(add);
    }
    paint();

    const rand = el('input', { type: 'checkbox', checked: draft.random });
    rand.addEventListener('change', () => {
      draft.random = rand.checked;
    });
    const st = el('input', { type: 'checkbox', checked: draft.storm });
    st.addEventListener('change', () => {
      draft.storm = st.checked;
    });

    const save = actionButton({
      label: 'Save',
      variant: 'btn-primary btn-sm',
      run: async () => {
        if (!draft.text.trim()) throw new Error('text is required');
        return onSave();
      },
      onError: (err) => toast(`save failed: ${err.message}`, 'error'),
    });
    const cancel = el('button', { type: 'button', class: 'btn btn-quiet btn-sm', text: 'Cancel' });
    cancel.addEventListener('click', onCancel);

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
        cancel,
        save,
      ),
      btnBox,
    );
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') onCancel();
    });
    queueMicrotask(() => textArea.focus());
    return wrap;
  }

  /* --------------------------------------------------------------- live */

  unsubs.push(
    events.subscribe('pool', (frame) => {
      // `pools` events carry the whole `all` view: counts plus messages, on every write
      const data = frame.event === 'pools' ? frame.data : frame.cmd === 'pools' ? frame.args : null;
      if (!data) return;
      if (Array.isArray(data.messages)) {
        // a write from any client (us, the deck, the wall) → adopt the server's truth
        q.messages = data.messages;
        if (data.types) q.types = data.types;
        if (data.tags) q.tags_ = data.tags;
        if (data.counts) q.counts = data.counts;
        if (!q.loading) {
          paintTabs();
          paintChips();
          rebuildList();
        }
      } else if (data.counts) {
        q.counts = data.counts;
        paintTabs();
      }
    }),
  );

  // keep the "x ago"-less list honest on tab focus: cheap re-read when the operator returns
  const onFocus = () => loadMessages();
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
