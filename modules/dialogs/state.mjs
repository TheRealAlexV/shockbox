// Alerts (dialogs) entity state: the fake Windows/macOS dialogs that cascade on the phone strip.
//
// Ported from error-popups' dialog branch. Sizes and positions are in the 405×720 canvas;
// the client may report its measured size back (POST /live/measure) and the placement is
// recomputed from that, exactly as before — the old estimate of 300×105 was only ever a
// placeholder until the page measured itself.

import { num } from '../../core/id.mjs';

export const CANVAS_W = 405;
export const CANVAS_H = 720;

const DEFAULT_W = 300; // authentic 430 × 0.7
const DEFAULT_H = 105; // authentic 150 × 0.7 — placement estimate until a client reports
const MIN_W = 220;
const MAX_W = 385;
const CASCADE_DX = 26;
const CASCADE_DY = 22;
export const MAX_DIALOGS = 80;

export const TYPE_ICON = { Error: 'error', Alert: 'warning', Warning: 'warning', System: 'info', Question: 'question' };
export const ICONS = ['error', 'warning', 'info', 'question', 'none'];

export function iconForType(type, preferred) {
  if (preferred && ICONS.includes(preferred)) return preferred;
  return TYPE_ICON[type] || 'error';
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function createDialogState({ settings, log }) {
  /** id -> entity */
  const live = new Map();
  let rev = 0;
  let spawned = 0;
  let cascadeStep = 0;

  function place(w, h) {
    // Cascade from the top-left, wrapping back when the next step would leave the canvas.
    const col = cascadeStep % 4;
    const row = Math.floor(cascadeStep / 4) % 5;
    let x = 8 + col * CASCADE_DX;
    let y = 12 + row * CASCADE_DY;
    cascadeStep = (cascadeStep + 1) % 20;
    x = clamp(x, 0, Math.max(0, CANVAS_W - w));
    y = clamp(y, 0, Math.max(0, CANVAS_H - h));
    return { x, y };
  }

  function spawn(spec, origin = 'server') {
    if (live.size >= MAX_DIALOGS) return { error: `dialog limit reached (${MAX_DIALOGS})`, code: 409 };
    const w = clamp(num(spec.w, DEFAULT_W), MIN_W, MAX_W);
    const h = clamp(num(spec.h, DEFAULT_H), 60, CANVAS_H);
    const { x, y } = place(w, h);
    const id = `d${++spawned}`;
    const entity = {
      id,
      kind: 'dialog',
      type: spec.type || 'Error',
      title: spec.title || '',
      text: spec.text || '',
      icon: iconForType(spec.type, spec.icon),
      buttons: Array.isArray(spec.buttons) ? spec.buttons : [{ label: 'OK', action: 'close' }],
      theme: settings.get('theme'),
      scale: settings.get('scale'),
      x,
      y,
      w,
      h,
      born: Date.now(),
      origin,
    };
    live.set(id, entity);
    rev++;
    return { entity };
  }

  /** The page reports its measured box; placement and stacking follow the real size. */
  function measure(id, w, h) {
    const e = live.get(id);
    if (!e) return null;
    const nextW = clamp(num(w, e.w), MIN_W, MAX_W);
    const nextH = clamp(num(h, e.h), 60, CANVAS_H);
    if (nextW === e.w && nextH === e.h) return e;
    e.w = nextW;
    e.h = nextH;
    e.x = clamp(e.x, 0, Math.max(0, CANVAS_W - e.w));
    e.y = clamp(e.y, 0, Math.max(0, CANVAS_H - e.h));
    rev++;
    return e;
  }

  function close(id, reason = 'closed') {
    if (!live.has(id)) return null;
    live.delete(id);
    rev++;
    log.info(`dialog ${id} closed (${reason})`);
    return id;
  }

  function closeAll(reason = 'close all') {
    const ids = [...live.keys()];
    for (const id of ids) close(id, reason);
    return ids;
  }

  function snapshot(origin = 'server') {
    return {
      rev,
      live: [...live.values()].sort((a, b) => a.born - b.born),
      count: live.size,
      capacity: MAX_DIALOGS,
      origin,
    };
  }

  return { live, spawn, measure, close, closeAll, snapshot, get rev() { return rev; } };
}
