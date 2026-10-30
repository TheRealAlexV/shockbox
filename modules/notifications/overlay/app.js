// Notification overlay — the phone strip. Runs as the page behind the 405×720 "Notifications"
// browser source (`V: Main Live`).
//
// Contract with the server: one SSE stream on `notifications`. Every `snapshot` frame carries
// the full live stack, so the page never has to merge deltas — it re-renders the difference.
// Positions are server coordinates (x, y, w in the 405-wide canvas); the page scales by the
// actual element size so a resolution change needs no code change.

const CANVAS_W = 405;
const root = document.getElementById('stage');
const seen = new Map(); // id -> {el, view}
let settings = { style: 'ios' };

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

  if (entity.buttons && entity.buttons.length) {
    const acts = el('div', 'acts');
    for (const b of entity.buttons) {
      const btn = el('button', 'btn', b.label);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        dismiss(entity.id, b.action);
      });
      acts.appendChild(btn);
    }
    box.appendChild(acts);
  }

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
  // Add or update the rest.
  for (const [id, entity] of live) {
    let view = seen.get(id);
    if (!view) {
      view = { el: render(entity), sig: '' };
      root.appendChild(view.el);
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

function connect() {
  const es = new EventSource('/events?channels=notifications&client=notify-overlay');
  es.addEventListener('snapshot', (ev) => {
    try {
      apply(JSON.parse(ev.data));
    } catch (err) {
      console.error('bad snapshot', err);
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
