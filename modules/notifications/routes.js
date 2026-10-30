import { HttpError } from '../../core/id.mjs';
import { createNotifyState } from './state.mjs';

// Notifications module — the toast side of the popup feature.
//
// Scope (deliberately narrow):
//   • spawn / auto-close / clear the notification stack on the phone strip
//   • storm (fill or random) over notification messages that the pool marks `storm`
//   • its own look: style, height, auto-close, sound
// Everything about messages (ids, text, tags, eligibility) belongs to core/pool.mjs, which the
// alerts module reads too. That is the whole split: this module never stores a message.

export default {
  id: 'notifications',

  channels: ['notifications'],

  init(ctx) {
    this.ctx = ctx;
    this.state = createNotifyState({ settings: ctx.settings, log: ctx.log });
    this.settings = ctx.settings;
    this.pool = ctx.pool;
    this.events = ctx.events;
    // Auto-close is a visual timer, so it is swept here and never persisted.
    this.timer = setInterval(() => {
      try {
        const closed = this.state.sweep();
        if (closed.length) this.push('server');
      } catch (err) {
        ctx.log.error(`auto-close sweep: ${err.message}`);
      }
    }, 400);
    this.timer.unref?.();
    if (!this.pool.length) ctx.log.warn('notifications: pool is empty — nothing to spawn yet');
  },

  dispose() {
    clearInterval(this.timer);
  },

  push(origin = 'server') {
    const snap = this.state.snapshot(origin);
    this.events.publish('notifications', 'snapshot', snap);
    return snap;
  },

  pickEligible() {
    const list = this.pool.eligible('notification', 'random');
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  },

  spawnSpec(spec, origin) {
    const out = this.state.spawn(spec, origin);
    if (out.error) return out;
    return out;
  },

  routes(ctx) {
    const mod = this;
    const S = () => mod.settings;
    return [
      {
        method: 'GET',
        path: '/live',
        handler() {
          return { ok: true, ...mod.state.snapshot('read'), settings: S().describe() };
        },
      },
      {
        method: 'POST',
        path: '/live',
        handler(req, res, url, body) {
          const origin = (body && body.origin) || 'control';
          let spec = body && body.spec;
          if (!spec) {
            if (body && body.any === true) spec = mod.pool.all()[0] || null;
            if (!spec && body && typeof body.poolId === 'string') {
              spec = mod.pool.byId(body.poolId);
              if (!spec) throw new HttpError(404, `unknown message ${body.poolId}`);
              if (spec.kind !== 'notification') throw new HttpError(400, `message ${spec.id} is an alert, not a notification`);
            }
            if (!spec) {
              spec = mod.pickEligible();
              if (!spec) throw new HttpError(409, 'no notification message is checked for random');
            }
          }
          const out = mod.spawnSpec(spec, origin);
          if (out.error) throw new HttpError(out.code || 409, out.error);
          if (S().get('sound')) mod.events.emit('notifications', 'sound', { sound: 'notify', volume: S().get('volume') });
          mod.push(origin);
          return { ok: true, entity: out.entity };
        },
      },
      {
        method: 'DELETE',
        path: '/live',
        handler() {
          const ids = [...mod.state.live.keys()];
          for (const id of ids) mod.state.close(id, 'clear all');
          mod.push('control');
          return { ok: true, closed: ids.length };
        },
      },
      {
        method: 'POST',
        path: '/live/storm',
        handler(req, res, url, body) {
          const mode = body && body.mode === 'random' ? 'random' : 'fill';
          const count = Math.max(1, Math.min(12, Number((body && body.count) || 6)));
          const interval = Math.max(20, Math.min(10000, Number((body && body.interval) || 320)));
          const eligible = mod.pool.eligible('notification', 'storm');
          if (!eligible.length) throw new HttpError(409, 'no notification message is checked for storm');
          const total = mode === 'fill' ? Math.min(eligible.length, 12) : count;
          let spawned = 0;
          const tick = () => {
            if (spawned >= total) return clearInterval(handle);
            const spec = mode === 'fill' ? eligible[spawned % eligible.length] : eligible[Math.floor(Math.random() * eligible.length)];
            const out = mod.spawnSpec(spec, 'storm');
            if (out.error) return clearInterval(handle);
            spawned++;
            mod.push('server');
            if (spawned >= total) clearInterval(handle);
          };
          tick();
          const handle = setInterval(tick, mode === 'fill' ? 90 : interval);
          handle.unref?.();
          return { ok: true, mode, total };
        },
      },
      {
        method: 'PATCH',
        path: '/settings',
        handler(req, res, url, body) {
          // Validation is the schema's job (enum values, min/max from module.json); a second
          // hardcoded allow-list here drifted from it within a day, so there is only one.
          const changed = S().patch(body || {});
          if (changed.length) {
            mod.push('control');
            // Height changes reflow the stack.
            if (changed.includes('height') || changed.includes('style')) {
              mod.events.emit('notifications', 'relayout', mod.state.snapshot('settings'));
            }
          }
          return { ok: true, changed, settings: S().describe() };
        },
      },
    ];
  },
};
