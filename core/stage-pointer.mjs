// Stage pointer — the show preview's cursor, broadcast to the OBS overlays.
//
// One value, in memory: the preview page POSTs the last position it saw, and every page on the
// `pointer` channel of the existing SSE hub draws it. No second bus, no second port — OBS caps
// HTTP/1.1 connections per host at 6, and both overlays already hold an EventSource.
//
// Wire contract:
//   POST /api/stage/pointer   { x, y, down, module }   x/y normalized 0..1 in the preview surface
//   GET  /api/stage/pointer                            the stored value + `t`
//   SSE  event: pointer                                the same payload + `t`
//
// The frame is `publish`ed rather than `emit`ted: publish's typed event name IS the channel, so
// `event: pointer` arrives with the payload flat on the record — exactly what the overlays read.
// Not ring-replayed by any client that matters; a stale cursor is worse than none, and the
// pages fade a silent one out after 1.5 s anyway.

import { HttpError, clamp, isObj } from './id.mjs';

export const POINTER_CHANNEL = 'pointer';
const MODULE_MAX = 32;
const EMPTY = { x: null, y: null, down: false, module: null, t: null };

export function createPointer({ events }) {
  let last = null;

  function parse(body) {
    if (!isObj(body)) throw new HttpError(400, 'body must be a JSON object');
    if (typeof body.x !== 'number' || !Number.isFinite(body.x)) throw new HttpError(400, 'x must be a finite number');
    if (typeof body.y !== 'number' || !Number.isFinite(body.y)) throw new HttpError(400, 'y must be a finite number');
    if (body.down !== undefined && typeof body.down !== 'boolean') throw new HttpError(400, 'down must be a boolean');
    if (body.module !== undefined && typeof body.module !== 'string') throw new HttpError(400, 'module must be a string');
    return {
      x: clamp(body.x, 0, 1),
      y: clamp(body.y, 0, 1),
      down: body.down === true,
      module: (body.module || 'stage').slice(0, MODULE_MAX),
    };
  }

  return {
    /** Last pointer plus `t`, or nulls before the first POST — a page that never sees one is fine. */
    get() {
      return last ? { ...last } : { ...EMPTY };
    },
    /** Validate, clamp, store, broadcast. Returns the stored value. */
    set(body) {
      last = { ...parse(body), t: Date.now() };
      events.publish(POINTER_CHANNEL, null, { ...last });
      return { ...last };
    },
  };
}
