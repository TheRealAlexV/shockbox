// Alert overlay — fake OS dialogs on the full 16:9 surface, with an optional 9:16 stage.
//
// Four skins, ported from error-popups: win95 (boxed, bevelled), win11 (square, Segoe UI,
// accent primary button), macos (real icon + title, hairline-separated inline buttons) and ios
// (no icon, no titlebar, one centred card with stacked full-width actions).
// The page fills whatever OBS gives it. A ratio of 9:16 centres a portrait stage of width
// height × 9/16 inside that frame; 16:9 is the whole frame. Dialogs are centred by the stage,
// never by an invented server offset.

import { createPlayer, DEFAULT_DIALOG_TONE } from '/mod/notifications/sound.mjs';

// Preview panes mount this page in a small inert iframe (`?preview=1`). The page then draws one
// sample alert through the real build path and never opens a stream or talks to the server, so
// nothing here can register as a live dialog, schedule the auto-close sweep, or reach a second
// tab. Without the param the query string is ignored and the page behaves exactly as before.
const preview = new URLSearchParams(location.search).get('preview') === '1';

const root = document.getElementById('stage');
const els = new Map(); // id -> element
const sizeSent = new Map(); // id -> "w:h"
let theme = 'win11';
let ratio = '16:9';

// The tone. One player per page, from the notifications module's authored asset: both popup
// modules present the same behaviour, and neither page has to know the other one exists.
const player = createPlayer({ instrument: true });

/** Settings document → player: on/off, volume, and the one alert clip to preload. */
function syncSound(snapSettings) {
  if (!snapSettings) return;
  const val = (k, d) => {
    const m = snapSettings[k];
    return m && typeof m === 'object' && 'value' in m ? m.value : m === undefined ? d : m;
  };
  const on = val('sound', false) === true;
  player.setVolume(val('volume', 1));
  player.setEnabled(on);
  const tone = val('tone', DEFAULT_DIALOG_TONE);
  player.want(on && typeof tone === 'string' && tone ? [tone] : []);
  return tone;
}

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
  if (preview) return; // The sample is not a live dialog: never DELETE or POST from a preview.
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

  if (theme !== 'macos' && theme !== 'ios') {
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
  const copy = document.createElement('div');
  copy.className = 'copy';
  if ((theme === 'macos' || theme === 'ios') && entity.title) {
    const head = document.createElement('div');
    head.className = 'mtitle';
    head.textContent = entity.title;
    copy.appendChild(head);
  }
  // iOS alerts carry no app icon at all. Not hidden by CSS: the node is never built, so no
  // empty flex slot or decorative circle can leak back in through a later skin rule.
  const icon = theme === 'ios' ? null : iconEl(entity.icon);
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = entity.text;
  copy.appendChild(msg);
  if (icon) body.appendChild(icon);
  body.appendChild(copy);
  box.appendChild(body);

  const row = document.createElement('div');
  row.className = 'buttons';
  const buttons = Array.isArray(entity.buttons) && entity.buttons.length ? entity.buttons : [{ label: 'OK', action: 'close' }];
  const pi = primaryIndex(buttons);
  buttons.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    // A label like Delete/Remove reads as the destructive choice on iOS and macOS, so the
    // renderer flags it once here instead of every skin guessing from the button order.
    const danger = /^(delete|remove|discard|erase|close all)\b/i.test(b.label || '');
    btn.className = `btn${i === pi ? ' primary' : ''}${danger ? ' danger' : ''}`;
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
  // The stage is the only layout authority: it centres the alert and clips it in 9:16. The
  // server's x/y stays on the record for the preview pane, never as a pixel offset here.
  el.style.width = `${entity.w}px`;
}

function reportSize(el, entity) {
  if (preview) return; // A preview sample has no server record to measure.
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

// Alert ids this page has already sounded. One alert can arrive twice (first paint, then the
// frame that follows it carries the same record), so the id — not the frame — decides.
const announced = new Set();
let firstPaint = true;

function apply(snap) {
  const tone = snap.settings ? syncSound(snap.settings) : undefined;
  // The stage ratio is resolved server-side (default follows the global wall ratio). Applying it
  // to the document re-centres and re-clips existing alerts on the next layout — no reload.
  const nextRatio = snap.ratio === '9:16' ? '9:16' : '16:9';
  if (nextRatio !== ratio) {
    ratio = nextRatio;
    document.documentElement.dataset.ratio = ratio;
  }
  if (snap.settings && snap.settings.theme) {
    const next = snap.settings.theme.value || 'win11';
    if (next !== theme) {
      theme = next;
      document.documentElement.className = `skin-${['win95', 'macos', 'ios'].includes(theme) ? theme : 'win11'}`;
      sizeSent.clear();
    }
    const scale = snap.settings.scale && snap.settings.scale.value;
    if (scale) document.documentElement.style.setProperty('--scale', String(scale));
  }
  const list = Array.isArray(snap.live) ? snap.live : [];
  const seeded = firstPaint;
  firstPaint = false;
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
      // Built once, so a `measure` frame (which only re-sends the record) cannot play again.
      // The very first snapshot seeds: alerts already on screen are not new, so a page load
      // never sounds; everything applied afterwards is a genuinely new alert.
      if (!announced.has(entity.id)) {
        announced.add(entity.id);
        if (!seeded) player.sync([{ id: entity.id, sound: 'dialog', tone }]);
      }
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

/* ---------------------------------------------------------------- stage pointer */

// The show preview POSTs its pointer; the hub re-broadcasts it on `pointer` with x/y normalized
// to the preview surface. Draw it at the same relative spot here — this page is a different
// size, so the fraction is the only coordinate that transfers. Above the dialogs, never a click
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

/* ---------------------------------------------------------------- wiring */

function connect() {
  // `role=` is this document's identity for the server's supersede rule (`core/events.mjs`):
  // a reload ends its own predecessor's bus response instead of leaving it in the browser's
  // six-per-origin pool. The page's path, as `/shockfx` uses; `client=` stays a human label.
  const es = new EventSource('/events?channels=dialogs,pointer&client=alerts-overlay&role=/dialogs');
  es.addEventListener('reset', () => {
    fetch('/api/dialogs/live')
      .then((r) => r.json())
      .then(apply)
      .catch(() => {});
  });
  // The hub sends every frame twice (typed event + `message`) and the EventSource collapses them
  // into `message` only. Re-read the full record once per frame, coalesced while a read is open.
  let pending = null;
  es.addEventListener('message', (ev) => {
    // A `pointer` frame also arrives as `message`; it is not a state change, so do not refetch.
    try {
      if (JSON.parse(ev.data).channel === 'pointer') return;
    } catch {
      /* not our record */
    }
    if (pending) return;
    pending = fetch('/api/dialogs/live')
      .then((r) => r.json())
      .then(apply)
      .catch(() => {})
      .finally(() => {
        pending = null;
      });
  });
  // The show preview's cursor. Flat payload from the hub: {x, y, down, module, t, channel, seq}.
  es.addEventListener('pointer', (ev) => {
    try {
      drawPointer(JSON.parse(ev.data));
    } catch {
      /* malformed frame: leave the last one on screen until it fades */
    }
  });
}

/* ---------------------------------------------------------------- preview sample */

// One representative alert, produced by `apply` → `build`: the same function that renders a real
// alert. The layout of this page is fixed-pixel (unlike the toast page), so a pane-sized card can
// be narrower or shorter than the dialog; a preview-only scale keeps it centred and unclipped.
const PREVIEW_ALERT = {
  id: '__preview__',
  type: 'info',
  icon: 'info',
  title: 'ShockBox',
  text: 'Alerts look like this on stream.',
  buttons: [{ label: 'OK', action: 'close' }],
  w: 380,
};

function fitPreview() {
  const card = root.querySelector('.dialog');
  if (!card) return;
  const box = root.getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  if (!box.width || !box.height || !w || !h) return;
  const scale = Math.min(1, (box.width - 32) / w, (box.height - 32) / h);
  document.documentElement.style.setProperty('--preview-scale', String(Math.max(0.1, scale)));
}

// Draw the sample with the module's current look. GET /api/dialogs/live is the same read-only
// snapshot the live page opens with; only its look fields reach `apply`, so the preview cannot
// preload the alert clip and never writes. A slow or absent hub falls back to the page's own
// defaults (win11, 16:9) instead of leaving the pane blank.
function drawPreview(snapshot) {
  const settings = snapshot && snapshot.settings;
  apply({
    ratio: snapshot && snapshot.ratio === '9:16' ? '9:16' : '16:9',
    settings: settings && settings.theme ? { theme: settings.theme, scale: settings.scale } : undefined,
    live: [PREVIEW_ALERT],
  });
  // `apply` rewrites the root class for the skin, so the preview flag is re-asserted after it.
  document.documentElement.classList.add('preview');
  requestAnimationFrame(fitPreview);
}

if (preview) {
  document.documentElement.classList.add('preview');
  let drawn = false;
  const draw = (snapshot) => {
    if (drawn) return;
    drawn = true;
    drawPreview(snapshot);
  };
  // Read-only read, bounded: abort after 1.5 s and draw the defaults rather than stay empty.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  fetch('/api/dialogs/live', { signal: ctrl.signal })
    .then((r) => r.json())
    .then(draw)
    .catch(() => draw(null))
    .finally(() => clearTimeout(timer));
  new ResizeObserver(() => requestAnimationFrame(fitPreview)).observe(root);
} else {
  fetch('/api/dialogs/live')
    .then((r) => r.json())
    .then((d) => {
      apply(d);
      connect();
    })
    .catch(() => connect());
}
