// Notification entity state: the live stack on the phone strip.
//
// Ported from error-popups' notify branch, narrowed to notifications. Layout is a column:
// each new toast sits under the last one, gap = NOTIFY_GAP. The stack never scrolls — when
// it runs past the bottom of the 405×720 canvas the spawn is refused with 409 and the panel
// says "stack full", exactly as the old server did.

import { num } from '../../core/id.mjs';
import { DEFAULT_HEIGHT, MAX_STACK } from './constants.mjs';

export const CANVAS_W = 405;
export const CANVAS_H = 720;
export const NOTIFY_X = 12;
export const NOTIFY_GAP = 8;

export function createNotifyState({ settings, log }) {
  /** id -> entity */
  const live = new Map();
  let rev = 0;
  let spawned = 0;
  let lastSpawnAt = 0;

  function height() {
    return num(settings.get('height'), DEFAULT_HEIGHT);
  }

  function nextY() {
    let y = NOTIFY_X;
    for (const n of [...live.values()].sort((a, b) => a.y - b.y)) y = Math.max(y, n.y + n.h + NOTIFY_GAP);
    return y;
  }

  function spawn(spec, origin = 'server') {
    if (live.size >= MAX_STACK) return { error: `notification stack is at its limit (${MAX_STACK})`, code: 409 };
    const h = height();
    const y = nextY();
    if (y + h > CANVAS_H) return { error: 'notification stack full', code: 409 };
    const autoClose = num(settings.get('autoCloseMs'), 0);
    const id = `n${++spawned}`;
    const entity = {
      id,
      kind: 'notification',
      type: spec.type || 'Info',
      title: spec.title || '',
      text: spec.text || '',
      buttons: Array.isArray(spec.buttons) ? spec.buttons : [],
      style: settings.get('style'),
      x: NOTIFY_X,
      y,
      w: CANVAS_W - NOTIFY_X * 2,
      h,
      born: Date.now(),
      autoCloseMs: autoClose,
      origin,
    };
    live.set(id, entity);
    lastSpawnAt = entity.born;
    rev++;
    return { entity };
  }

  function close(id, reason = 'closed') {
    if (!live.has(id)) return null;
    live.delete(id);
    rev++;
    log.info(`notification ${id} closed (${reason})`);
    // Reflow so the column stays closed up.
    let y = NOTIFY_X;
    for (const n of [...live.values()].sort((a, b) => a.born - b.born)) {
      n.y = y;
      y += n.h + NOTIFY_GAP;
    }
    return id;
  }

  function sweep(now = Date.now()) {
    const out = [];
    for (const n of live.values()) {
      if (n.autoCloseMs > 0 && now - n.born >= n.autoCloseMs) out.push(n.id);
    }
    for (const id of out) close(id, 'auto-close');
    return out;
  }

  function snapshot(origin = 'server') {
    return {
      rev,
      live: [...live.values()].sort((a, b) => a.y - b.y),
      stack: { x: NOTIFY_X, gap: NOTIFY_GAP, height: height(), used: live.size, capacity: MAX_STACK },
      lastSpawnAt,
      origin,
    };
  }

  return { live, spawn, close, sweep, snapshot, get rev() { return rev; } };
}
