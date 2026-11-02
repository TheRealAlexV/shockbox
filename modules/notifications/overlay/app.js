// Notification overlay — the phone strip. Runs as the page behind the 405×720 "Notifications"
// browser source (`V: Main Live`).
//
// Contract with the server: one SSE stream on `notifications`. Every `snapshot` frame carries
// the full live stack, so the page never has to merge deltas — it re-renders the difference.
// Positions are server coordinates (x, y, w in the 405-wide canvas); the page scales by the
// actual element size so a resolution change needs no code change.

import { createPlayer, DEFAULT_NOTIFY_TONE } from '/mod/notifications/sound.mjs';

const CANVAS_W = 405;

const root = document.getElementById('stage');
const seen = new Map(); // id -> {el, view}
let settings = { style: 'ios' };

// The tone. One player per page, built from the notifications module's authored asset (so the
// dialogs overlay shares the same code without either module naming the other's page).
const player = createPlayer({ instrument: true });

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
  box.style.width = `${entity.w}px`;
  box.style.height = `${entity.h}px`;
  box.style.left = `${entity.x}px`;
  box.style.top = `${entity.y}px`;

  const left = el('div', 'lead');
  left.appendChild(glyph(entity.style));
  box.appendChild(left);

  const body = el('div', 'body');
  if (entity.title) body.appendChild(el('div', 'title', entity.title));
  body.appendChild(el('div', 'text', entity.text));
  box.appendChild(body);

  // No action buttons: real OS toasts have none. Whatever `entity.buttons` carries is ignored.
  box.addEventListener('click', () => dismiss(entity.id, 'close'));
  return box;
}

function dismiss(id, action) {
  // Local close, then tell the server so the panel and other pages agree. A 'none' action is
  // a no-op button by design (a decoy).
  if (action === 'none') return;
  if (action === 'closeAll') {
    for (const [, view] of seen) view.el.classList.add('leaving');
    setTimeout(() => fetch('/api/notifications/live', { method: 'DELETE' }).catch(() => {}), 180);
    return;
  }
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
      view = { el: render(entity), sig: '' };
      root.appendChild(view.el);
      player.sync([{ id, sound: 'notify', tone: settings && settings.tone }]);
      // Force layout before the enter class so the slide-in transition runs.
      void view.el.offsetWidth;
      requestAnimationFrame(() => view.el.classList.add('in'));
      seen.set(id, view);
    }
    const sig = JSON.stringify([entity.text, entity.type, entity.title, entity.h, entity.w, entity.y, entity.style]);
    if (view.sig !== sig) {
      view.sig = sig;
      view.el.style.top = `${entity.y}px`;
      view.el.style.height = `${entity.h}px`;
      view.el.style.width = `${entity.w}px`;
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
