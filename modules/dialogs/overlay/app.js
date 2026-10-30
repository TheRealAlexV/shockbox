// Alert overlay — fake OS dialogs on the 405×720 phone strip (`V: Main Live`).
//
// Three skins, ported from error-popups: win95 (boxed, bevelled), win11 (flat, 8 px radius,
// accent primary button) and macos (no title bar, centred heading, hairline-separated buttons).
// Placement is server-side; the page reports its measured box back so the server can centre
// against the real height instead of a guess.

const root = document.getElementById('desk');
const els = new Map(); // id -> element
const sizeSent = new Map(); // id -> "w:h"
let theme = 'win11';

/* ---------------------------------------------------------------- icons */

const ICONS = {
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

function iconEl(name) {
  if (!name || name === 'none') return null;
  const wrap = document.createElement('div');
  wrap.className = 'icon';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ICONS.error;
  wrap.appendChild(svg);
  return wrap;
}

/* ---------------------------------------------------------------- build */

function primaryIndex(buttons) {
  // The destructive-looking default is index 0 for macos (bold) and the last button for
  // Windows (the accent action sits on the right). Matches the old overlay.
  const spawn = buttons.findIndex((b) => b.action === 'spawn');
  if (spawn !== -1) return spawn;
  return theme === 'macos' ? 0 : buttons.length - 1;
}

function decide(entity, button) {
  const id = entity.id;
  const action = button.action || 'close';
  if (action === 'none') return;
  if (action === 'closeAll') {
    fetch('/api/dialogs/live', { method: 'DELETE' }).catch(() => {});
    return;
  }
  if (action === 'spawn') {
    // A decoy button that pops another popup: the joke is it never dismisses the first one.
    const kind = button.kind === 'dialog' ? 'dialogs' : 'notifications';
    const spec = { text: button.text || entity.text, title: button.title || '', type: entity.type, buttons: [{ label: 'OK', action: 'close' }] };
    fetch(`/api/${kind}/live`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec, origin: 'button' }) }).catch(() => {});
    return;
  }
  fetch(`/api/dialogs/live?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

function build(entity) {
  const box = document.createElement('div');
  box.className = 'dialog';
  box.dataset.id = entity.id;

  if (theme !== 'macos') {
    const bar = document.createElement('div');
    bar.className = 'titlebar';
    const title = document.createElement('div');
    title.className = 'ttitle';
    title.textContent = entity.title || '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tclose';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => decide(entity, { action: 'close' }));
    bar.append(title, close);
    box.appendChild(bar);
  }

  const body = document.createElement('div');
  body.className = 'body';
  if (theme === 'macos' && entity.title) {
    const head = document.createElement('div');
    head.className = 'mtitle';
    head.textContent = entity.title;
    body.appendChild(head);
  }
  const icon = iconEl(entity.icon);
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = entity.text;
  if (icon) body.appendChild(icon);
  body.appendChild(msg);
  box.appendChild(body);

  const row = document.createElement('div');
  row.className = 'buttons';
  const buttons = Array.isArray(entity.buttons) && entity.buttons.length ? entity.buttons : [{ label: 'OK', action: 'close' }];
  const pi = primaryIndex(buttons);
  buttons.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn${i === pi ? ' primary' : ''}`;
    btn.textContent = b.label || 'OK';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      decide(entity, b);
    });
    row.appendChild(btn);
  });
  box.appendChild(row);
  return box;
}

function place(el, entity) {
  el.style.left = `${entity.x}px`;
  el.style.top = `${entity.y}px`;
  el.style.width = `${entity.w}px`;
}

function reportSize(el, entity) {
  const w = Math.round(el.offsetWidth);
  const h = Math.round(el.offsetHeight);
  if (!w || !h) return;
  const sig = `${w}:${h}`;
  if (sizeSent.get(entity.id) === sig) return;
  sizeSent.set(entity.id, sig);
  fetch('/api/dialogs/live/measure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: entity.id, w, h }),
  }).catch(() => {});
}

function apply(snap) {
  if (snap.settings && snap.settings.theme) {
    const next = snap.settings.theme.value || 'win11';
    if (next !== theme) {
      theme = next;
      document.documentElement.className = `skin-${theme === 'win95' || theme === 'macos' ? theme : 'win11'}`;
      sizeSent.clear();
    }
    const scale = snap.settings.scale && snap.settings.scale.value;
    if (scale) document.documentElement.style.setProperty('--scale', String(scale));
  }
  const list = Array.isArray(snap.live) ? snap.live : [];
  const live = new Set(list.map((d) => d.id));
  for (const [id, el] of els) {
    if (!live.has(id)) {
      el.classList.add('leaving');
      els.delete(id);
      setTimeout(() => el.remove(), 160);
    }
  }
  for (const entity of list) {
    let el = els.get(entity.id);
    if (!el) {
      el = build(entity);
      place(el, entity);
      root.appendChild(el);
      requestAnimationFrame(() => {
        el.classList.add('in');
        reportSize(el, entity);
      });
      els.set(entity.id, el);
    } else {
      place(el, entity);
      reportSize(el, entity);
    }
  }
}

/* ---------------------------------------------------------------- wiring */

function connect() {
  const es = new EventSource('/events?channels=dialogs&client=alerts-overlay');
  es.addEventListener('snapshot', (ev) => {
    try {
      apply(JSON.parse(ev.data));
    } catch (err) {
      console.error('bad snapshot', err);
    }
  });
  es.addEventListener('reset', () => {
    fetch('/api/dialogs/live')
      .then((r) => r.json())
      .then(apply)
      .catch(() => {});
  });
}

fetch('/api/dialogs/live')
  .then((r) => r.json())
  .then((d) => {
    apply(d);
    connect();
  })
  .catch(() => connect());
