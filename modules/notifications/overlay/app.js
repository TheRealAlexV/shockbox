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
  return { w: r.width, h: r.height, s: r.height > 0 ? r.height / REF_H : 1 };
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
      player.sync([{ id, sound: 'notify', tone: settings && settings.tone }]);
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
}

/* ---------------------------------------------------------------- stage pointer */

// The show preview POSTs its pointer; the hub re-broadcasts it on `pointer` with x/y normalized
// to the preview surface. Draw it at the same relative spot here — this page is a different
// size, so the fraction is the only coordinate that transfers. Above the toasts, never a click
// target, invisible until the first frame arrives.
const cursorEl = document.createElement('div');
cursorEl.className = 'stage-pointer';
cursorEl.innerHTML =
  '<svg viewBox="0 0 20 26" width="22" height="28" aria-hidden="true">' +
  '<path d="M0 0V22L5.8 16.6 9.6 24.9 13 23.4 9.2 15.2 17 14.9Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>' +
  '</svg>';
document.body.appendChild(cursorEl);

let cursorTimer = 0;

function drawPointer(p) {
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
  const dy = p.down ? 2 : 0;
  cursorEl.style.transform = `translate3d(${p.x * window.innerWidth}px, ${p.y * window.innerHeight + dy}px, 0)`;
  cursorEl.style.opacity = '1';
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => {
    cursorEl.style.opacity = '0';
  }, 1500);
}

function connect() {
  const es = new EventSource('/events?channels=notifications,pointer&client=notify-overlay');
  // The hub sends every frame twice (typed event + `message`) and an EventSource here collapses
  // them into `message` only, so the typed listeners are not what runs. Re-read on `message`:
  // one HTTP read of the full record, applied once.
  let pending = null;
  es.addEventListener('message', (ev) => {
    // A `pointer` frame also arrives as `message`; it is not a state change, so do not refetch.
    try {
      if (JSON.parse(ev.data).channel === 'pointer') return;
    } catch {
      /* not our record */
    }
    if (pending) return;
    pending = fetch('/api/notifications/live')
      .then((r) => r.json())
      .then((d) => apply(d))
      .catch(() => {})
      .finally(() => {
        pending = null;
      });
  });
  es.addEventListener('snapshot', (ev) => {
    try {
      apply(JSON.parse(ev.data));
    } catch (err) {
      console.error('bad snapshot', err);
    }
  });
  // The show preview's cursor. Flat payload from the hub: {x, y, down, module, t, channel, seq}.
  es.addEventListener('pointer', (ev) => {
    try {
      drawPointer(JSON.parse(ev.data));
    } catch {
      /* malformed frame: leave the last one on screen until it fades */
    }
  });
  es.addEventListener('reset', () => {
    fetch('/api/notifications/live')
      .then((r) => r.json())
      .then((d) => apply(d))
      .catch(() => {});
  });
  es.addEventListener('error', () => {
    // EventSource reconnects on its own; nothing to do but keep the page alive.
  });
}

// First paint comes from HTTP so a page that is added mid-stream is already correct.
fetch('/api/notifications/live')
  .then((r) => r.json())
  .then((d) => {
    apply(d);
    connect();
  })
  .catch(() => connect());
