// ShockBox admin shell — entry point (public/src/shell.js).
//
// ---------------------------------------------------------------------------
// PANE CONTRACT (stable; wall and handfx panes are written against this later)
// ---------------------------------------------------------------------------
// A module can point at a pane with `ui.pane` in its module.json (path relative to the
// module dir). The shell loads it as `/mod/<module-id>/<ui.pane>` and calls:
//
//   export async function render(container, ctx) -> (cleanup? | void)
//
//   container  an empty <div class="pane-slot"> that the pane owns. It may re-render inside
//              it at will. The shell replaces the container's content when the module changes.
//   ctx        {
//     module     the record from GET /api/modules ({id,title,settings,ui,pages,...});
//                `settings` there is the schema map ({key:{type,label,min,max,step,values,help,value}})
//                captured at pane selection — re-read it from GET /api/modules when you need fresh.
//     api        fetch wrapper from api.js: api.get/post/patch/put/del(path, body?) — every
//                call throws ApiError with .status and .message on failure, so a failed action
//                can never be rendered as a success.
//     settings   the module's settings map (same shape as module.settings) as last fetched;
//                call ctx.refresh() after a PATCH to pick up the new values.
//     events     subscribe(channelOrNull, fn) -> unsubscribe. fn gets {event, data} for
//                `event:`-style frames and {seq,channel,cmd,args,view} for command frames.
//                channel null = every channel on the one shared EventSource.
//     refresh    async () -> re-fetches /api/modules and /api/modules/:id/state; resolves to
//                {module, state} and also refreshes ctx.settings in place.
//     ui         shared helpers from ui.js: el, text, fmtWhen, settingsForm, toast, drawIcon…
//   }
//
// Returning a function from render() registers a cleanup callback for when the pane is left.
// Optional: `export const style` is unused (module styles are loaded from ui.style by the shell).
// ---------------------------------------------------------------------------

import { createApi } from './api.js';
import { el, clear, frag } from './ui.js';
import { startDrawer } from './drawer.js';
import { installToasts, toast } from './toast.js';
import { renderSettingsForm } from './settings-form.js';
import { mountMergedColumn, lookStore } from './merged-preview.js';

const api = createApi('/');
const root = document.getElementById('app');
const railList = document.getElementById('rail-list');
const paneEl = document.getElementById('pane');
const titleEl = document.getElementById('topbar-title');
const subEl = document.getElementById('topbar-sub');
const statusEl = document.getElementById('topbar-status');

/** one shared EventSource for every channel; subscribers multiplex on it */
const bus = createBus();

/**
 * The shell's own deadline for a pane's assets. A cold server or a throttled link must produce a
 * rendered pane with a named problem inside these, never an empty slot that always "looks like
 * still starting". Kept below every gate's mount timeout so a gate times out on a real failure
 * only when the check itself is wrong, not because the pane was allowed to wait forever.
 */
const STYLE_WAIT_MS = 5000;
const PANE_IMPORT_MS = 8000;
const PANE_PROBE_MS = 5000;
const MODULES_WAIT_MS = 10000;

const state = {
  modules: [],
  health: null,
  coreSettings: null,
  route: null, // {kind:'module'|'messages'|'core', id}
  current: null, // {signature, cleanup, controller}
  loadedStyles: new Map(),
  poolTypes: [],
  poolTags: [],
  poolCounts: null,
};

/* ---------------------------------------------------------------- event bus */

function createBus() {
  const subs = new Set();
  let es = null;
  let retry = 0;
  let statusCb = null;

  function dispatch(payload) {
    for (const fn of [...subs]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('event subscriber threw', err);
      }
    }
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/events');
    es.onopen = () => {
      retry = 0;
      statusCb?.('open');
    };
    es.onerror = () => {
      statusCb?.('down');
      // EventSource retries by itself; we only track the state for the status strip.
    };
    es.onmessage = () => {};
    // One listener per channel: the server names the channel in `event:`, so a named listener
    // is the only way to receive them. `hello` carries boot info; any other frame is normalised.
    const onNamed = (name) => (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data && data.reset === true) {
        dispatch({ reset: true, channel: name, data });
        return;
      }
      if (data && data.channel) dispatch(data);
      else dispatch({ event: name, channel: name, data });
    };
    es.addEventListener('hello', (ev) => {
      try {
        dispatch({ hello: true, data: JSON.parse(ev.data) });
      } catch {
        /* ignore */
      }
    });
    // Catch-all: cannot see arbitrary named events, so the shell subscribes to the channels it
    // knows about (core + every module channel from /api/modules) plus a few fixed ones.
    const names = new Set(['pool', 'core', 'notifications', 'dialogs', 'sound', 'settings', 'layout']);
    for (const m of state.modules) for (const c of m.channels || []) names.add(c);
    for (const name of names) es.addEventListener(name, onNamed(name));
    retry++;
  }

  return {
    connect,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    onStatus(fn) {
      statusCb = fn;
    },
    get connected() {
      return es ? es.readyState === 1 : false;
    },
  };
}

/* --------------------------------------------------------------------- rail */

const ICONS = {
  bell: 'M4 11a4 4 0 0 1 4-4h0a4 4 0 0 1 4 4v3l1.2 1.6H2.8L4 14zM6.6 15.6a1.6 1.6 0 0 0 2.8 0',
  window: 'M2.6 2.6h10.8v10.8H2.6zM2.6 5.4h10.8',
  wall: 'M2 3h12v10H2zM2 8h12M6 3v10M10 3v10',
  hand: 'M5 8V4.6a.9.9 0 0 1 1.8 0V8V3.6a.9.9 0 0 1 1.8 0V8V4.2a.9.9 0 0 1 1.8 0V8v-.8a.9.9 0 0 1 1.8 0v4.2a3.4 3.4 0 0 1-3.4 3.4h-.9A3.9 3.9 0 0 1 5 11z',
  list: 'M3 4h10M3 8h10M3 12h10',
  sliders: 'M3 4h10M3 12h10M6 4v3M10 12V9',
  dot: 'M8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
};

function iconSvg(name) {
  const d = ICONS[name] || ICONS.dot;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function statusTone(status) {
  if (status === 'up') return 'ok';
  if (status === 'failed') return 'bad';
  return 'warn';
}

function renderRail() {
  clear(railList);
  const items = frag();
  for (const m of state.modules) {
    const btn = el('a', { class: 'rail-item', href: `#/${m.id}` });
    btn.dataset.id = m.id;
    btn.dataset.status = statusTone(m.status);
    const ic = el('span', { class: 'rail-icon' });
    ic.appendChild(iconSvg(m.icon || 'dot'));
    const label = el('span', { class: 'rail-text' });
    label.appendChild(el('span', { class: 'rail-title', text: m.title || m.id }));
    label.appendChild(el('span', { class: 'rail-id mono', text: m.id }));
    const dot = el('span', { class: 'dot', 'data-tone': statusTone(m.status) });
    btn.append(ic, label, dot);
    btn.title = m.status === 'up' ? `${m.title} — up${m.version ? ` v${m.version}` : ''}` : `${m.title} — ${m.status}${m.error ? `: ${m.error}` : ''}`;
    if (m.status === 'failed') btn.setAttribute('aria-description', m.error || 'failed');
    items.appendChild(btn);
  }
  // Messages is a core pane, not a module: it sits below the module rows, set apart.
  const divider = el('div', { class: 'rail-sep', role: 'separator' });
  const msg = el('a', { class: 'rail-item rail-item-core', href: '#/messages' });
  msg.dataset.id = 'messages';
  const ic = el('span', { class: 'rail-icon' });
  ic.appendChild(iconSvg('list'));
  const label = el('span', { class: 'rail-text' });
  label.appendChild(el('span', { class: 'rail-title', text: 'Messages' }));
  label.appendChild(el('span', { class: 'rail-id mono', text: 'pool' }));
  const count = el('span', { class: 'rail-count mono', id: 'rail-pool-count', text: state.poolCounts ? String(state.poolCounts.all ?? 0) : '–' });
  msg.append(ic, label, count);
  msg.title = 'Shared message pool (used by notifications and alerts)';
  items.append(divider, msg);
  railList.appendChild(items);
  markActiveRail();
}

function markActiveRail() {
  const id = state.route ? state.route.id : null;
  for (const a of railList.querySelectorAll('.rail-item')) {
    a.classList.toggle('is-active', a.dataset.id === id);
    if (a.dataset.id === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/* ------------------------------------------------------------------- router */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const id = decodeURIComponent(pathPart || '').trim();
  const params = new URLSearchParams(query);
  if (!id) return { kind: 'module', id: null, params };
  if (id === 'messages') return { kind: 'messages', id: 'messages', params };
  return { kind: 'module', id, params };
}

async function navigate() {
  const route = parseHash();
  state.route = route;
  markActiveRail();

  if (!route.id) {
    // Pick the first up module, else Messages.
    const first = state.modules.find((m) => m.status === 'up') || state.modules[0];
    const target = first ? first.id : 'messages';
    if (location.hash !== `#/${target}`) {
      location.replace(`#/${target}`);
      return;
    }
  }

  const signature = route.kind === 'messages' ? 'messages' : `module:${route.id}`;
  // the merged column follows the pane until the operator picks a module in the column itself
  merged?.followRoute(route.id);
  if (state.current && state.current.signature === signature) return;

  // tear down the previous pane
  if (state.current) {
    try {
      state.current.cleanup?.();
    } catch (err) {
      console.error('pane cleanup failed', err);
    }
    state.current.controller?.abort();
    state.current = null;
  }

  const controller = new AbortController();
  const slot = el('div', { class: 'pane-slot', id: 'pane-slot' });
  clear(paneEl);
  // The pane is never an empty box: it says what it is waiting for, and carries a door-bell so a
  // diagnostic can see what the shell is doing instead of inferring it from an empty DOM.
  const loading = el('div', { class: 'pane-loading', 'data-pane-loading': signature },
    el('div', { class: 'fallback-note' },
      el('span', { class: 'dot', 'data-tone': 'warn' }),
      el('span', { text: `loading ${route.kind === 'messages' ? 'messages' : route.id}…` }),
    ),
  );
  paneEl.append(loading, slot);
  state.current = { signature, controller, cleanup: null, loading };
  window.__shell = { ready: true, route: signature, phase: 'loading', since: Date.now(), notes: [] };

  try {
    if (route.kind === 'messages') {
      titleEl.textContent = 'Messages';
      subEl.textContent = 'shared pool';
      statusEl.replaceChildren();
      const mod = await import('./panes/messages.js');
      const cleanup = await mod.render(slot, makeCtx({ id: 'messages', title: 'Messages', settings: {} }, null, controller.signal));
      if (state.current?.signature === signature) state.current.cleanup = cleanup || null;
      return;
    }

    const m = state.modules.find((x) => x.id === route.id);
    if (!m) {
      titleEl.textContent = route.id || 'unknown';
      subEl.textContent = '';
      slot.appendChild(notFoundPane(route.id));
      return;
    }
    titleEl.textContent = m.title || m.id;
    subEl.replaceChildren(
      el('span', { class: 'mono', text: m.id }),
      m.version ? el('span', { class: 'mono dim', text: `v${m.version}` }) : el('span', { class: 'dim', text: '' }),
      el('span', { class: 'dot', 'data-tone': statusTone(m.status) }),
    );
    renderPanes(m, slot, controller.signal, signature);
  } catch (err) {
    titleEl.textContent = 'error';
    clear(paneEl);
    paneEl.appendChild(errorPane(err));
  }
}

async function renderPanes(m, slot, signal, signature) {
  // Whichever way this exits, the loading note goes: from here on the slot owns the screen.
  const finish = (phase, noteList = []) => {
    if (state.current?.signature === signature) {
      state.current.loading?.remove();
      window.__shell = { ...(window.__shell || {}), phase, route: signature, notes: noteList, mountedAt: Date.now() };
    }
  };
  if (m.status !== 'up') {
    slot.appendChild(failedModulePane(m));
    finish('failed-module', [`module status is ${m.status}`]);
    return;
  }
  // A module's own `ui.pane` is the only pane for it. The shell keeps a generic settings pane
  // for a module that declares none, and never a second implementation of the same screen: a
  // hardcoded map outranked the module's pane and kept two of them alive unnoticed.
  const notes = [];
  let mod = null;
  let source = null;
  if (m.ui && m.ui.pane) {
    const panePath = `/mod/${m.id}/${m.ui.pane.replace(/^\/+/, '')}`;
    // Neither request is allowed to hold the pane hostage: a cold server or a throttled link
    // must end in a rendered pane with a named problem, never an empty slot forever.
    if (await paneExists(panePath)) {
      try {
        mod = await withDeadline(import(/* @vite-ignore */ panePath), PANE_IMPORT_MS, `import ${panePath}`);
        source = m.ui.pane;
      } catch (err) {
        console.error(`module pane ${m.ui.pane} failed to load`, err);
        notes.push(`the pane module ${m.ui.pane} did not load (${err.message}) — showing the settings pane`);
        mod = null;
      }
      if (mod) {
        const style = await loadStyleFor(m);
        if (style.ok) {
          // The pane's own sheet is up; the loading line has done its job.
        } else {
          notes.push(style.why);
        }
      }
    } else {
      notes.push(`the pane module ${m.ui.pane} is not served — showing the settings pane`);
    }
  }
  if (!mod) {
    const fallback = await import('./panes/generic.js');
    mod = fallback;
    source = 'fallback';
  }
  if (signal.aborted) return;
  try {
    const cleanup = await mod.render(slot, makeCtx(m, source, signal));
    finish(source === 'fallback' ? 'fallback' : 'mounted', notes);
    for (const note of notes) {
      slot.prepend(
        el('div', { class: 'fallback-note', 'data-note': 'pane-partial' },
          el('span', { class: 'dot', 'data-tone': 'warn' }),
          el('span', { text: note }),
        ),
      );
    }
    if (state.current?.signature === signature && typeof cleanup === 'function') state.current.cleanup = cleanup;
  } catch (err) {
    console.error('pane render failed', err);
    finish('render-error', [err.message]);
    clear(slot);
    slot.appendChild(errorPane(err, `pane for ${m.id} (${source})`));
  }
}

/** Resolve a promise or fail it after `ms`. A gate that can hang forever is a blank shell. */
function withDeadline(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}

/** A module's ui.pane is only imported when the file is actually served: modules declare the
 *  path before the file exists (wall, handfx), and an import of a 404 surfaces as a console
 *  error that looks like a broken shell. */
async function paneExists(path) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(path, { method, headers: { accept: 'text/javascript' }, signal: AbortSignal.timeout(PANE_PROBE_MS) });
      if (res.ok) return true;
      if (res.status !== 405) return false;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Load a module's pane stylesheet. The <link> is not allowed to gate the pane forever: when the
 * request stalls, the pane renders unstyled and says so. Returns 'ok' | 'missing' | 'timed out '.
 */
async function loadStyleFor(m) {
  if (!m.ui || !m.ui.style) return { ok: true };
  const href = `/mod/${m.id}/${m.ui.style.replace(/^\/+/, '')}`;
  if (state.loadedStyles.get(href) === 'ok') return { ok: true };
  state.loadedStyles.set(href, 'loading');
  return await new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    const settle = (outcome) => {
      clearTimeout(timer);
      link.onload = null;
      link.onerror = null;
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      state.loadedStyles.delete(href);
      console.warn(`pane style still loading after ${STYLE_WAIT_MS} ms: ${href} — rendering without it`);
      // A stalled stylesheet would still paint whenever it eventually arrived, contradicting what
      // the pane says. Drop the request: what is on screen is what is loaded.
      link.remove();
      resolve({ ok: false, why: `the pane stylesheet ${m.ui.style} did not arrive within ${STYLE_WAIT_MS / 1000} s — the pane is rendered unstyled` });
    }, STYLE_WAIT_MS);
    link.onload = () => {
      state.loadedStyles.set(href, 'ok');
      settle({ ok: true });
    };
    link.onerror = () => {
      state.loadedStyles.delete(href);
      console.warn(`pane style failed to load: ${href}`);
      settle({ ok: false, why: `the pane stylesheet ${m.ui.style} failed to load — the pane is rendered unstyled` });
    };
    document.head.appendChild(link);
  });
}

/* ---------------------------------------------------------------- pane ctx */

function makeCtx(m, source, signal) {
  const events = {
    subscribe(channel, fn) {
      return bus.subscribe((p) => {
        if (channel && p.channel && p.channel !== channel) return;
        fn(p);
      });
    },
  };
  const ctx = {
    module: m,
    api,
    settings: { ...(m.settings || {}) },
    events,
    signal,
    refresh: async () => {
      const mods = await api.get('/api/modules');
      const fresh = (mods.modules || []).find((x) => x.id === m.id);
      if (fresh) {
        m.settings = fresh.settings || {};
        m.status = fresh.status;
        ctx.settings = { ...m.settings };
        Object.assign(m, fresh);
      }
      let st = null;
      try {
        const r = await api.get(`/api/modules/${encodeURIComponent(m.id)}/state`);
        st = r.state;
      } catch {
        st = null; // a module may legitimately have no state endpoint
      }
      return { module: m, state: st };
    },
    renderSettings: (container, opts = {}) =>
      renderSettingsForm(container, {
        settings: opts.settings || ctx.settings,
        signal,
        onSave: async (patch) => {
          const out = await api.patch(`/api/${m.id}/settings`, patch);
          if (out && out.settings) {
            ctx.settings = { ...out.settings };
            m.settings = out.settings;
          }
          return out;
        },
      }),
    paneSource: source,

    // The merged preview column's shared look (see merged-preview.js). A pane that wants the
    // same look the column shows reads it here instead of keeping a copy that cannot change
    // when another pane changes it; `subscribe` tells the pane when that module's look moved.
    sharedLook: {
      get: (id = m.id) => lookStore.get(id),
      // publish: the pane's own read of the look becomes the store's, which the column paints from
      set: (patch, id = m.id) => lookStore.set(id, patch),
      subscribe: (fn) => lookStore.subscribe((id, look) => fn(id, look)),
      // read the server back into the store: how a change made by ANOTHER view (the column's own
      // controls, a deck key) reaches this pane without the pane keeping a second copy
      sync: () => lookStore.sync(),
    },

    // Shared quick-send helpers. Each module only provides `kinds` and the three callbacks;
    // the box handles search, tags, picking, composer, and the send/schedule split.
    quickSend: {
      // The dialogs pool holds dialogs and alerts alike (an alert is a dialog with an icon), so
      // the pane's box reads that whole pool rather than guessing at a separate kind.
      kinds: (moduleId) => {
        if (moduleId === 'wall') return ['wall'];
        if (moduleId === 'dialogs') return ['dialog'];
        return ['notification'];
      },
      poolId: (moduleId) => (moduleId === 'wall' ? 'wall' : moduleId),
      async send(moduleId, payload) {
        if (moduleId === 'wall') return api.post('/api/wall/cmd', { cmd: 'text.send', args: { text: payload.text, kind: payload.kind || 'wall', ...(payload.poolId ? { poolId: payload.poolId } : {}) } });
        if (moduleId === 'dialogs') return api.post('/api/dialogs/live', payload);
        return api.post('/api/notifications/live', payload);
      },
      async schedule(moduleId, payload) {
        return api.post('/api/schedules', { module: moduleId, ...payload });
      },
      async save(moduleId, payload) {
        // pool messages are created inside their own pool route, so the module maps to a pool id
        const poolId = moduleId === 'wall' ? 'wall' : moduleId;
        return api.post(`/api/pool/${poolId}/messages`, payload);
      },
    },

    // Schedule listing lives on the module's own panel (the box only books). This helper is
    // for that panel to call.
    schedules: {
      async list(moduleId, pending) {
        const q = new URLSearchParams();
        if (moduleId) q.set('module', moduleId);
        if (pending) q.set('pending', '1');
        return api.get(`/api/schedules?${q}`);
      },
      async runNow(id) {
        return api.post(`/api/schedules/${encodeURIComponent(id)}/run`);
      },
      async cancel(id) {
        return api.del(`/api/schedules/${encodeURIComponent(id)}`);
      },
    },
  };
  return ctx;
}

/* ---------------------------------------------------------------- fragments */

function notFoundPane(id) {
  const box = el('div', { class: 'pane-slot' });
  box.append(
    el('div', { class: 'fallback-note' },
      el('span', { class: 'dot', 'data-tone': 'warn' }),
      el('span', {}, el('strong', { text: 'No module at this address. ' }),
        el('span', { text: `${id || 'The hash is empty'}. The rail comes from GET /api/modules — pick a module there.` })),
    ),
  );
  return box;
}

function failedModulePane(m) {
  const box = el('div', { class: 'pane-slot' });
  box.append(
    el('div', { class: 'pane-head' },
      el('div', { class: 'pane-title-wrap' },
        el('h1', { class: 'pane-title', text: `${m.title || m.id} failed to load` }),
        el('p', { class: 'pane-desc', text: 'The module threw while the server was loading it. Every other module stays up.' }),
      ),
      el('div', { class: 'pane-head-status' }, el('span', { class: 'dot', 'data-tone': 'bad' }), el('span', { text: 'failed' })),
    ),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'error' })),
      el('pre', { class: 'state-pre', text: m.error || 'no error message reported' }),
    ),
    el('div', { class: 'control-bar' },
      el('button', { class: 'btn', type: 'button', text: 'Reload page', onclick: () => location.reload() }),
      el('span', { class: 'control-hint', text: 'fix it on disk, restart the server, then reload' }),
    ),
  );
  return box;
}

function errorPane(err, what) {
  const box = el('div', { class: 'pane-slot' });
  box.append(
    el('div', { class: 'pane-head' },
      el('div', { class: 'pane-title-wrap' },
        el('h1', { class: 'pane-title', text: what || 'Something went wrong' }),
      ),
      el('div', { class: 'pane-head-status' }, el('span', { class: 'dot', 'data-tone': 'bad' }), el('span', { text: 'error' })),
    ),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'detail' })),
      el('pre', { class: 'state-pre', text: err?.stack || err?.message || String(err) }),
    ),
    el('div', { class: 'control-bar' },
      el('button', { class: 'btn', type: 'button', text: 'Retry', onclick: () => location.reload() }),
    ),
  );
  return box;
}

/* --------------------------------------------------------- merged preview */

let merged = null;

/**
 * Mount the merged preview column between the rail and the pane, once for the life of the page.
 *
 * Choosing a module in the column is a selection, not a navigation: the operator is watching all
 * four while working on one, so clicking a chip must not yank the pane away from under a half-typed
 * form. What it does do is make that module the one the column drives.
 */
function mountMerged() {
  if (merged) return merged;
  // The column is its own grid cell between the rail and <main>: inserting it into the grid is
  // the mount, so the column's root element is the cell and nothing wraps it.
  const marker = el('div', { class: 'merged-host', id: 'merged-host', hidden: true });
  const main = document.getElementById('main');
  root.insertBefore(marker, main || null);
  // The column's root replaces its host's slot in the grid: it IS the grid child, so the host
  // must not wrap it (and must not stay in the grid as an empty track either).
  marker.remove();
  merged = mountMergedColumn(marker, {
    api,
    bus,
    onSelect: (id) => {
      // a second click on the selected card is that module's primary action; nothing else to do
      window.__shell = { ...(window.__shell || {}), mergedSelected: id };
    },
  });
  merged.start();
  window.__merged = merged;
  return merged;
}

/* -------------------------------------------------------------- top status */

function renderTopStatus() {
  const h = state.health;
  statusEl.replaceChildren();
  if (!h) return;
  const up = Object.values(h.modules || {}).filter((s) => s === 'up').length;
  const total = Object.keys(h.modules || {}).length;
  const failed = total - up;
  statusEl.append(
    el('span', { class: 'chip', title: 'Modules up' },
      el('span', { class: 'dot', 'data-tone': failed ? 'warn' : 'ok' }),
      el('span', { class: 'mono', text: `${up}/${total}` }),
      el('span', { class: 'chip-label', text: failed ? `mods · ${failed} failed` : 'modules' }),
    ),
    el('span', { class: 'chip', title: 'SSE stream state' },
      el('span', { class: 'dot', 'data-tone': bus.connected ? 'ok' : 'bad', id: 'sse-dot' }),
      el('span', { class: 'chip-label', id: 'sse-label', text: bus.connected ? 'live' : 'reconnecting' }),
    ),
    el('span', { class: 'chip', title: 'OBS websocket state' },
      el('span', { class: 'dot', 'data-tone': h.obs?.state === 'open' || h.obs?.state === 'connected' ? 'ok' : h.obs?.state === 'off' ? 'idle' : 'warn' }),
      el('span', { class: 'chip-label', text: 'obs' }),
      el('span', { class: 'mono dim', text: h.obs?.state || 'off' }),
      h.obs?.scene ? el('span', { class: 'mono', text: h.obs.scene }) : '',
    ),
    el('span', { class: 'chip', title: 'Uptime' },
      el('span', { class: 'chip-label', text: 'up' }),
      el('span', { class: 'mono', text: fmtUptime(h.uptime) }),
    ),
  );
}

function updateSseStatus() {
  const dot = document.getElementById('sse-dot');
  const label = document.getElementById('sse-label');
  if (dot) dot.dataset.tone = bus.connected ? 'ok' : 'bad';
  if (label) label.textContent = bus.connected ? 'live' : 'reconnecting';
}

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/* -------------------------------------------------------------------- boot */

async function loadModules() {
  const r = await api.get('/api/modules');
  state.modules = r.modules || [];
}

async function loadPoolMeta() {
  try {
    const r = await api.get('/api/pools');
    state.poolTypes = r.types || [];
    state.poolTags = r.tags || [];
    state.poolCounts = r.counts || null;
    const c = document.getElementById('rail-pool-count');
    if (c && r.counts) c.textContent = String(r.counts.all ?? 0);
  } catch {
    /* the pool pane reports its own errors */
  }
}

async function loadHealth() {
  try {
    state.health = await api.get('/health');
    renderTopStatus();
  } catch (err) {
    statusEl.replaceChildren(el('span', { class: 'chip' },
      el('span', { class: 'dot', 'data-tone': 'bad' }), el('span', { class: 'chip-label', text: 'server unreachable' })));
  }
}

function wireDrawer() {
  const drawer = document.getElementById('drawer');
  const toggle = document.getElementById('drawer-toggle');
  const close = document.getElementById('drawer-close');
  const setOpen = (open) => {
    drawer.dataset.open = open ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('is-on', open);
    root.dataset.drawer = open ? 'open' : 'closed';
    if (open) drawer.start?.();
    else drawer.stop?.();
  };
  const onToggle = () => setOpen(drawer.dataset.open !== 'true');
  toggle.addEventListener('click', onToggle);
  close.addEventListener('click', () => setOpen(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onToggle();
    }
    if (e.key === 'Escape' && drawer.dataset.open === 'true') setOpen(false);
  });
  const ctl = startDrawer({
    api,
    bus,
    onHealth: (h) => {
      state.health = h;
      renderTopStatus();
      updateSseStatus();
    },
  });
  drawer.start = ctl.start;
  drawer.stop = ctl.stop;
  setOpen(false);
  return ctl;
}

async function boot() {
  window.__shell = { ready: false, phase: 'boot', since: Date.now(), notes: [] };
  installToasts(document.getElementById('toasts'));
  wireDrawer();
  // The merged preview column is mounted before any pane: it belongs to every route, it must be
  // in the grid on the first frame, and a pane render must never be what creates (or destroys)
  // it. It is a sibling of the rail and the main column, inside the app grid.
  mountMerged();
  bus.onStatus((s) => {
    updateSseStatus();
    if (s === 'open') {
      // re-sync the open pane after a reconnect
      state.current && navigate(true);
    }
  });

  try {
    await withDeadline(loadModules(), MODULES_WAIT_MS, 'GET /api/modules');
  } catch (err) {
    console.error('modules failed to load', err);
    clear(paneEl);
    paneEl.appendChild(errorPane(err, 'Could not load /api/modules'));
    window.__shell = { ...window.__shell, phase: 'no-modules', notes: [err.message] };
    return;
  }
  renderRail();
  bus.connect();
  loadPoolMeta();
  loadHealth();
  setInterval(loadHealth, 5000);

  // pool changes update the rail count only; the Messages pane listens itself
  bus.subscribe((p) => {
    if (p.channel === 'pool') {
      loadPoolMeta();
    }
  });

  window.addEventListener('hashchange', () => navigate());
  await navigate();
}

boot().catch((err) => {
  console.error(err);
  window.__shell = { ...(window.__shell || {}), phase: 'boot-failed', notes: [err.message] };
  toast(`shell failed to start: ${err.message}`, 'error');
});
