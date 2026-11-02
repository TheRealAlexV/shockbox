// The merged preview column: every module's effect side by side, in one column, on every route.
//
// Why a column and not a second screen: the operator works one module at a time and still has to
// see what the other three would draw right now. A tab would hide three of them; this column is
// always there, between the rail and the pane, and its right border drags.
//
// What a slot is: the SAME component each module pane uses (`mountPreview`), fed by the same
// numbers. Nothing here reimplements a module's effect. Where one module's own preview is a
// canvas (hand fx) the canvas is moved into the slot rather than drawn a second time: the module
// owns the pixels, this column owns the place to put them.
//
// Data, per module, from the server (never from a module pane, which may not be mounted at all):
//   GET /api/wall/live                  settings.look, render.look, render.presets, ratio, fence
//   GET /api/dialogs/live               settings, live[]
//   GET /api/notifications/live         settings, live[]
//   GET /api/handfx/status              settings, effects, live, page
// All four are polled on one timer and refreshed at once when the bus says one changed.
//
// Look is per module and lives HERE (see `lookStore`): one object per module, the same object the
// module's own pane paints from when it happens to be open. That is the smallest shared-state
// change that stops the divergence, and it leaves every module pane's own code alone.

import { el, clear } from '/src/ui.js';
import { mountPreview } from '/src/preview.js';

/** The four modules, in the order the wall's own stack draws them (wall first, overlays on top). */
export const MODULES = [
  { id: 'wall', title: 'Wall', hint: 'full picture' },
  { id: 'handfx', title: 'Hand FX', hint: 'hand overlay' },
  { id: 'dialogs', title: 'Dialogs', hint: 'phone strip' },
  { id: 'notifications', title: 'Notifs', hint: 'toast strip' },
];

/* The wall's palettes, mirrored from the engine: `look.palette` names a ramp and the wall pane
 * draws from the same table. Kept here so the column paints with no pane open. */
const WALL_PALETTES = {
  synthwave: ['#7b2ff7', '#c026d3', '#ff2d95'],
  arctic: ['#9fb8d8', '#e6fbff', '#3a86ff'],
  lava: ['#8c0f00', '#e01b00', '#ff8c1a'],
  neonwave: ['#00f5d4', '#3a86ff', '#ff2d95'],
  ember: ['#b80000', '#ff3c00', '#ffd166'],
  candy: ['#ff5ec4', '#6f5bff', '#7bffd4'],
  mono: ['#ffffff', '#c8dcff', '#9fb8d8'],
};
const DEFAULT_PALETTE = 'neonwave';

/** The notification strip's canvas, from the module's own state (state.mjs CANVAS_W/H). */
const NT_W = 405;
const NT_H = 720;
const DG_CANVAS_W = 810;
const DG_CANVAS_H = 1440;

const STORAGE_KEY = 'shockbox.merged.width';
const MIN_W = 240;
// A share of the viewport, not a constant: the pane needs ~520px to stay laid out, and the
// column must never be the reason the 1024px layout overflows.
const MAX_SHARE = 0.46;
const DEFAULT_W = 396;
const NARROW_VP = 900; // below this the column is a strip, and the panes get the width
const RAIL_W = 184; // the rail's own track (shell.css --rail-w)
const MIN_PANE_W = 520; // what a module pane needs for its two-column layout

/**
 * `mountPreview` needs a browser. A gate imports this module in Node to read the store, and its
 * data path is `fetch`, which exists there: no DOM means no column and no painting, but the store
 * still fills. Declared at module scope so every branch — including the width path that runs
 * before the column exists — can ask.
 */
function hasDom() {
  return typeof document !== 'undefined';
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clean(v) {
  return typeof v === 'string' && v && v !== 'default' ? v : '';
}

/* ---------------------------------------------------------------- look store */

/**
 * One look per module, owned here and shared with whoever else wants it.
 *
 * Tradeoff, stated plainly: the four module panes each keep a module-local `look` today, and a
 * change in one does not reach another. The alternatives were (a) a fetch per module for every
 * pane that wants the look, which duplicates the wall's palette table in four places, or (b) one
 * store the shell owns and every pane reads. (b) is smaller and it is what this is: a plain
 * object per module, plus a subscribe. A pane that adopts it reads `get(id)` where it read its
 * local copy; a pane that does not still works, because the store is filled from the server and
 * the column never depends on a pane. The store is also the one place that knows which palette
 * is live, since `look.palette` is a page command the settings document never records.
 */
export const lookStore = (() => {
  const state = {
    wall: { palette: DEFAULT_PALETTE, brightness: 1, saturation: 1, speed: 1, pattern: 'wave', preset: '', blackout: false, fence: null, ratio: null, fenceOutDim: 0.18 },
    dialogs: { theme: 'win11', scale: 0.7 },
    notifications: { style: 'ios', height: 76 },
    handfx: { effect: '', skins: {} },
  };
  const subs = new Set();
  // The store only sees its own writes; a palette change made by another view reaches it through
  // `lookStore.sync`, which the column sets to a reader of the wall's live document.
  const hooks = { sync: null };
  function emit(id) {
    for (const fn of subs) {
      try {
        fn(id, state[id]);
      } catch (err) {
        console.error('merged-preview look subscriber threw', err);
      }
    }
  }
  return {
    /** A module's whole look, as a snapshot (callers never get the live object to mutate). */
    get(id) {
      return { ...(state[id] || {}) };
    },
    /**
     * Read the wall's live document and merge in what it says about the look.
     *
     * The store cannot see another view's command, and only the SERVER's state answers what the
     * wall is running (the settings document does not hold `palette`; the page's report does).
     * Whoever owns a writer sets this once — the column sets it to `loadLook('wall')`.
     */
    async sync() {
      if (typeof hooks.sync === 'function') return hooks.sync();
      return lookStore.get('wall');
    },
    /** Install the reader behind `sync` (the column does this at mount). */
    setSync(fn) {
      hooks.sync = fn;
    },
    /** Merge a partial change; only the keys given repaint. */
    set(id, patch) {
      if (!state[id] || !patch) return;
      let changed = false;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (state[id][k] !== v) {
          state[id][k] = v;
          changed = true;
        }
      }
      if (changed) emit(id);
    },
    /** The CSS colour ramp for the wall's current palette name (or a palette array as given). */
    wallPalette(name) {
      const key = clean(name) || DEFAULT_PALETTE;
      return WALL_PALETTES[key] || WALL_PALETTES[DEFAULT_PALETTE];
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
})();

/* ---------------------------------------------------------------- module data */

/**
 * Read one module's look from the server into `lookStore`, with no column and no DOM.
 *
 * This is the store's own data path, exposed so a view that wants the merged look (a module pane,
 * a test) can refresh it without mounting the column. A module's pane that adopts the shared look
 * calls this on mount, which is also what removes the "each pane has its own `look`" divergence:
 * one reader fills, every reader reads.
 */
export async function loadLook(id, { api, signal } = {}) {
  if (api) LOOK_API = api;
  if (!LOOK_API) {
    const { createApi } = await import('./api.js');
    LOOK_API = createApi('/');
  }
  const call = (p) => LOOK_API.get(p, signal ? { signal } : undefined);
  if (id === 'wall') {
    const r = (await call('/api/wall/live')) || {};
    const look = { ...((r.render && r.render.look) || {}), ...((r.settings && r.settings.look) || {}) };
    lookStore.set('wall', {
      palette: clean(look.palette) || clean(r.look && r.look.palette) || lookStore.get('wall').palette,
      // the document is the wall's own look and wins: it is what the page persists, and it is the
      // one both readers (this column and the pane) write back after a command
      pattern: clean(look.pattern) || lookStore.get('wall').pattern,
      preset: clean(look.preset) || lookStore.get('wall').preset,
      brightness: num(look.brightness, 1),
      saturation: num(look.saturation, 1),
      speed: num(look.speed, 1),
      blackout: num(look.blackout, 0) > 0,
      fenceOutDim: num(look.fenceOutDim, 0.18),
      ratio: (r.ratio && r.ratio.selected) || lookStore.get('wall').ratio,
      fence: (r.render && r.render.fence) || (r.fence && r.fence.px) || lookStore.get('wall').fence,
    });
  } else if (id === 'dialogs' || id === 'notifications') {
    const r = (await call(`/api/${id}/live`)) || {};
    const meta = r.settings || {};
    if (id === 'dialogs') {
      lookStore.set('dialogs', { theme: String((meta.theme && meta.theme.value) || 'win11'), scale: num(meta.scale && meta.scale.value, 0.7) });
    } else {
      lookStore.set('notifications', {
        style: String((meta.style && meta.style.value) || 'ios'),
        height: num(meta.height && meta.height.value, 76),
      });
    }
  } else if (id === 'handfx') {
    const r = (await call('/api/handfx/status')) || {};
    const page = r.pageStatus || r.page || null;
    lookStore.set('handfx', { tracking: Boolean(page && page.tracking) });
  }
  return lookStore.get(id);
}

/** The api the store's own reads go through; the shell hands its own in on mount. */
let LOOK_API = null;
export function setLookApi(api) {
  LOOK_API = api;
}

/* ---------------------------------------------------------------- the column */

/**
 * Mount the column into `host` (the shell's body, right after the rail).
 *
 * @param {HTMLElement} host
 * @param {object} opts { api, bus, onSelect }
 * @returns {{ el: HTMLElement, select(id), width, destroy() }}
 */
export function mountMergedColumn(host, opts = {}) {
  const { api, bus } = opts;
  const signal = opts.signal || new AbortController().signal;
  const timers = [];
  let destroyed = false;

  const dead = () => destroyed || signal.aborted;

  /* ------------------------------------------------------------ width */

  const storedW = (() => {
    try {
      const n = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  })();
  // The ceiling is a share of the viewport AND a floor on what the pane keeps: the pane's own
  // two-column layout needs ~520px, so the column gives way before it does. At 1024 that is 324px,
  // which is still two slots wide; below `NARROW_VP` the column goes to a strip and the pane wins.
  const maxW = () => {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1440;
    const share = Math.round(vw * MAX_SHARE);
    const keepPane = vw - RAIL_W - MIN_PANE_W;
    return clamp(Math.min(share, keepPane), MIN_W, 720);
  };
  let width = clamp(storedW || DEFAULT_W, MIN_W, maxW());

  // A gate imports this module in Node to read `lookStore` and its fetch path. No DOM means no
  // column, no slots and no painting — the store is the whole product there.
  if (!hasDom()) return headlessColumn();

  function headlessColumn() {
    return {
      el: null,
      select: () => {},
      get width() {
        return width;
      },
      followRoute: () => {},
      start() {
        // the data path runs without a DOM: `lookStore` must fill from the server either way
        void loadAll();
        schedulePoll();
      },
      destroy() {
        destroyed = true;
        clearTimeout(pollTimer);
      },
      /** Read one module now, resolving once its fetch landed (a gate waits on this). */
      load(id) {
        return loadLook(id, { api });
      },
    };
  }

  // The published width, kept on the app root: the `.app` grid reads `--merged-w` from here, and
  // a custom property that is used is one Chrome must recompute the grid for on every write.
  const appRoot = (typeof document !== 'undefined' && document.getElementById('app')) || null;
  function publishWidth() {
    const v = `${width}px`;
    column.style.setProperty('--merged-w', v);
    host.style.setProperty('--merged-w', v);
    appRoot?.style.setProperty('--merged-w', v);
  }

  const column = el('aside', {
    class: 'merged',
    id: 'merged',
    'aria-label': 'Merged preview',
    'data-compact': 'false',
    // The column is a shell layout element, and it must own its width on frame one: a stylesheet
    // that has not landed yet (a cold load, a gate that navigates at once) would otherwise let the
    // empty `aside` take the `1fr` track and push <main> to zero. The custom property is the only
    // thing the grid needs, so it is written inline and the rest of the look is the sheet's.
    style: { '--merged-w': `${width}px` },
  });
  const head = el('div', { class: 'merged-head panel-head' },
    el('span', { class: 'panel-title', text: 'All modules' }),
    el('span', { class: 'panel-hint mono dim merged-hint', text: 'live' }),
  );
  const chips = el('div', { class: 'pv-chips merged-chips' });
  head.append(chips);

  const stack = el('div', { class: 'merged-stack' });
  const stage = el('div', { class: 'merged-stage' }, stack);
  // The resizer is a real focusable separator: a mouse can drag it, a keyboard can nudge it, and
  // a screen reader says what it is. Its hit area is wider than its hairline.
  const resizer = el('div', {
    class: 'merged-resize',
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the merged preview column',
    title: 'Drag to resize · double-click to reset',
  });
  const scroll = el('div', { class: 'merged-scroll' });
  column.append(head, scroll, resizer);
  scroll.append(stage);
  // the column (`aside.merged`) IS the grid cell between the rail and <main>, so it carries no
  // wrapper. It takes the slot the shell reserved for it — before `#main`, not after the drawer:
  // a grid item's source order puts it in the track it lands in, and appended last it would be
  // placed in the drawer's track and clipped to zero width.
  const app = document.getElementById('app') || (host && host.parentElement);
  if (host && host.isConnected) host.remove();
  const mainEl = document.getElementById('main');
  if (app && mainEl) app.insertBefore(column, mainEl);
  else if (app) app.appendChild(column);
  // the grid track is right on frame one, not after the four fetches land
  publishWidth();

  /** The width, clamped to the viewport share so a stored 700px cannot overflow a 1024 window. */
  function applyWidth(w, { persist = true } = {}) {
    width = clamp(Math.round(w), MIN_W, maxW());
    publishWidth();
    column.dataset.width = String(width);
    column.dataset.compact = width < 320 ? 'true' : 'false';
    resizer.setAttribute('aria-valuenow', String(width));
    resizer.setAttribute('aria-valuemin', String(MIN_W));
    resizer.setAttribute('aria-valuemax', String(maxW()));
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, String(width));
      } catch {
        /* private mode: the width holds for this page only */
      }
    }
    // every slot is laid out from the column, so a resize is one relayout of four frames
    for (const slot of slots.values()) slot.pv?.layout?.();
  }

  /* ------------------------------------------------------------ slots */

  const slots = new Map();
  const order = opts.modules || MODULES;
  let selected = null;
  // until the operator picks a module itself, the column follows the route's pane
  let picked = false;

  function buildSlot(m) {
    // The placeholder is what the slot shows until `start()` mounts the component: four wrapped
    // component mounts on the frame the shell boots is the one thing this column must not do,
    // and a mount before the track width is known lays out every frame twice.
    const placeholder = el('div', { class: 'mp-pp mp-pp-pending' });
    const body = el('div', { class: 'mp-body' }, placeholder);
    const label = el('div', { class: 'mp-label' },
      el('span', { class: 'mp-name mono', text: m.title }),
      el('span', { class: 'mp-state mono dim', text: '…' }),
    );
    const slot = el('div', { class: 'pv-slot mp-slot', 'data-module': m.id, tabindex: '0', role: 'group' }, label, body);
    slot.style.setProperty('--mp-id', String(['--accent', '--ok', '--warn', '--info'].indexOf('') || 0));

    // Clicking the slot selects the module: its chip presses, its controls show, and it becomes
    // the one a keyboard Enter acts on. A second click on the selected slot is the module's own
    // primary action (send / fire), so watching and driving are one gesture apart.
    slot.addEventListener('click', (e) => {
      if (e.target.closest('.mp-controls')) return; // the controls act for themselves
      if (selected === m.id) slotAction(m.id);
      else select(m.id);
    });
    slot.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target !== slot) return;
        e.preventDefault();
        if (selected === m.id) slotAction(m.id);
        else select(m.id);
      }
    });

    // The per-module controls: reusing what each module already exposes means sending the same
    // command its pane sends, from the same API — not a second implementation of the module.
    const controls = el('div', { class: 'mp-controls' });
    if (m.id === 'wall') {
      controls.append(
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'pattern-next', text: 'pattern ›', title: 'Next pattern' }),
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'palette-next', text: 'palette ›', title: 'Next palette' }),
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'blackout', text: 'blackout', title: 'Toggle blackout' }),
      );
    } else if (m.id === 'dialogs') {
      controls.append(
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'send', text: 'send', title: 'Spawn a dialog' }),
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'clear', text: 'clear', title: 'Close every dialog' }),
      );
    } else if (m.id === 'notifications') {
      controls.append(
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'send', text: 'send', title: 'Send a notification' }),
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'clear', text: 'clear', title: 'Clear the strip' }),
      );
    } else if (m.id === 'handfx') {
      controls.append(
        el('button', { type: 'button', class: 'btn btn-sm mp-c', 'data-act': 'effect-next', text: 'effect ›', title: 'Next effect' }),
      );
    }
    for (const b of controls.children) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        select(m.id);
        act(m.id, b.dataset.act);
      });
    }
    slot.append(controls);

    slots.set(m.id, { id: m.id, m, slot, pv: null, host: placeholder, state: slot.querySelector('.mp-state'), controls, data: {} });
    stack.append(slot);
    return slots.get(m.id);
  }

  /**
   * The component for one slot, mounted the first time the slot is asked for. The panel's own
   * header is removed: the chip row is the header, and a second title under it would repeat the
   * module's name twice in a 366px card.
   */
  function ensurePv(s) {
    if (s.pv) return s.pv;
    s.pv = mountPreview(s.host, {
      title: s.m.title,
      hint: '',
      interactive: false,
      dim: 0.6,
      // Every slot draws the wall's 16:9 picture, the 9:16 window on it and the way the stream
      // cuts between them — that is what the operator is judging. The wall slot is not special:
      // leaving its window out made it the one pane you could not compare against.
      windowed: true,
    });
    s.pv.el.classList.add('mp-pv');
    s.pv.el.dataset.module = s.id;
    const pvHead = s.pv.el.querySelector('.pv-head');
    if (pvHead && pvHead.parentElement === s.pv.el) s.pv.el.removeChild(pvHead);
    s.pv.start();
    return s.pv;
  }

  for (const m of order) buildSlot(m);

  function select(id, { notify = true, byUser = notify } = {}) {
    if (!slots.has(id)) return;
    if (byUser) picked = true;
    selected = id;
    for (const [sid, s] of slots) {
      s.slot.dataset.selected = String(sid === id);
      s.slot.setAttribute('aria-current', sid === id ? 'true' : 'false');
    }
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.chip === id));
    column.dataset.selected = id;
    // the column starts on the route's module; a person's own choice wins until they make another
    if (notify) announce(id);
  }

  /* ------------------------------------------------------------ chips */

  for (const m of order) {
    const chip = el('button', { type: 'button', class: 'pv-chip mp-chip', 'data-chip': m.id, 'aria-pressed': 'false', title: `${m.title}: click to select` }, m.title);
    chip.addEventListener('click', () => select(m.id));
    chips.append(chip);
  }

  /** What the column reports upstream: which module was picked (the shell may follow it). */
  function announce(id) {
    try {
      opts.onSelect?.(id);
    } catch (err) {
      console.error('merged-preview onSelect threw', err);
    }
  }

  /* ------------------------------------------------------------ driving a module */

  /**
   * The module's primary action from the merged view: exactly the request its own pane makes.
   * `slotAction` is the "click the selected slot again" gesture; `act` is the button's.
   */
  async function act(id, what) {
    try {
      if (id === 'wall') {
        if (what === 'pattern-next') await post('/api/wall/cmd', { cmd: 'look.pattern', args: { delta: 1 } });
        else if (what === 'palette-next') {
          const out = await post('/api/wall/cmd', { cmd: 'look.palette', args: { delta: 1 } });
          // the answer names the ramp the page applied; the store is the only place it survives
          if (out && clean(out.palette)) lookStore.set('wall', { palette: out.palette });
        }
        else if (what === 'blackout') {
          const on = lookStore.get('wall').blackout;
          await post('/api/wall/cmd', { cmd: on ? 'blackout.off' : 'blackout.on' });
        }
      } else if (id === 'dialogs') {
        if (what === 'send') await post('/api/dialogs/live', {});
        else if (what === 'clear') await del('/api/dialogs/live');
      } else if (id === 'notifications') {
        if (what === 'send') await post('/api/notifications/live', {});
        else if (what === 'clear') await del('/api/notifications/live');
      } else if (id === 'handfx') {
        if (what === 'effect-next') await post('/api/handfx/cmd', { cmd: 'effect.next' });
      }
      // one pull right away rather than waiting for the poll: the slot must show the effect the
      // operator just fired, or the click did not visibly do anything
      await load(id);
    } catch (err) {
      if (!dead()) setState(id, err.message || 'failed', 'bad');
    }
  }

  async function slotAction(id) {
    const primary = id === 'wall' ? 'pattern-next' : id === 'handfx' ? 'effect-next' : 'send';
    await act(id, primary);
  }

  /** One command round trip. Returns the answer, or throws with the server's own words. */
  async function post(path, body) {
    return api.post(path, body);
  }
  async function del(path) {
    return api.del(path);
  }

  /* ------------------------------------------------------------ fetch + paint */


  function setState(id, text, tone = '') {
    const s = slots.get(id);
    if (!s) return;
    s.state.textContent = text;
    s.state.dataset.tone = tone;
    s.slot.dataset.state = tone || 'ok';
  }

  /** The wall: settings look (its palette is a page command, so the store holds it too). */
  async function loadWall() {
    const r = await api.get('/api/wall/live', { signal });
    const s = r || {};
    const look = { ...((s.render && s.render.look) || {}), ...((s.settings && s.settings.look) || {}) };
    lookStore.set('wall', {
      // `look.palette` is a page command: nothing on the server records the ramp the wall is
      // running, so the palette comes from the store's own write when the slot sent the command,
      // and from a `palette` the server may expose one day. Reading it from the document per
      // poll would undo that write with the stale default on the next beat.
      // `palette` is not a settings key: the document cannot hold the ramp and a poll must not
      // undo the page's answer. The store's name (fed by a pane's paint or this column's own
      // command answer) wins; the document's copy, when one exists at all, is the fallback.
      palette: lookStore.get('wall').palette || clean(s.look && s.look.palette) || clean(look.palette) || DEFAULT_PALETTE,
      // the document is the wall's own look and wins: it is what the page persists, and it is the
      // one both readers (this column and the pane) write back after a command
      pattern: clean(look.pattern) || lookStore.get('wall').pattern,
      preset: clean(look.preset) || lookStore.get('wall').preset,
      brightness: num(look.brightness, 1),
      saturation: num(look.saturation, 1),
      speed: num(look.speed, 1),
      blackout: num(look.blackout, 0) > 0,
      fenceOutDim: num(look.fenceOutDim, 0.18),
      ratio: (s.ratio && s.ratio.selected) || lookStore.get('wall').ratio,
      fence: (s.render && s.render.fence) || (s.fence && s.fence.px) || lookStore.get('wall').fence,
    });
    const w = lookStore.get('wall');
    setState('wall', `${w.pattern}${w.blackout ? ' · black' : ''}`, w.blackout ? 'warn' : '');
  }

  function dialogNodes(live, theme) {
    // The dialogs are their module's own chrome: the skin class on the layer root and the
    // .dialog/.titlebar/.ttitle/.body structure, scaled from the 810×1440 canvas into the crop.
    const desk = el('div', { class: `dg-desk skin-${theme}` });
    for (const d of live) {
      const node = el('div', { class: 'dialog', dataset: { id: d.id } });
      for (const [k, v] of [['left', d.x], ['top', d.y], ['width', d.w], ['height', d.h]]) {
        if (Number.isFinite(Number(v))) node.style[k] = `${Number(v)}px`;
      }
      node.append(
        el('div', { class: 'titlebar' }, el('span', { class: 'ttitle', text: d.title || d.type || 'Alert' })),
        el('div', { class: 'body' }, el('div', { class: 'msg', text: d.text || d.message || '' })),
      );
      desk.append(node);
    }
    return desk;
  }

  function toastNodes(live, style, height) {
    // The notifications module's own markup and look class (.t-ios / .t-android / …), at canvas px.
    const strip = el('div', { class: `nt-layer t-${style}` });
    strip.style.setProperty('--nt-h', `${height}px`);
    for (const e of live) {
      const node = el('div', { class: 'toast in', dataset: { id: e.id } });
      node.append(
        el('div', { class: 'lead', 'aria-hidden': 'true' }),
        el('div', { class: 'body' },
          e.title ? el('div', { class: 'title', text: e.title }) : null,
          el('div', { class: 'text', text: e.text || '' }),
        ),
      );
      if (Number.isFinite(Number(e.y))) node.style.top = `${Number(e.y)}px`;
      strip.append(node);
    }
    return strip;
  }

  /** The dialogs: the strip crop the module uses (810 of 2560, centred). */
  async function loadDialogs() {
    const r = await api.get('/api/dialogs/live', { signal });
    const meta = (r && r.settings) || {};
    const live = (r && r.live) || [];
    const theme = String((meta.theme && meta.theme.value) || 'win11');
    lookStore.set('dialogs', { theme, scale: num(meta.scale && meta.scale.value, 0.7) });
    if (!hasDom()) return;
    const s = slots.get('dialogs');
    const pv = ensurePv(s);
    const desk = dialogNodes(live, theme);
    pv.setFence({ x: (2560 - DG_CANVAS_W) / 2 / 2560, w: DG_CANVAS_W / 2560, y: 0 });
    pv.setFenceVisible(true);
    pv.setLayer(desk);
    s.data.count = live.length;
    fitLayer(pv, desk, DG_CANVAS_W);
    setState('dialogs', `${live.length} up · ${theme}`, live.length ? '' : 'idle');
  }

  /** The notifications: the 405px strip, centred, at the module's own height. */
  async function loadNotifications() {
    const r = await api.get('/api/notifications/live', { signal });
    const meta = (r && r.settings) || {};
    const live = (r && r.live) || [];
    const style = String((meta.style && meta.style.value) || 'ios');
    const height = num(meta.height && meta.height.value, 76);
    lookStore.set('notifications', { style, height });
    if (!hasDom()) return;
    const s = slots.get('notifications');
    const pv = ensurePv(s);
    const strip = toastNodes(live, style, height);
    strip.style.width = `${NT_W}px`;
    strip.style.height = `${NT_H}px`;
    pv.setFence({ x: (2560 - NT_W) / 2 / 2560, w: NT_W / 2560, y: 0 });
    pv.setFenceVisible(true);
    pv.setLayer(strip);
    s.data.count = live.length;
    fitLayer(pv, strip, NT_W);
    setState('notifications', `${live.length} up · ${style}`, live.length ? '' : 'idle');
  }

  /**
   * Hand FX's picture is not a ShockBox render: the module draws it on its own camera canvas,
   * inside its own pane, and only while that pane's "Start preview" holds the camera. The column
   * therefore hosts that canvas when the pane is open — the module keeps drawing it, nothing here
   * draws a second effect — and otherwise says so. Moving the canvas out of a live pane would
   * blank the pane's own preview, so the column mirrors its pixels instead: a 2-D copy, refreshed
   * with the poll, is honest about what the pane sees and costs the module no camera.
   */
  async function loadHandfx() {
    const r = await api.get('/api/handfx/status', { signal });
    const st = r || {};
    const meta = st.settings || {};
    lookStore.set('handfx', {
      effect: lookStore.get('handfx').effect,
      skins: (meta.skins && (meta.skins.value || meta.skins)) || {},
      tracking: Boolean(st.page && st.page.tracking),
    });
    if (!hasDom()) return;
    const s = slots.get('handfx');
    const pv = ensurePv(s);
    pv.quiet?.(true);

    const source = findHandfxPreview();
    let mirror = s.data.mirror;
    if (!mirror) {
      mirror = el('canvas', { class: 'mp-mirror' });
      s.data.mirror = mirror;
      clear(pv.layer);
      pv.layer.append(mirror, el('div', { class: 'mp-empty' }, el('span', { text: 'open Hand FX to preview' })));
    }
    if (source) {
      // a copy of what the module is drawing, scaled to the crop; the pane keeps the original
      const w = source.width || source.clientWidth || 0;
      const h = source.height || source.clientHeight || 0;
      if (w > 0 && h > 0) {
        if (mirror.width !== w || mirror.height !== h) {
          mirror.width = w;
          mirror.height = h;
        }
        const ctx = mirror.getContext('2d');
        try {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(source, 0, 0, w, h);
        } catch {
          /* a tainted or detached canvas: the placeholder stays */
        }
      }
      mirror.hidden = false;
      s.data.mirrorLive = true;
      fitCanvas(pv, mirror);
      setState('handfx', 'from pane', '');
    } else {
      mirror.hidden = true;
      s.data.mirrorLive = false;
      setState('handfx', 'no camera', 'idle');
    }
  }

  /** The hand fx preview canvas inside the module's pane, if that pane is on screen. */
  function findHandfxPreview() {
    const card = document.querySelector('.hfx-preview');
    const c = card && card.querySelector('canvas.hfx-landmarks');
    return c && c.width > 0 && c.height > 0 ? c : null;
  }

  /** Scale a module canvas into the window's lit width, the way each pane does for its layer. */
  function fitCanvas(pv, canvas) {
    const win = pv.window;
    const pub = parseFloat((win && win.style.getPropertyValue('--pv-lit-w')) || '') || 0;
    const w = pub || win?.getBoundingClientRect?.().width || 0;
    const cw = canvas.width || canvas.clientWidth || 1;
    if (w > 0) {
      canvas.style.transformOrigin = 'top left';
      canvas.style.transform = `scale(${w / cw})`;
    }
  }

  function fitLayer(pv, layer, canvasW) {
    // same rule the module panes use: prefer the width the component published onto the window
    // (`--pv-lit-w`), and only measure when it has not written one yet
    const win = pv.window;
    const pub = parseFloat((win && win.style.getPropertyValue('--pv-lit-w')) || '') || 0;
    const w = pub || win?.getBoundingClientRect?.().width || 0;
    if (!(w > 0)) return;
    layer.style.transform = `scale(${w / canvasW})`;
    // A layer whose transform drives the CARD's layout would be a feedback loop; the layer is
    // absolutely positioned inside the window, so pin it: the scale never changes the box that
    // the ResizeObserver is watching.
    layer.style.transformOrigin = 'top left';
  }

  /** The wall's look, painted from the store: palette ramp, brightness, pattern, blackout. */
  function paintWall() {
    const s = slots.get('wall');
    if (!s) return;
    const w = lookStore.get('wall');
    const pv = ensurePv(s);
    pv.setLook({
      palette: lookStore.wallPalette(w.palette),
      brightness: w.brightness,
      saturation: w.saturation,
      speed: w.speed,
      pattern: w.pattern,
      blackout: w.blackout,
    });
    // the window is the wall's fence, drawn the way the wall pane draws it; with `ratio: 16:9` the
    // wall pane shows no window, and neither does this slot
    const windowed = w.ratio ? w.ratio === '9:16' : true;
    pv.setFenceVisible(windowed);
    if (windowed && w.fence && w.fence.px) {
      const f = w.fence.px;
      pv.setFence({ x: f.x / 2560, w: f.w / 2560, y: Math.max(0, f.y / 1440) });
    }
    s.slot.dataset.palette = w.palette;
    s.slot.dataset.pattern = w.pattern;
    s.slot.dataset.blackout = String(Boolean(w.blackout));
    setState('wall', `${w.pattern}${w.blackout ? ' · black' : ''}`, w.blackout ? 'warn' : '');
  }

  /** Hand FX and Dialogs carry their theme on the layer root; the notification strip does too. */
  function paintThemes() {
    const d = lookStore.get('dialogs');
    const desk = slots.get('dialogs')?.pv?.layer.querySelector('.dg-desk');
    if (desk) desk.className = `dg-desk skin-${d.theme}`;
    slots.get('dialogs')?.slot.setAttribute('data-theme', d.theme);
    const n = lookStore.get('notifications');
    const strip = slots.get('notifications')?.pv?.layer.querySelector('.nt-layer');
    if (strip) strip.className = `nt-layer t-${n.style}`;
    slots.get('notifications')?.slot.setAttribute('data-style', n.style);
    slots.get('handfx')?.slot.setAttribute('data-effect', lookStore.get('handfx').effect || '');
  }

  lookStore.setSync(() => loadLook('wall', { api }));

  const unsub = lookStore.subscribe((id) => {
    if (dead()) return;
    if (id === 'wall') paintWall();
    else paintThemes();
  });
  timers.push(unsub);

  /* ------------------------------------------------------------ load */

  // a function, not a const map: `loadNow` can be called before this line runs (a headless consumer)
  function loaders() {
    return { wall: loadWall, dialogs: loadDialogs, notifications: loadNotifications, handfx: loadHandfx };
  }

  /**
   * One module's data. The loaders fill `lookStore` even with no DOM; only the painting half of
   * this needs the column, so the promise is the network round trip either way.
   */
  function loadNow(id) {
    const fn = loaders()[id];
    if (!fn) return Promise.resolve(lookStore.get(id));
    return fn()
      .then(() => {
        if (hasDom() && !dead()) {
          if (id === 'wall') paintWall();
          else paintThemes();
        }
        return lookStore.get(id);
      })
      .catch((err) => {
        if (hasDom() && !dead()) setState(id, err.message || 'unreachable', 'bad');
        return lookStore.get(id);
      });
  }

  async function load(id) {
    const fn = loaders()[id];
    if (!fn || dead()) return;
    try {
      await fn();
      if (!hasDom()) return; // Node: the store is the product, painting is not
      if (id === 'wall') paintWall();
      else paintThemes();
    } catch (err) {
      if (!dead() && hasDom()) setState(id, err.message || 'unreachable', 'bad');
    }
  }

  async function loadAll() {
    await Promise.allSettled(order.map((m) => load(m.id)));
  }

  // The hand fx canvas is the module's to create: a slot above it is dead until the pane opens.
  // A sweep catches it when the route changes, and a slot is cheap enough to re-fit.
  function sweepHandfx() {
    if (dead() || !hasDom() || document.hidden) return;
    if (slots.has('handfx')) void load('handfx');
  }

  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (dead()) return;
      // only what is on screen: a hidden tab is not worth four requests a beat
      if (hasDom() && document.hidden) return schedulePoll();
      await loadAll();
      if (!dead()) schedulePoll();
    }, 2200);
  }
  timers.push(() => clearTimeout(pollTimer));

  const sub = bus?.subscribe?.((p) => {
    if (dead()) return;
    const ch = p && p.channel;
    if (ch === 'wall' || ch === 'ratio') void load('wall');
    else if (ch === 'dialogs') void load('dialogs');
    else if (ch === 'notifications') void load('notifications');
    else if (ch === 'handfx') void load('handfx');
  });
  if (sub) timers.push(sub);

  /* ------------------------------------------------------------ the drag */

  let drag = null;
  function onDown(e) {
    if (e.button !== 0) return;
    // the press belongs to the border: without this the pointer leaves the 9px handle on the first
    // move and the drag never starts (the pane beneath receives it instead)
    e.stopPropagation();
    e.preventDefault();
    drag = { x: e.clientX, w: width, pointerId: e.pointerId };
    try {
      resizer.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer has no capture; the window listener below still follows it */
    }
    column.dataset.dragging = 'true';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }
  function onMove(e) {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    // the column is LEFT of the pane, so growing it means moving the handle right
    applyWidth(drag.w + (e.clientX - drag.x), { persist: false });
  }
  function onUp() {
    if (!drag) return;
    drag = null;
    column.dataset.dragging = 'false';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    applyWidth(width); // one write, once the hand stops
  }
  // Capture phase: the handle sits inside the column's scroll area, over the pane's stacking
  // context at the edge. Listening in the capture phase (and stopping there) means the press is
  // the handle's whatever the card under the pointer would otherwise do with it.
  resizer.addEventListener('pointerdown', onDown, true);
  resizer.addEventListener('pointermove', onMove, true);
  resizer.addEventListener('pointerup', onUp, true);
  resizer.addEventListener('pointercancel', onUp, true);
  resizer.addEventListener('dblclick', () => applyWidth(DEFAULT_W));
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      applyWidth(width - step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      applyWidth(width + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      applyWidth(MIN_W);
    } else if (e.key === 'End') {
      e.preventDefault();
      applyWidth(maxW());
    }
  });
  timers.push(() => {
    resizer.removeEventListener('pointerdown', onDown, true);
    resizer.removeEventListener('pointermove', onMove, true);
    resizer.removeEventListener('pointerup', onUp, true);
    resizer.removeEventListener('pointercancel', onUp, true);
  });

  function onViewport() {
    // a narrower window clamps the column instead of overflowing the layout; widening gives the
    // stored width back, because `width` is still what the operator asked for. The slot relayout is
    // NOT needed here: each slot's own ResizeObserver sees the stage change, and laying four
    // components out from inside the window's resize handler is what made Chrome report a
    // ResizeObserver loop ("undelivered notifications") as an uncaught error.
    applyWidth(width, { persist: false });
  }
  window.addEventListener('resize', onViewport);
  timers.push(() => window.removeEventListener('resize', onViewport));

  /* ------------------------------------------------------------ go */

  return {
    el: column,
    /** Select a module without telling the shell (used when the route agrees with the column). */
    select: (id) => select(id, { notify: false }),
    get width() {
      return width;
    },
    /** Called by the shell after a route change: follow the pane if the person has not chosen. */
    followRoute(id) {
      if (!picked) select(id, { notify: false });
    },
    start() {
      // the column exists before the first load so the shell's grid has its track on frame one
      loadAll();
      schedulePoll();
      const sweep = setInterval(sweepHandfx, 4000);
      timers.push(() => clearInterval(sweep));
      // the route may already be a module: start on it, so the column agrees with the pane
      if (opts.route) select(opts.route, { notify: false });
      else select(order[0].id, { notify: false });
    },
    destroy() {
      destroyed = true;
      for (const t of timers) {
        try {
          t();
        } catch {
          /* already gone */
        }
      }
      // a hand fx canvas borrowed from a pane goes back where it came from, or the pane dies
      // with a hole in it when this column is torn down
      for (const s of slots.values()) {
        const c = s.pv?.window.querySelector('canvas.hfx-landmarks');
        if (c && c.dataset.mpMoved === 'true') {
          c.remove();
          c.dataset.mpMoved = 'false';
        }
        s.pv?.stop?.();
      }
      column.remove();
    },
  };
}

export default mountMergedColumn;
