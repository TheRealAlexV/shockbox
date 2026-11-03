// Notification entity state: the live stack on the toast surface.
//
// Ported from error-popups' notify branch, narrowed to notifications. Layout is a column:
// each new toast sits under the last one, gap = NOTIFY_GAP. The stack never scrolls — when
// it runs past the bottom of the 405×720 reference canvas the spawn is refused with 409 and
// the panel says "stack full", exactly as the old server did.
//
// x/y/w/h stay in that reference canvas: the overlay scales them to whatever surface OBS
// gives it and derives its own geometry from the stage box, so the same stack record is
// right at 405×720, 1920×1080 and inside the centred 9:16 window.

import path from 'node:path';
import { num } from '../../core/id.mjs';
import { DEFAULT_HEIGHT, MAX_STACK } from './constants.mjs';

export const CANVAS_W = 405;
export const CANVAS_H = 720;
export const NOTIFY_X = 12;
export const NOTIFY_GAP = 8;

export function createNotifyState({ settings, core, fs, log }) {
  /** id -> entity */
  const live = new Map();
  let rev = 0;
  let spawned = 0;
  let lastSpawnAt = 0;

  // The show-wide ratio lives in core's own settings document. Core does not hand modules that
  // document (a module's `ctx.settings` is its own), so when it is not exposed through
  // `ctx.core.settings` the module reads the file core persists, cached by mtime: evaluated per
  // frame, read only when the operator changes it.
  let coreCache = { at: 0, ratio: null };
  function globalRatio() {
    const api = core && core.settings;
    if (api && typeof api.get === 'function') return api.get('ratio');
    const dir = core && core.stateDir;
    if (!fs || !dir) return null;
    const file = path.join(dir, 'core', 'settings.json');
    try {
      const at = fs.statSync(file).mtimeMs;
      if (at !== coreCache.at) {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        coreCache = { at, ratio: doc && typeof doc.ratio === 'string' ? doc.ratio : null };
      }
      return coreCache.ratio;
    } catch {
      return null;
    }
  }

  /**
   * The ratio the page draws: `default` follows the show-wide wall ratio, exactly like the wall
   * and dialogs modules, so the deck's ratio key moves every surface. Resolved per frame, never
   * stored — a saved `default` must keep following the global value.
   */
  function effectiveRatio() {
    const own = settings && typeof settings.get === 'function' ? settings.get('ratio') : 'default';
    if (own === '9:16' || own === '16:9') return own;
    return globalRatio() === '9:16' ? '9:16' : '16:9';
  }

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
      // Resolved, never the raw `default`: the page applies a ratio, it does not resolve one.
      ratio: effectiveRatio(),
      live: [...live.values()].sort((a, b) => a.y - b.y),
      stack: { x: NOTIFY_X, gap: NOTIFY_GAP, height: height(), used: live.size, capacity: MAX_STACK },
      lastSpawnAt,
      origin,
    };
  }

  return { live, spawn, close, sweep, snapshot, effectiveRatio, get rev() { return rev; } };
}
