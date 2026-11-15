// Notification overlay — toasts on the full 16:9 surface, with an optional 9:16 stage. Runs as
// the page behind the "Notifications" browser source.
//
// Contract with the server: one SSE stream on `notifications`. Every `snapshot` frame carries
// the full live stack, so the page never has to merge deltas — it re-renders the difference.
// The server records the column in a 405×720 reference canvas (x/y/w/h); this page scales that
// record to the live stage box, so any surface size works and no fixed width survives here.
// A 9:16 ratio narrows the stage in CSS to the centred height × 9/16 window, and the column
// follows it on the same settings frame — live cards re-place, no reload.

import { createPlayer, DEFAULT_NOTIFY_TONE } from '/mod/notifications/sound.mjs';
import { createBuildCheck } from '/src/build-check.js';
import { createLivePoll } from '/src/live-poll.js';

// Preview panes mount this page in a small inert iframe (`?preview=1`). The page then draws one
// sample toast through the real render path and never opens a stream or talks to the server, so
// nothing here registers as a live notification, schedules the auto-close sweep, or reaches a
// second tab. Without the param the query string is ignored and the page behaves exactly as before.
const preview = new URLSearchParams(location.search).get('preview') === '1';

// The canvas the server's records are expressed in. Only its height matters: every length on
// the page is the record scaled by (live stage height / REF_H).
const REF_H = 720;

const root = document.getElementById('stage');
const seen = new Map(); // id -> {el, sig, entity}
let settings = { style: 'ios' };
let ratio = '16:9';

// The tone. One player per page, built from the notifications module's authored asset (so the
// dialogs overlay shares the same code without either module naming the other's page).
const player = createPlayer({ instrument: true });

/* ---------------------------------------------------------------- stage geometry */

// One measurement authority: the stage box OBS actually paints into. The 16:9 stage is the
// whole surface; the 9:16 stage is the centred portrait window the CSS narrows it to, so the
// same arithmetic lands the column inside that window with no special case here.
function stageBox() {
  const r = root.getBoundingClientRect();
  // A preview card is a few hundred pixels tall, so the true stage scale (height / 720) would draw
  // a few-pixel toast. Preview mode instead fits the reference column to the card, keeping the
  // sample readable while the real surface stays byte-identical.
  const s = preview
    ? Math.min(r.width / 405, r.height / 300) || 1
    : r.height > 0 ? r.height / REF_H : 1;
  return { w: r.width, h: r.height, s };
}

// Column geometry from the box, never from the viewport: the card keeps the reference band's
// 12px side margin (381 of 405 wide) scaled to the surface height, capped by the stage width.
function geometry(entity, box) {
  const s = box.s;
  const margin = 12 * s;
  const w = Math.max(0, Math.min(381 * s, box.w - margin * 2));
  return {
    x: (box.w - w) / 2,
    y: entity.y * s,
    w,
    h: Math.max(0, entity.h * s),
  };
}

function place(view, box) {
  const g = geometry(view.entity, box);
  const st = view.el.style;
  st.left = `${g.x}px`;
  st.top = `${g.y}px`;
  st.width = `${g.w}px`;
  st.height = `${g.h}px`;
}

// The stage box changes on a surface resize and on a ratio flip (its CSS width is derived from
// the height), so one observer covers both and re-places the live cards.
function relayout() {
  const box = stageBox();
  if (!box.w || !box.h) return;
  document.documentElement.style.setProperty('--scale', String(box.s));
  for (const view of seen.values()) place(view, box);
}

const observer = new ResizeObserver(relayout);
observer.observe(root);

/** Settings document → player: on/off, volume, and the one clip to preload. */
function syncSound(snapSettings) {
  if (!snapSettings) return;
  // describe() entries are `{value, type, …}`; a raw value is accepted too.
  const val = (k, d) => {
    const m = snapSettings[k];
    return m && typeof m === 'object' && 'value' in m ? m.value : m === undefined ? d : m;
  };
  const on = val('sound', false) === true;
  player.setVolume(val('volume', 1));
  player.setEnabled(on);
  const tone = val('tone', DEFAULT_NOTIFY_TONE);
  player.want(on && typeof tone === 'string' && tone ? [tone] : []);
}

const CSS = {
  ios: 't-ios',
  android: 't-android',
  win11: 't-win11',
  macos: 't-macos',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function glyph(style) {
  // A small stand-in for each platform's toast icon; no emoji, so it renders identically everywhere.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'glyph');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  if (style === 'win11' || style === 'win95') path.setAttribute('d', 'M4 4h16v16H4z M6 6h5v5H6z M13 6h5v5h-5z M6 13h5v5H6z');
  else if (style === 'macos') path.setAttribute('d', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14z');
  else path.setAttribute('d', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v7h-2zm0 9h2v2h-2z');
  svg.appendChild(path);
  return svg;
}

function render(entity) {
  const box = el('div', `toast ${CSS[entity.style] || 't-ios'}`);
  box.dataset.id = entity.id;

  // Header row: the app mark, then the label the OS prints beside it. The strip has no
  // app-name field, so the notification type stands in (Android and Windows hide it).
  const head = el('div', 'head');
  const lead = el('div', 'lead');
  lead.appendChild(glyph(entity.style));
  head.appendChild(lead);
  head.appendChild(el('span', 'app', entity.type || 'Notification'));
  box.appendChild(head);

  if (entity.title) box.appendChild(el('div', 'title', entity.title));
  box.appendChild(el('div', 'text', entity.text));

  // Notifications never carry actions: no button row is built and `entity.buttons` is ignored.
  box.addEventListener('click', () => dismiss(entity.id));
  return box;
}

function dismiss(id) {
  // Local close, then tell the server so the panel and other pages agree.
  if (preview) return; // The sample is not a live toast: never DELETE from a preview.
  const view = seen.get(id);
  if (view) {
    view.el.classList.add('leaving');
    setTimeout(() => view.el.remove(), 220);
    seen.delete(id);
  }
  fetch('/api/notifications/live', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {});
}

function apply(snap) {
  if (snap.stack) document.documentElement.style.setProperty('--row-h', `${snap.stack.height}px`);
  if (snap.settings) settings = snap.settings;
  if (snap.settings) syncSound(snap.settings);

  // The ratio is resolved server-side (`default` follows the global wall ratio). Flipping it
  // only changes the stage's width, which the observer turns into a re-place of every live card.
  const nextRatio = snap.ratio === '9:16' ? '9:16' : '16:9';
  if (nextRatio !== ratio) {
    ratio = nextRatio;
    document.documentElement.dataset.ratio = ratio;
  }

  const live = new Map();
  for (const entity of snap.live || []) live.set(entity.id, entity);

  // Retire what is gone.
  for (const [id, view] of seen) {
    if (!live.has(id)) {
      view.el.classList.add('leaving');
      setTimeout(() => view.el.remove(), 220);
      seen.delete(id);
    }
  }
  // Add or update the rest. A toast is appended once and a frame that only re-sends existing
  // records appends nothing, so the tone plays for exactly the banners that are new here. A
  // page that opens over banners that are already up appends none of them and stays silent.
  for (const [id, entity] of live) {
    let view = seen.get(id);
    if (!view) {
      view = { el: render(entity), sig: '', entity };
      root.appendChild(view.el);
      place(view, stageBox());
      if (!preview) player.sync([{ id, sound: 'notify', tone: settings && settings.tone }]);
      // Force layout before the enter class so the slide-in transition runs.
      void view.el.offsetWidth;
      requestAnimationFrame(() => view.el.classList.add('in'));
      seen.set(id, view);
    }
    const sig = JSON.stringify([entity.text, entity.type, entity.title, entity.h, entity.w, entity.y, entity.style]);
    if (view.sig !== sig) {
      view.sig = sig;
      view.entity = entity;
      place(view, stageBox());
      view.el.className = `toast ${CSS[entity.style] || 't-ios'} in`;
    }
  }
  // A deferred deploy reload retries the moment the stack is empty, not up to 25 s later.
  if (seen.size === 0) buildCheck.check();
}

/** This document's identity (`?clientId=`), minted once and kept in `sessionStorage` so a
 *  reload reuses it: the server ends the row that carried the same id (`core/events.mjs`
 *  `attach`), so a reload supersedes its own predecessor instead of stranding a socket. It rides
 *  the poll URL now that there is no socket; the census and the supersede key read the same id. */
function eventClientId() {
  const key = 'shockbox.clientId.notify';
  let id = '';
  try {
    id = sessionStorage.getItem(key) || '';
    if (/^[A-Za-z0-9._:-]{1,64}$/.test(id)) return id;
  } catch {
    /* storage blocked: fall through to a per-load id */
  }
  try {
    if (self.crypto && typeof self.crypto.randomUUID === 'function') id = self.crypto.randomUUID();
  } catch {
    /* fall through to the Math.random id */
  }
  if (!id) {
    id = '';
    for (let i = 0; i < 32; i += 1) id += Math.floor(Math.random() * 16).toString(16);
  }
  try {
    sessionStorage.setItem(key, id);
  } catch {
    /* a per-load id is still valid for this document */
  }
  return id;
}

/* ---------------------------------------------------------------- live poll */

// A poll, not a socket. See public/src/live-poll.js: the origin has six HTTP/1.1 slots and this
// document held one of them for days to learn about a toast every few minutes. One small GET per
// second, closed as soon as it is read; `rev` decides whether anything is applied at all.
//
// `clientId` rides the poll URL: it is the identity the old held socket carried, kept in
// `sessionStorage` so a reload reuses it. The supersede key and the census both read it.
//
// Latency, stated plainly: a toast appears at most one tick (1 s) plus one loopback round trip
// after the server spawns it. A toast lives 4–6 s, so the worst case costs the end of it, never
// the tone: the tone fires from `apply`, which only runs for ids the page has not drawn yet.
const poller = createLivePoll({
  url: () => `/api/notifications/live?clientId=${encodeURIComponent(eventClientId())}&role=${encodeURIComponent('/notify')}`,
  apply,
});

/* ---------------------------------------------------------------- preview sample */

// One representative toast, produced by `apply` → `render`: the same function that renders a real
// toast. `stageBox` already fits the reference column to a preview card, so no extra scaling is
// needed on this page; the toast is centred by `geometry` and clipped only by its own height.
const PREVIEW_TOAST = {
  id: '__preview__',
  style: 'ios',
  type: 'Notification',
  title: 'ShockBox',
  text: 'Notifications look like this on stream.',
  x: 12,
  y: 96,
  w: 381,
  h: 108,
};

// A deploy reaches this document without a human pressing Refresh in OBS. The reload waits while
// a toast is on air: the server holds the toast, so a reload would not drop it, but the entrance
// animation would restart and the card would flicker on stream. The next poll (or the moment the
// stack empties) replaces the document instead.
const buildCheck = createBuildCheck({
  url: '/api/notifications/build',
  key: 'shockbox.build.notify',
  storage: (() => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  })(),
  canReload: () => seen.size === 0,
});

if (preview) {
  // A preview pane is a small iframe inside the control page; reloading it would blink the pane
  // and it always runs whatever the parent just loaded. It never polls and never reconnects.
  apply({ ratio: '16:9', live: [PREVIEW_TOAST] });
} else {
  // First paint is the poller's first tick: a page added mid-stream is correct after one read.
  poller.start();
  buildCheck.start();
}
