import { HttpError } from '../../core/id.mjs';
import { createDialogState } from './state.mjs';
import { checkTone } from '../notifications/audio-routes.mjs';
import { DEFAULT_DIALOG_TONE, DEFAULT_TONES } from '../notifications/sound.mjs';
// One build id for the whole presentation bundle, hashed once in the notifications module. The
// dialogs page asks its own module (its endpoint should not die with a module it does not own),
// but the answer must be the same value: both popups are deployed together and share `sound.mjs`.
import { OVERLAY_BUILD } from '../notifications/routes.js';

// Alerts module — the dialog side of the popup feature.
//
// Same pool as notifications, different renderer. A message's `kind` decides which module
// spawns it; the control panel's alert tab and the deck's "spawn alert" both land here.
// Nothing in this module stores a message: ids, text and eligibility are core's pool.

// Which messages a random alert may spawn from is a per-module setting, not a per-message
// flag: `randomConfig: { poolIds, tags, messageIds }` selects by any of the three, and an
// empty config means "every dialog message" — what "nothing flagged" used to select.
// The legacy `random` boolean is still readable in the pool and deliberately ignored here.
const EMPTY_SELECTORS = ['poolIds', 'tags', 'messageIds'];

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of EMPTY_SELECTORS) out[key] = idList(cfg[key]);
  return out;
}

/** Every message matching at least one configured selector; an all-empty config matches all. */
export function matchingMessages(records, raw) {
  const cfg = normalizeConfig(raw);
  const pools = new Set(cfg.poolIds);
  const tags = new Set(cfg.tags);
  const ids = new Set(cfg.messageIds);
  if (!pools.size && !tags.size && !ids.size) return records.slice();
  return records.filter((m) => pools.has(m.poolId)
    || ids.has(m.id)
    || (Array.isArray(m.tags) && m.tags.some((t) => tags.has(t))));
}

export default {
  id: 'dialogs',

  channels: ['dialogs'],

  init(ctx) {
    this.ctx = ctx;
    this.state = createDialogState({ settings: ctx.settings, core: ctx.core, log: ctx.log });
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
  },

  dispose() {
    clearInterval(this.timer);
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

  randomConfig() {
    return normalizeConfig(this.settings.get('randomConfig'));
  },

  /**
   * The settings document plus the one derived value a page needs: `ratio` is declared as
   * `default`, but the stage must know whether that resolved to 16:9 or 9:16 right now.
   */
  settingsPayload() {
    const out = this.settings.describe();
    if (out.ratio) out.ratio.effective = this.state.effectiveRatio();
    return out;
  },

  pickEligible() {
    const list = matchingMessages(this.pool.eligible('dialog'), this.randomConfig());
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
          // An absent store is a normal rig state, not a failure: answer the notifications
          // route's shape (200 + available:false) instead of a 500, so the pane can show why.
          if (!audio) {
            return {
              ok: true,
              available: false,
              dir: null,
              files: [],
              error: 'notifications module is not up — no sound directory configured',
              defaults: DEFAULT_TONES,
              key: 'tone',
            };
          }
          return { ...audio.listRoute(), key: 'tone' };
        },
      },
      {
        method: 'GET',
        path: '/build',
        // The dialogs document polls this; the value is the shared presentation bundle id, so a
        // deploy of either popup (or the shell) reaches this page on the same answer.
        handler() {
          return { build: OVERLAY_BUILD };
        },
      },
      {
        method: 'GET',
        path: '/live',
        handler() {
          return { ok: true, ...mod.state.snapshot('read'), settings: mod.settingsPayload() };
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
            // module's random config. The poolId branch must not fall through into the random one.
            if (body && body.any === true) spec = mod.pool.all()[0] || null;
            if (!spec && body && typeof body.poolId === 'string') {
              spec = mod.pool.byId(body.poolId);
              if (!spec) throw new HttpError(404, `unknown message ${body.poolId}`);
              if (spec.kind !== 'dialog') throw new HttpError(400, `message ${spec.id} is a notification, not an alert`);
            }
            if (!spec) {
              spec = mod.pickEligible();
              if (!spec) throw new HttpError(409, 'no alert message matches the random config');
            }
          }
          if (body && body.autoCloseMs !== undefined) spec = { ...spec, autoCloseMs: body.autoCloseMs };
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
        path: '/live',
        handler(req, res, url, body) {
          // The preview pane's record of where the operator dropped the card. The overlay
          // ignores x/y and centres in the stage, so a ratio change can never strand it.
          const id = (body && body.id) || url.searchParams.get('id');
          if (!id) throw new HttpError(400, 'move: id required');
          const moved = mod.state.move(id, body && body.x, body && body.y);
          if (!moved) throw new HttpError(404, `unknown dialog ${id}`);
          mod.push('control');
          return { ok: true, dialog: moved };
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
          return { ok: true, changed, settings: mod.settingsPayload(), ratio: mod.state.effectiveRatio() };
        },
      },
    ];
  },
};
