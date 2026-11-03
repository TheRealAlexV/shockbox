// Alerts (dialogs) entity state: the fake Windows/macOS dialogs drawn on the 16:9 surface.
//
// Ported from error-popups' dialog branch. Sizes and positions are in the 405×720 canvas;
// the client may report its measured size back (POST /live/measure) and the placement is
// recomputed from that, exactly as before — the old estimate of 300×105 was only ever a
// placeholder until the page measured itself. Positions are the record the preview pane
// reads; the overlay centres its own dialogs in the stage and never invents an offset.

import { num } from '../../core/id.mjs';

export const CANVAS_W = 405;
export const CANVAS_H = 720;

const DEFAULT_W = 300; // authentic 430 × 0.7
const DEFAULT_H = 105; // authentic 150 × 0.7 — placement estimate until a client reports
const MIN_W = 220;
const MAX_W = 385;
export const MAX_DIALOGS = 80;
// A dialog nobody dismisses must not live until the cap. The request may override this, and
// `autoCloseMs: 0` is the deliberate permanent alert.
export const DEFAULT_AUTO_CLOSE_MS = 8000;

export const TYPE_ICON = { Error: 'error', Alert: 'warning', Warning: 'warning', System: 'info', Question: 'question' };
export const ICONS = ['error', 'warning', 'info', 'question', 'none'];

export function iconForType(type, preferred) {
  if (preferred && ICONS.includes(preferred)) return preferred;
  return TYPE_ICON[type] || 'error';
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function createDialogState({ settings, core, log }) {
  /** id -> entity */
  const live = new Map();
  let rev = 0;
  let spawned = 0;

  /**
   * The ratio the page draws: `default` follows the show-wide wall ratio, exactly like the wall
   * module, so the deck's ratio key moves both surfaces. Resolved per frame, never stored.
   */
  function effectiveRatio() {
    const own = settings && typeof settings.get === 'function' ? settings.get('ratio') : 'default';
    if (own === '9:16' || own === '16:9') return own;
    const global = core && core.settings && typeof core.settings.get === 'function' ? core.settings.get('ratio') : null;
    return global === '9:16' ? '9:16' : '16:9';
  }

  function place(w, h) {
    // One deterministic centre: the preview pane still reads x/y, and no skin gets an invented
    // cascade offset that a later ratio change puts off the stage.
    return { x: Math.round((CANVAS_W - w) / 2), y: Math.round((CANVAS_H - h) / 2) };
  }

  function spawn(spec, origin = 'server') {
    if (live.size >= MAX_DIALOGS) return { error: `dialog limit reached (${MAX_DIALOGS})`, code: 409 };
    const w = clamp(num(spec.w, DEFAULT_W), MIN_W, MAX_W);
    const h = clamp(num(spec.h, DEFAULT_H), 60, CANVAS_H);
    const { x, y } = place(w, h);
    const id = `d${++spawned}`;
    const autoCloseMs = Math.max(0, num(spec.autoCloseMs, DEFAULT_AUTO_CLOSE_MS));
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
      autoCloseMs,
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

  /**
   * Where the operator dropped it in the show preview: a record for that pane only. The overlay
   * centres in the stage and ignores x/y, so a drag cannot fight the deterministic centre.
   */
  function move(id, x, y) {
    const e = live.get(id);
    if (!e) return null;
    const nx = clamp(Math.round(num(x, e.x)), 0, Math.max(0, CANVAS_W - e.w));
    const ny = clamp(Math.round(num(y, e.y)), 0, Math.max(0, CANVAS_H - e.h));
    if (nx === e.x && ny === e.y) return e;
    e.x = nx;
    e.y = ny;
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

  /** Close every dialog past its lifetime; `autoCloseMs: 0` stays until it is dismissed. */
  function sweep(now = Date.now()) {
    const out = [];
    for (const e of live.values()) {
      if (e.autoCloseMs > 0 && now - e.born >= e.autoCloseMs) out.push(e.id);
    }
    for (const id of out) close(id, 'auto-close');
    return out;
  }

  function snapshot(origin = 'server') {
    return {
      rev,
      live: [...live.values()].sort((a, b) => a.born - b.born),
      count: live.size,
      capacity: MAX_DIALOGS,
      origin,
      // The stage ratio travels with every frame, resolved (never the raw `default`), so a page
      // that reconnects into a 9:16 show does not have to re-read the settings document.
      ratio: effectiveRatio(),
    };
  }

  return { live, spawn, measure, move, close, closeAll, sweep, snapshot, effectiveRatio, get rev() { return rev; } };
}
