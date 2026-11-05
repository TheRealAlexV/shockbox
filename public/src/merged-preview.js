// The show preview: ONE 9:16 strip between the rail and the pane, on every route.
//
// Why one surface and not four previews: the operator does not watch four modules, the operator
// watches the show. OBS cuts a 405×720 window out of the centre of the 1280×720 wall and stacks
// the overlays inside it; four separate previews cannot show whether an alert covers the wall's
// focal point, and they are four places to read instead of one picture.
//
// A layer is the module's own thing, not a reimplementation:
//   wall          the real `/wall/portrait` page in an iframe, scaled into the strip: the engine's
//                 own paint, picture and blackout, not a CSS copy of them
//   hand fx       the pane's own camera canvas, mirrored — the module keeps drawing its pixels
//   notifications the module's own markup and stylesheet inside a shadow root (405×720 native)
//   dialogs       the same, on its 810×1440 desk shown at half scale
// Shadow roots are what let both overlays render with the module's real chrome: their sheets style
// `.body`, `.btn` and `.title`, which the control page also uses.
//
// Interaction is on the live widget: a press on a dialog's button sends the request that dialog's
// own overlay sends, and a drag moves the dialog on the server (PATCH /api/dialogs/live). The
// preview may close or decide an alert and may never make one — a `spawn` control renders inert.
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

import { el } from '/src/ui.js';
import { shapeFor } from '/src/preview.js';

/** The four modules, in the order the wall's own stack draws them (wall first, overlays on top). */
export const MODULES = [
  { id: 'wall', title: 'Wall', hint: 'full picture' },
  { id: 'handfx', title: 'ShockFX', hint: 'hand overlay' },
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
 * The strip OBS shows, in its own pixels.
 *
 * OBS stacks the overlays inside a 405×720 window (`V: Main Live`), and both overlays are
 * authored against that box: notifications at 405×720, alerts on an 810×1440 desk, which is the
 * same box at 2×. The surface below IS that window — one frame, every module painted into it in
 * the order the show stacks them — so a thing sits here where OBS draws it.
 */
export const STRIP = { w: 405, h: 720 };

/**
 * The base rules for a module's layer. The module's own stylesheet is linked next to them inside
 * a shadow root, so the layer renders with the module's real chrome and cannot leak into the
 * control page (both modules style `.body`, `.btn`, `.title` …). The only things added are the
 * host box and the pointer contract: the layer is click-through except on the element itself.
 */
const LAYER_BASE = {
  dialogs: `
    :host { position: absolute; inset: 0; display: block; pointer-events: none;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            -webkit-font-smoothing: antialiased; }
    .desk { position: absolute; inset: 0; }
    .dialog { pointer-events: auto; cursor: grab; touch-action: none; }
    .dialog[data-drag='true'] { transition: none; cursor: grabbing; }
    .dialog .btn[disabled] { opacity: 0.45; }
  `,
  notifications: `
    :host { position: absolute; inset: 0; display: block; pointer-events: none;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            -webkit-font-smoothing: antialiased; }
    .stage { position: absolute; inset: 0; overflow: hidden; }
    .toast { pointer-events: auto; }
    .toast .acts .btn { pointer-events: auto; }
  `,
};

/** `el` gives a described setting either as `{value}` or raw; read both. */
function setting(doc, key, fallback) {
  const m = doc && doc[key];
  if (m && typeof m === 'object' && 'value' in m) return m.value;
  return m === undefined || m === null ? fallback : m;
}

/* The alert icons, mirrored from modules/dialogs/overlay/app.js: the module names an icon and the
 * overlay owns the drawing, so the strip draws the same glyph it will see in OBS. */
const ICON_PATHS = {
  error:
    '<circle cx="12" cy="12" r="10.4" fill="#e01b1b" stroke="#8a0000" stroke-width="1.2"/>' +
    '<path d="M6.95 6.95 17.05 17.05 M17.05 6.95 6.95 17.05" stroke="#fff" stroke-width="3.2"/>',
  warning:
    '<path d="M12 2.1 22.7 21.3H1.3Z" fill="#ffd21e" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<rect x="10.9" y="7.9" width="2.2" height="7.4" fill="#111"/>' +
    '<rect x="10.9" y="17.1" width="2.2" height="2.2" fill="#111"/>',
  info:
    '<circle cx="12" cy="12" r="10.4" fill="#0b57c9" stroke="#00318f" stroke-width="1.2"/>' +
    '<rect x="10.75" y="10.3" width="2.5" height="7.6" fill="#fff"/>' +
    '<circle cx="12" cy="6.85" r="1.75" fill="#fff"/>',
  question:
    '<circle cx="12" cy="12" r="10.3" fill="#fff" stroke="#0b57c9" stroke-width="2.1"/>' +
    '<path d="M8.7 9.1a3.5 3.5 0 1 1 4.45 3.4c-.8.28-1.05.85-1.05 1.55v.75" fill="none" stroke="#0b57c9" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="12.05" cy="17.7" r="1.45" fill="#0b57c9"/>',
};

function iconNode(name) {
  if (!name || name === 'none') return null;
  const wrap = el('div', { class: 'icon' });
  wrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.error}</svg>`;
  return wrap;
}


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
  // two-column layout needs ~520px, so the column gives way before it does. Below `NARROW_VP`
  // the column goes to a strip and the pane wins.
  const maxW = () => {
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1440;
    const share = Math.round(vw * MAX_SHARE);
    const keepPane = vw - RAIL_W - MIN_PANE_W;
    return clamp(Math.min(share, keepPane), MIN_W, 720);
  };
  let width = clamp(storedW || DEFAULT_W, MIN_W, maxW());

  // A gate imports this module in Node to read `lookStore` and its fetch path. No DOM means no
  // column and no painting — the store is the whole product there.
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
    'aria-label': 'Show preview',
    'data-compact': 'false',
    // The column is a shell layout element, and it must own its width on frame one: a stylesheet
    // that has not landed yet (a cold load, a gate that navigates at once) would otherwise let the
    // empty `aside` take the `1fr` track and push <main> to zero. The custom property is the only
    // thing the grid needs, so it is written inline and the rest of the look is the sheet's.
    style: { '--merged-w': `${width}px` },
  });
  const head = el('div', { class: 'merged-head panel-head' },
    el('span', { class: 'panel-title', text: 'Show preview' }),
    el('span', { class: 'panel-hint mono dim merged-hint', text: '9:16 · live' }),
  );
  const chips = el('div', { class: 'pv-chips merged-chips' });
  head.append(chips);

  /* ------------------------------------------------------------ one surface */

  const bodyEl = el('div', { class: 'mx-body' });
  const surface = el('div', {
    class: 'mx-surface',
    role: 'group',
    'aria-label': 'Show preview: the 9:16 strip as OBS sees it. Press an alert’s control to act on that alert; drag an alert to move it.',
    'data-strip': `${STRIP.w}x${STRIP.h}`,
  });
  const scene = el('div', { class: 'mx-scene' });
  surface.append(scene);

  /* The wall layer is the real page, not a CSS imitation of it: `/wall/portrait` is the same
   * document OBS loads, drawn at 720×1280 and scaled 0.5625 to the strip's 405×720. The outer
   * element and its classes stay — layout still targets it. */
  const wallEl = el('div', { class: 'mx-wall pv-stage', 'data-shape': 'wave' },
    el('iframe', {
      src: '/wall/portrait',
      scrolling: 'no',
      title: 'Show wall',
      /* pointer-events:none keeps the stage under the frame receiving the pointer, so a press
       * lands on the strip and not inside the wall document. */
      style: 'width:720px;height:1280px;border:0;position:absolute;inset:0;transform:scale(0.5625);transform-origin:0 0;pointer-events:none',
    }),
  );

  /* ShockFX draws on its own camera canvas in its own pane; the strip mirrors those pixels. */
  const fxEl = el('div', { class: 'mx-handfx' });
  const fxMirror = el('canvas', { class: 'mx-mirror' });
  fxMirror.hidden = true;
  fxEl.append(fxMirror);

  function shadowLayer(cls, href, base, wrapCls) {
    const hostEl = el('div', { class: `mx-layer ${cls}` });
    const root = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = base;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    const wrap = el('div', { class: wrapCls });
    root.append(style, link, wrap);
    return { host: hostEl, root, wrap };
  }
  const nt = shadowLayer('mx-notifs', '/notify/style.css', LAYER_BASE.notifications, 'stage');
  const dlg = shadowLayer('mx-dialogs', '/dialogs/style.css', LAYER_BASE.dialogs, 'desk skin-win11');

  // stack order is the show's: wall, then hand fx, then notifications, then alerts on top
  scene.append(wallEl, fxEl, nt.host, dlg.host);
  bodyEl.append(surface);

  // The resizer is a real focusable separator: a mouse can drag it, a keyboard can nudge it, and
  // a screen reader says what it is. Its hit area is wider than its hairline.
  const resizer = el('div', {
    class: 'merged-resize',
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the show preview column',
    title: 'Drag to resize · double-click to reset',
  });
  column.append(head, bodyEl, resizer);
  // the column (`aside.merged`) IS the grid cell between the rail and <main>, so it carries no
  // wrapper. It takes the track the shell reserved for it, before `#main`: a grid item's source
  // order puts it in the track it lands in, and appended last it would land in the drawer's.
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
    fit();
  }
  applyWidth(width, { persist: false });

  /* ------------------------------------------------------------ fit the strip */

  let scale = 1;
  /** The strip keeps its aspect; it is scaled into whatever room the column gives it. */
  function fit() {
    if (dead() || !bodyEl.isConnected) return;
    const aw = bodyEl.clientWidth - 18;
    const ah = bodyEl.clientHeight - 18;
    if (!(aw > 40 && ah > 40)) return;
    scale = clamp(Math.min(aw / STRIP.w, ah / STRIP.h), 0.04, 4);
    surface.style.width = `${(STRIP.w * scale).toFixed(2)}px`;
    surface.style.height = `${(STRIP.h * scale).toFixed(2)}px`;
    scene.style.transform = `scale(${scale.toFixed(4)})`;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  ro?.observe(bodyEl);
  timers.push(() => ro?.disconnect());

  /** A client point in the strip's own pixels (405×720), whatever the column's width is. */
  function toScene(ev) {
    const r = scene.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale };
  }

  /** A module element being dragged in the strip, in strip pixels. */
  function dragSurface(target, { onMove, onEnd }) {
    const start = { x: 0, y: 0, moved: false };
    target.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || dead()) return;
      const id = ev.pointerId;
      try {
        target.setPointerCapture(id);
      } catch {
        /* a synthetic pointer has no capture; the window listeners below still follow it */
      }
      start.x = ev.clientX;
      start.y = ev.clientY;
      start.moved = false;
      const move = (mv) => {
        if (mv.pointerId !== id) return;
        if (!start.moved && Math.hypot(mv.clientX - start.x, mv.clientY - start.y) < 3) return;
        start.moved = true;
        onMove(mv, toScene(mv), mv.clientX - start.x, mv.clientY - start.y);
      };
      const up = (uv) => {
        if (uv.pointerId !== id) return;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
        try {
          target.releasePointerCapture(id);
        } catch {
          /* already gone */
        }
        if (start.moved) onEnd();
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
    });
  }

  /* ------------------------------------------------------------ selection */

  const order = opts.modules || MODULES;
  const mods = new Map();
  let selected = null;
  // until the operator picks a module itself, the column follows the route's pane
  let picked = false;

  for (const m of order) {
    const stateEl = el('span', { class: 'mx-chip-state', text: '' });
    const chip = el('button', {
      type: 'button',
      class: 'pv-chip mx-chip',
      'data-chip': m.id,
      'aria-pressed': 'false',
      title: `${m.title} — ${m.hint}`,
    }, el('span', { class: 'mx-chip-name', text: m.title }), stateEl);
    chip.addEventListener('click', () => select(m.id));
    chips.append(chip);
    mods.set(m.id, { chip, state: stateEl, data: {} });
  }

  function select(id, { notify = true, byUser = notify } = {}) {
    if (!mods.has(id)) return;
    if (byUser) picked = true;
    if (selected === id && notify) return undefined;
    selected = id;
    for (const [sid, s] of mods) s.chip.setAttribute('aria-pressed', String(sid === id));
    column.dataset.selected = id;
    // the column starts on the route's module; a person's own choice wins until they make another
    if (notify) announce(id);
  }

  /** What the column reports upstream: which module was picked (the shell may follow it). */
  function announce(id) {
    try {
      opts.onSelect?.(id);
    } catch (err) {
      console.error('merged-preview onSelect threw', err);
    }
  }

  function setState(id, text, tone = '') {
    const s = mods.get(id);
    if (!s) return;
    s.state.textContent = text;
    s.chip.dataset.tone = tone || 'ok';
  }

  /* ------------------------------------------------------------ the requests */

  const pushing = new Set();
  /** One request per module at a time; a poll that overtakes a commit is dropped, not queued. */
  async function send(id, path, body) {
    if (dead() || !api) return null;
    pushing.add(id);
    try {
      const out = await api.patch(path, body);
      return out;
    } catch (err) {
      if (!dead()) setState(id, err.message || 'write failed', 'bad');
      return null;
    } finally {
      pushing.delete(id);
    }
  }

  /* ------------------------------------------------------------ the wall */

  paintWall();

  function paintWall() {
    const look = lookStore.get('wall');
    const pal = Array.isArray(look.palette) && look.palette.length >= 2
      ? look.palette
      : WALL_PALETTES[look.palette] || WALL_PALETTES[DEFAULT_PALETTE];
    wallEl.style.setProperty('--pv-a', pal[0]);
    wallEl.style.setProperty('--pv-b', pal[Math.min(1, pal.length - 1)]);
    wallEl.style.setProperty('--pv-c', pal[Math.min(2, pal.length - 1)]);
    const bright = clamp(num(look.brightness, 1), 0, 2);
    wallEl.style.setProperty('--pv-bright', String(bright));
    wallEl.style.setProperty('--pv-sat', String(clamp(num(look.saturation, 1), 0, 2)));
    wallEl.style.setProperty('--pv-dur', `${clamp(18 / Math.max(0.15, num(look.speed, 1)), 4, 120)}s`);
    wallEl.dataset.shape = shapeFor(look.pattern);
    wallEl.dataset.blackout = String(Boolean(look.blackout));
    wallEl.style.setProperty('--pv-dot', look.blackout ? '0.04' : String(clamp(0.25 + bright * 0.5, 0.12, 1)));
  }


  /* ------------------------------------------------------ the pointer bus */

  /* The strip reports where the operator's pointer is, in 0..1 of the stage, so the stage's own
   * source can react. 30 Hz at most: one POST per 33 ms carrying the newest position, and a press
   * goes out at once instead of waiting for the timer's turn. */
  const POINTER_MS = 33;
  let pointerSent = 0;
  let pointerTimer = 0;
  let pointerNext = null;

  function pointerPost(p) {
    if (dead() || !selected) return;
    fetch('/api/stage/pointer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: p.x, y: p.y, down: p.down, module: selected }),
    }).catch(() => {
      /* the bus is best effort: a lost position is not worth a retry or a message */
    });
  }

  function pointerFlush() {
    pointerTimer = 0;
    const p = pointerNext;
    pointerNext = null;
    if (!p) return;
    pointerSent = Date.now();
    pointerPost(p);
  }

  function pointerAt(ev, down) {
    const at = toScene(ev);
    pointerNext = {
      x: clamp(at.x / STRIP.w, 0, 1),
      y: clamp(at.y / STRIP.h, 0, 1),
      down,
    };
    if (down) {
      if (pointerTimer) clearTimeout(pointerTimer);
      pointerFlush();
      return;
    }
    if (pointerTimer) return;
    const wait = POINTER_MS - (Date.now() - pointerSent);
    pointerTimer = setTimeout(pointerFlush, wait > 0 ? wait : 0);
  }

  scene.addEventListener('pointermove', (ev) => pointerAt(ev, false));
  scene.addEventListener('pointerdown', (ev) => pointerAt(ev, true), true);
  timers.push(() => {
    if (pointerTimer) clearTimeout(pointerTimer);
  });

  /* ------------------------------------------------------------ the alerts */

  const dlgNodes = new Map();

  function dialogNode(d) {
    const node = el('div', { class: 'dialog in', dataset: { id: d.id } });
    node.style.left = `${num(d.x, 0)}px`;
    node.style.top = `${num(d.y, 0)}px`;
    node.style.width = `${num(d.w, 300)}px`;
    node.style.height = `${num(d.h, 150)}px`;

    const closeBtn = el('button', {
      type: 'button',
      class: 'tclose',
      title: 'Close this alert',
      'aria-label': 'Close this alert',
    });
    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void decide(d.id, 'close');
    });
    const bar = el('div', { class: 'titlebar' },
      el('span', { class: 'ttitle', text: d.title || d.type || 'Alert' }),
      closeBtn,
    );

    const bodyEl2 = el('div', { class: 'body' });
    const icon = iconNode(d.icon);
    if (icon) bodyEl2.append(icon);
    bodyEl2.append(el('div', { class: 'msg', text: d.text || d.message || '' }));

    const acts = el('div', { class: 'buttons' });
    const buttons = Array.isArray(d.buttons) && d.buttons.length ? d.buttons : [{ label: 'OK', action: 'close' }];
    const primary = buttons.length - 1;
    buttons.forEach((b, i) => {
      const action = String(b.action || 'close');
      const btn = el('button', { type: 'button', class: `btn${i === primary ? ' primary' : ''}`, text: String(b.label || 'OK') });
      if (action === 'spawn') {
        // The preview must never make a new alert. The button is the alert's own shape, inert,
        // and the pane says what it will do.
        btn.disabled = true;
        btn.title = 'Makes another alert — send it from the Alerts pane';
      } else {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void decide(d.id, action);
        });
      }
      acts.append(btn);
    });

    node.append(bar, bodyEl2, acts);
    node.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const t = ev.composedPath()[0];
      if (t && t.closest && t.closest('button')) return; // a control is a control, not a handle
      select('dialogs');
      node.dataset.drag = 'true';
      const startNode = { x: parseFloat(node.style.left) || 0, y: parseFloat(node.style.top) || 0 };
      const start = { x: ev.clientX, y: ev.clientY };
      const move = (mv) => {
        const dx = (mv.clientX - start.x) / scale;
        const dy = (mv.clientY - start.y) / scale;
        node.style.left = `${clamp(startNode.x + dx, 0, Math.max(0, STRIP.w - num(d.w, 300)))}px`;
        node.style.top = `${clamp(startNode.y + dy, 0, Math.max(0, STRIP.h - num(d.h, 150)))}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        node.dataset.drag = 'false';
        const x = Math.round(parseFloat(node.style.left) || 0);
        const y = Math.round(parseFloat(node.style.top) || 0);
        if (Math.hypot(parseFloat(node.style.left) - startNode.x, parseFloat(node.style.top) - startNode.y) < 1) return;
        void send('dialogs', '/api/dialogs/live', { id: d.id, x, y }).then(() => load('dialogs'));
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    });
    return node;
  }

  function paintDialogs(live, theme) {
    const skin = `desk skin-${theme || 'win11'}`;
    if (dlg.wrap.className !== skin) dlg.wrap.className = skin;
    const seenIds = new Set();
    for (const d of live) {
      seenIds.add(d.id);
      let node = dlgNodes.get(d.id);
      if (!node) {
        node = dialogNode(d);
        dlgNodes.set(d.id, node);
        dlg.wrap.append(node);
      } else if (node.dataset.drag !== 'true') {
        node.style.width = `${num(d.w, 300)}px`;
        node.style.height = `${num(d.h, 150)}px`;
        node.style.left = `${num(d.x, 0)}px`;
        node.style.top = `${num(d.y, 0)}px`;
      }
    }
    for (const [id, node] of dlgNodes) {
      if (seenIds.has(id)) continue;
      dlgNodes.delete(id);
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 200);
    }
  }

  /**
   * Act on the live widget, not on a picture of it. `spawn` is refused here by construction: the
   * preview may close or decide an alert, and may never make one.
   */
  async function decide(id, action) {
    if (!action || action === 'none' || action === 'spawn' || dead() || !api) return;
    try {
      if (action === 'closeAll') await api.del('/api/dialogs/live');
      else await api.del(`/api/dialogs/live?id=${encodeURIComponent(id)}`);
    } catch (err) {
      if (!dead()) setState('dialogs', err.message || 'close failed', 'bad');
      return;
    }
    void load('dialogs');
  }

  /* ------------------------------------------------------------ the toasts */

  const ntNodes = new Map();

  function toastNode(e, skin) {
    const node = el('div', { class: `toast ${skin} in`, dataset: { id: e.id } });
    node.style.width = `${num(e.w, 381)}px`;
    node.style.height = `${num(e.h, 76)}px`;
    node.style.left = `${num(e.x, 12)}px`;
    node.style.top = `${num(e.y, 12)}px`;
    node.append(el('div', { class: 'lead', 'aria-hidden': 'true' }));
    const body = el('div', { class: 'body' });
    if (e.title) body.append(el('div', { class: 'title', text: e.title }));
    body.append(el('div', { class: 'text', text: e.text || '' }));
    node.append(body);
    if (Array.isArray(e.buttons) && e.buttons.length) {
      const acts = el('div', { class: 'acts' });
      for (const b of e.buttons) {
        const btn = el('button', { type: 'button', class: 'btn', text: String(b.label || 'OK') });
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void dismissToast(e.id, String(b.action || 'close'));
        });
        acts.append(btn);
      }
      node.append(acts);
    }
    node.addEventListener('click', () => void dismissToast(e.id, 'close'));
    return node;
  }

  function paintToasts(live, style) {
    // the look class belongs on each toast (`.t-ios` paints the element); the layer is only a box
    const skin = `t-${style || 'ios'}`;
    if (nt.wrap.className !== 'stage') nt.wrap.className = 'stage';
    const seenIds = new Set();
    for (const e of live) {
      seenIds.add(e.id);
      let node = ntNodes.get(e.id);
      if (!node) {
        node = toastNode(e, skin);
        ntNodes.set(e.id, node);
        nt.wrap.append(node);
      } else {
        node.style.top = `${num(e.y, 12)}px`;
      }
    }
    for (const [id, node] of ntNodes) {
      if (seenIds.has(id)) continue;
      ntNodes.delete(id);
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 220);
    }
  }

  async function dismissToast(id, action) {
    if (!action || action === 'none' || action === 'spawn' || dead() || !api) return;
    try {
      await api.del(`/api/notifications/live?id=${encodeURIComponent(id)}`);
    } catch (err) {
      if (!dead()) setState('notifications', err.message || 'close failed', 'bad');
      return;
    }
    void load('notifications');
  }

  /* ------------------------------------------------------------ fetch + paint */

  /** The wall: its settings look, plus the picture's placement (the settings route owns both). */
  async function loadWall() {
    const r = await api.get('/api/wall/live', { signal });
    const s = r || {};
    const look = { ...((s.render && s.render.look) || {}), ...((s.settings && s.settings.look) || {}) };
    const prev = lookStore.get('wall');
    // `look.palette` and `look.pattern` are page commands: nothing on the server records the ramp
    // or the shape the wall is running, so those come from the store when a pane told it.
    lookStore.set('wall', {
      ...prev,
      palette: Array.isArray(look.palette) ? look.palette : clean(look.palette) || prev.palette,
      pattern: clean(look.pattern) || prev.pattern,
      brightness: num(look.brightness, num(setting(s.settings, 'brightness', 1), 1)),
      saturation: num(look.saturation, num(setting(s.settings, 'saturation', 1), 1)),
      speed: num(look.speed, num(setting(s.settings, 'speed', 1), 1)),
      blackout: num(look.blackout, num(setting(s.settings, 'blackout', 0), 0)) > 0,
      fenceOutDim: num(setting(s.settings, 'fenceOutDim', 0.18), 0.18),
      ratio: (s.ratio && s.ratio.selected) || prev.ratio,
      fence: (s.render && s.render.fence) || (s.fence && s.fence.px) || prev.fence,
    });
    const w = lookStore.get('wall');
    if (hasDom()) paintWall();
    setState('wall', `${w.pattern}${w.blackout ? ' · black' : ''}`, w.blackout ? 'warn' : '');
  }

  async function loadDialogs() {
    const r = await api.get('/api/dialogs/live', { signal });
    const meta = (r && r.settings) || {};
    const live = (r && r.live) || [];
    const theme = String((meta.theme && meta.theme.value) || 'win11');
    lookStore.set('dialogs', { theme, scale: num(meta.scale && meta.scale.value, 0.7) });
    if (!hasDom()) return;
    paintDialogs(live, theme);
    mods.get('dialogs').data.count = live.length;
    setState('dialogs', `${live.length} up · ${theme}`, live.length ? '' : 'idle');
  }

  async function loadNotifications() {
    const r = await api.get('/api/notifications/live', { signal });
    const meta = (r && r.settings) || {};
    const live = (r && r.live) || [];
    const style = String((meta.style && meta.style.value) || 'ios');
    const height = num(meta.height && meta.height.value, 76);
    lookStore.set('notifications', { style, height });
    if (!hasDom()) return;
    paintToasts(live, style);
    mods.get('notifications').data.count = live.length;
    setState('notifications', `${live.length} up · ${style}`, live.length ? '' : 'idle');
  }

  /**
   * ShockFX's picture is not a ShockBox render: the module draws it on its own camera canvas,
   * inside its own pane, and only while that pane's "Start preview" holds the camera. The strip
   * mirrors those pixels — a 2-D copy, refreshed with the poll — because moving the canvas out of
   * a live pane would blank the pane's own preview, and nothing here draws a second effect.
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
    const source = findHandfxPreview();
    if (source) {
      const w = source.width || source.clientWidth || 0;
      const h = source.height || source.clientHeight || 0;
      if (w > 0 && h > 0) {
        if (fxMirror.width !== w || fxMirror.height !== h) {
          fxMirror.width = w;
          fxMirror.height = h;
        }
        const ctx = fxMirror.getContext('2d');
        try {
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(source, 0, 0, w, h);
        } catch {
          /* a tainted or detached canvas: the layer stays empty */
        }
        fxMirror.hidden = false;
        setState('handfx', 'from pane', '');
        return;
      }
    }
    fxMirror.hidden = true;
    setState('handfx', 'no camera', 'idle');
  }

  /** The hand fx preview canvas inside the module's pane, if that pane is on screen. */
  function findHandfxPreview() {
    const card = document.querySelector('.hfx-preview');
    const c = card && card.querySelector('canvas.hfx-landmarks');
    return c && c.width > 0 && c.height > 0 ? c : null;
  }

  const loaders = () => ({
    wall: loadWall,
    dialogs: loadDialogs,
    notifications: loadNotifications,
    handfx: loadHandfx,
  });

  async function load(id) {
    const fn = loaders()[id];
    if (!fn || dead()) return;
    try {
      await fn();
    } catch (err) {
      if (!dead() && hasDom()) setState(id, err.message || 'unreachable', 'bad');
    }
  }

  async function loadAll() {
    await Promise.allSettled(order.map((m) => load(m.id)));
  }

  // The hand fx canvas is the module's to create: the layer above it is empty until the pane opens.
  function sweepHandfx() {
    if (dead() || !hasDom() || document.hidden) return;
    if (mods.has('handfx')) void load('handfx');
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

  /* ------------------------------------------------------------ the border drag */

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
  }
  function onMove(e) {
    if (!drag) return;
    if (e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    // the column is LEFT of the pane, so growing it means moving the handle right
    applyWidth(drag.w + (e.clientX - drag.x));
  }
  function onUp(e) {
    if (!drag) return;
    if (e && e.pointerId !== drag.pointerId) return;
    drag = null;
    column.dataset.dragging = 'false';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  resizer.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  // a keyboard can resize it too: the same two commands the mouse has
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === 'ArrowLeft') applyWidth(width - step);
    else if (e.key === 'ArrowRight') applyWidth(width + step);
    else if (e.key === 'Home') applyWidth(MIN_W);
    else if (e.key === 'End') applyWidth(maxW());
    else return;
    e.preventDefault();
  });
  resizer.addEventListener('dblclick', () => applyWidth(DEFAULT_W));
  timers.push(() => {
    resizer.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
  });

  /* ------------------------------------------------------------ lifecycle */

  /** The route settled on a module: follow it until the operator picks one here. */
  function followRoute(id) {
    if (picked || !mods.has(id)) return;
    select(id, { notify: false });
  }

  function start() {
    if (dead()) return;
    void loadAll();
    schedulePoll();
    fit();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(pollTimer);
    for (const off of timers.splice(0)) {
      try {
        off();
      } catch {
        /* a timer that already fired */
      }
    }
    column.remove();
  }

  if (opts.route) select(opts.route, { notify: false });
  else if (order[0]) select(order[0].id, { notify: false });

  return {
    el: column,
    surface,
    select,
    followRoute,
    start,
    destroy,
    load,
    sweepHandfx,
    get width() {
      return width;
    },
    get scale() {
      return scale;
    },
  };
}
