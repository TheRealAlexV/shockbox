import { HttpError } from '../../core/id.mjs';
import { createDialogState } from './state.mjs';
import { checkTone } from '../notifications/audio-routes.mjs';
import { DEFAULT_DIALOG_TONE } from '../notifications/sound.mjs';

// Alerts module — the dialog side of the popup feature.
//
// Same pool as notifications, different renderer. A message's `kind` decides which module
// spawns it; the control panel's alert tab and the deck's "spawn alert" both land here.
// Nothing in this module stores a message: ids, text and eligibility are core's pool.

export default {
  id: 'dialogs',

  channels: ['dialogs'],

  init(ctx) {
    this.ctx = ctx;
    this.state = createDialogState({ settings: ctx.settings, log: ctx.log });
    this.settings = ctx.settings;
    this.pool = ctx.pool;
    this.events = ctx.events;
    // One sound directory for both popup modules: notifications resolves it in its init
    // (order 20 runs before this module's order 30) and this module reads the same store.
    // Looked up at call time, not copied, so a load order change cannot leave a stale copy.
    const audio = this.soundStore();
    if (!audio) ctx.log.info('sounds: notifications module not up yet — dialogs borrows its sound store per request');
    else {
      const keep = [DEFAULT_DIALOG_TONE];
      if (!audio.has(this.settings.get('tone'), keep)) {
        ctx.log.warn(`sounds: tone "${this.settings.get('tone')}" is not in ${audio.dir.root || '(no directory)'} — it will not play`);
      }
    }
  },

  /** The notifications module's sound store, resolved at call time (module order is mutable). */
  soundStore() {
    const reg = this.ctx.notifications && this.ctx.notifications();
    const entry = reg && reg.byId && reg.byId.get('notifications');
    return entry && entry.status === 'up' ? entry.api.sounds || null : null;
  },

  push(origin = 'server') {
    const snap = this.state.snapshot(origin);
    this.events.publish('dialogs', 'snapshot', snap);
    return snap;
  },

  pickEligible() {
    const list = this.pool.eligible('dialog', 'random');
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  },

  routes() {
    const mod = this;
    const S = () => mod.settings;
    return [
      {
        method: 'GET',
        path: '/audio/list',
        handler() {
          const audio = mod.soundStore();
          if (!audio) throw new HttpError(500, 'notifications module is not up');
          const out = audio.listRoute();
          if (!out.available) throw new HttpError(500, out.error || 'sound directory unavailable');
          return { ...out, key: 'tone' };
        },
      },
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
            // Order matters: an explicit "any" (test/debug) wins; then a pool id; then the
            // random checklist. The poolId branch must not fall through into the random one.
            if (body && body.any === true) spec = mod.pool.all()[0] || null;
            if (!spec && body && typeof body.poolId === 'string') {
              spec = mod.pool.byId(body.poolId);
              if (!spec) throw new HttpError(404, `unknown message ${body.poolId}`);
              if (spec.kind !== 'dialog') throw new HttpError(400, `message ${spec.id} is a notification, not an alert`);
            }
            if (!spec) {
              spec = mod.pickEligible();
              if (!spec) throw new HttpError(409, 'no alert message is checked for random');
            }
          }
          const out = mod.state.spawn(spec, origin);
          if (out.error) throw new HttpError(out.code || 409, out.error);
          if (S().get('sound')) mod.events.emit('dialogs', 'sound', { sound: 'dialog', volume: S().get('volume') });
          mod.push(origin);
          return { ok: true, entity: out.entity };
        },
      },
      {
        method: 'POST',
        path: '/live/measure',
        handler(req, res, url, body) {
          if (!body || typeof body.id !== 'string') throw new HttpError(400, 'id is required');
          const e = mod.state.measure(body.id, body.w, body.h);
          if (!e) throw new HttpError(404, `unknown dialog ${body.id}`);
          mod.push('measure');
          return { ok: true, entity: e };
        },
      },
      {
        method: 'POST',
        path: '/live/storm',
        handler(req, res, url, body) {
          const count = Math.max(1, Math.min(24, Number((body && body.count) || 6)));
          const eligible = body && body.any === true ? mod.pool.all() : mod.pool.eligible('dialog', 'storm');
          if (!eligible.length) throw new HttpError(409, 'no alert message is checked for storm');
          let spawned = 0;
          for (let i = 0; i < count && i < eligible.length; i++) {
            const out = mod.state.spawn(eligible[i], 'storm');
            if (out.error) break;
            spawned++;
          }
          mod.push('storm');
          return { ok: true, spawned };
        },
      },
      {
        method: 'DELETE',
        path: '/live',
        handler(req, res, url) {
          const one = url.searchParams.get('id');
          if (one) {
            if (!mod.state.close(one, 'panel close')) throw new HttpError(404, `unknown dialog ${one}`);
            mod.push('control');
            return { ok: true, closed: 1 };
          }
          const ids = mod.state.closeAll('clear all');
          mod.push('control');
          return { ok: true, closed: ids.length };
        },
      },
      {
        method: 'PATCH',
        path: '/settings',
        handler(req, res, url, body) {
          // `tone` is validated against the files on disk, not a manifest enum.
          const audio = mod.soundStore();
          if (audio) checkTone({ settings: S(), audio }, body);
          const changed = S().patch(body || {});
          if (changed.length) {
            mod.push('control');
            mod.events.emit('dialogs', 'relayout', mod.state.snapshot('settings'));
          }
          return { ok: true, changed, settings: S().describe() };
        },
      },
    ];
  },
};
