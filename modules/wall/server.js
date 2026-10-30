// Wall module — the LED wall's command bus, state and page bookkeeping.
//
// This replaces the ledwall-agent's HTTP server (services/ledwall-agent/server.mjs). The wall
// itself still renders in a browser source; the module is the bus between the control pane, the
// deck and that page:
//
//   POST /api/wall/cmd        {cmd, args, view?}  → validate, ring, broadcast
//   POST /api/wall/state      {view, state}       → last-known engine state (online gate)
//   GET  /api/wall/state                          → gates + views + online
//   PUT  /api/wall/state      {gates}             → only the two liveness gates
//   GET  /api/wall/history?limit=                 → recent commands
//   POST /api/wall/replay     {since}             → resend ring entries after `since`
//
// Frames on the `wall` SSE channel are `{event: 'cmd', data: {seq, cmd, args}}`; the engine page
// treats `seq` as a cursor and asks for a replay on reconnect (see ENGINE-API.md).

import { HttpError } from '../../core/id.mjs';
import { validateCommand, COMMANDS } from './commands.mjs';

// Commands the server answers itself (settings it owns) instead of forwarding to the page bus.
const RATIO_CMDS = { 'ratio.toggle': '_ratioToggle', 'ratio.force16x9': '_ratioForce' };

const RING_MAX = 500;
const STALE_MS = 10_000; // a page that stops posting /state is offline after this
const HISTORY_MAX = 200;

import { createRatioWatcher, normaliseSceneList } from './ratio.mjs';

export default {
  id: 'wall',
  title: 'LED Wall',
  description: 'The dot-matrix wall: patterns, presets, text pool, blackout.',

  channels: ['wall', 'wall-state'],

  pages: { control: { file: 'pages/control.html', title: 'LED wall control' } },

  init(ctx) {
    this.ctx = ctx;
    this.log = ctx.log;
    this.events = ctx.events;
    this.stateDir = ctx.stateDir;
    this.seq = 0;
    this.ring = [];
    this.history = [];
    this.views = { landscape: null, portrait: null };
    this.gates = { landscapeLive: false, portraitLive: false };
    this.lastSnapshot = null;
    this.ratioState = null;
    this.renderRev = 0;
    this.load();
    // Settings are the control pane's document; every change is one snapshot frame, so a
    // freshly loaded OBS page and a deck press converge on the same state. The hook is
    // additive (`ctx.settings.on('change', …)`), never assigned: the core's own onChange is how
    // settings reach disk, and overwriting it would keep the pane's changes in memory only.
    if (ctx.settings && typeof ctx.settings.on === 'function') {
      ctx.settings.on('change', (changed) => {
        this._bumpRender();
        const { look, ratio, fence } = this.renderSettings();
        this.broadcastState({ look, ratio, fence }, 'settings');
        this.pushState();
        this.log.debug(`wall: settings changed (${Object.keys(changed || {}).join(',')})`);
      });
    }
    this.attachRatio();
  },

  // (a17) Desktop/Theater/PHub/OnlyFans/CominOut pin the wall to 16:9 and hand the operator's
  // own ratio back on leave. Edge-triggered on the previous scene and persisted, so a reconnect
  // or a restart inside a forced scene neither re-forces needlessly nor forgets the restore.
  attachRatio() {
    const ctx = this.ctx;
    this.ratio = createRatioWatcher({
      settings: ctx.settings,
      obs: ctx.obs,
      log: this.log,
      // The list lives in core settings (edited once, reported by /health); fall back to the
      // module's own document so an isolated test harness still works.
      sceneList: () => this.forceScenes(),
      persist: (st) => {
        this.ratioState = st;
        this.save();
      },
    });
    this.ratio.load(this.ratioState);
    this.unattach = this.ratio.attach();
  },

  /** Scene forcing list. Core owns it; the wall only reads it. */
  forceScenes() {
    const core = (this.ctx.core && this.ctx.core.settings) || this.ctx.settings;
    const v = core && typeof core.get === 'function' ? core.get('forceScenes') : null;
    return normaliseSceneList(v);
  },

  file(name) {
    return this.ctx.paths?.stateFile ? this.ctx.paths.stateFile('wall', name) : null;
  },

  load() {
    // Best effort: a missing or corrupt state file must not stop the module coming up.
    try {
      const fs = this.ctx.fs;
      const f = this.file('state.json');
      if (!f || !fs) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(this.gates)) {
          if (typeof raw.gates?.[k] === 'boolean') this.gates[k] = raw.gates[k];
        }
        for (const v of Object.keys(this.views)) {
          const s = raw.views?.[v];
          if (s && typeof s === 'object') this.views[v] = s;
        }
        if (raw.lastSnapshot && typeof raw.lastSnapshot === 'object') this.lastSnapshot = raw.lastSnapshot;
        if (raw.ratioState && typeof raw.ratioState === 'object') this.ratioState = raw.ratioState;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`wall: cannot read state (${err.message})`);
    }
  },

  save() {
    // State writes arrive on every scene change and every page heartbeat (1 Hz per page), so
    // they are debounced rather than written per call.
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const fs = this.ctx.fs;
        const f = this.file('state.json');
        if (!f || !fs) return;
        fs.mkdirSync(this.ctx.paths.dir('wall'), { recursive: true });
        const tmp = `${f}.tmp`;
        fs.writeFileSync(
          tmp,
          JSON.stringify(
            { gates: this.gates, views: this.views, lastSnapshot: this.lastSnapshot || null, ratioState: this.ratioState || null },
            null,
            1,
          ),
        );
        fs.renameSync(tmp, f);
      } catch (err) {
        this.log.warn(`wall: state save failed (${err.message})`);
      }
    }, 250);
    this._saveTimer.unref?.();
  },

  online(view) {
    const s = this.views[view];
    return Boolean(s && Number.isFinite(s.received) && Date.now() - s.received < STALE_MS);
  },

  snapshot() {
    return {
      seq: this.seq,
      gates: { ...this.gates },
      views: { ...this.views },
      online: { landscape: this.online('landscape'), portrait: this.online('portrait') },
      history: this.history.slice(-30),
    };
  },

  pushState() {
    const snap = this.state();
    this.events.publish('wall-state', 'snapshot', snap);
    return snap;
  },

  /**
   * Tell every wall page what the control pane just changed. This is a *state* frame, not a
   * command: the page applies it as a settings snapshot (the same patch model presets use),
   * and it is what makes a fresh OBS page load correct without touching the deck.
   */
  /**
   * The settings document the render pages boot from. The engine's own look keys are carried
   * verbatim (it merges them over its defaults), and the two ShockBox-only keys (ratio, fence)
   * ride alongside: the page's ratio is per-source, the fence is shared.
   */
  renderSettings() {
    const s = this.ctx.settings;
    const look = {};
    if (s) {
      for (const [k, v] of Object.entries(s.all())) {
        if (k === 'ratio' || k === 'fence' || k === 'forceScenesRestore') continue;
        look[k] = v;
      }
    }
    return {
      look,
      ratio: s ? s.get('ratio') : '16:9',
      // The fence the engine sees is in CELLS (it is a grid window, not a pixel clip), derived
      // here so the operator can keep dragging pixels in the control pane and the GPU never has
      // to round on its own. `grid` is whichever page is live; the value is advisory for the pane.
      fence: s ? this.fenceCellsFor(s.get('fence')) : null,
      rev: this.renderRev,
    };
  },

  /**
   * Whole-cell window from a pixel rect, using the landscape page's grid (the one source OBS
   * loads). The engine re-snaps against its own grid anyway; this is what the pane shows.
   */
  fenceCellsFor(px) {
    if (!px || !(px.w > 0) || !(px.h > 0)) return null;
    const s = this.ctx.settings;
    const cols = Math.max(4, Math.round(Number(s ? s.get('gridCols') : 0) || 112));
    const scale = 2; // the engine's default scale; the page reports its real one on heartbeat
    const W = 1280 * scale;
    const H = 720 * scale;
    const pitchX = W / cols;
    const rows = Math.max(4, Math.round(Number(s ? s.get('gridRows') : 0) || 0) || Math.round(H / pitchX));
    const pitchY = H / rows;
    const x0 = Math.max(0, Math.min(cols - 2, Math.round(px.x / pitchX)));
    const y0 = Math.max(0, Math.min(rows - 2, Math.round(px.y / pitchY)));
    const y1 = Math.min(rows, Math.max(y0 + 2, Math.round((px.y + px.h) / pitchY)));
    const x1 = Math.min(cols, Math.max(x0 + 2, x0 + Math.round((y1 - y0) * (9 / 16) * (pitchY / pitchX))));
    // Wire shape: the engine takes `cells` (whole-cell window) and the pane takes `px` (the
    // operator's drag rect). Both, so neither has to recompute the other's unit.
    return {
      cells: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      px: { ...px },
      pitch: { x: pitchX, y: pitchY },
      cols,
      rows,
    };
  },

  /** Bump on every settings change so a page can skip an unchanged snapshot. */
  _bumpRender() {
    this.renderRev = (this.renderRev || 0) + 1;
  },

  broadcastState(rawPatch, note = 'settings', live = false) {
    // Settings changes hand over the raw `fence` (pixels); the page needs the cells.
    const patch = rawPatch && rawPatch.fence !== undefined
      ? { ...rawPatch, fence: this.fenceCellsFor(rawPatch.fence) }
      : rawPatch;
    // Wire shape: `{rev, look, ratio, fence}` at the top level, so the page's snapshot handler
    // and the (re)connect replay read one flat record. `rev` lets the page skip a replayed frame.
    // `fence` is tri-state on the wire: absent = "unchanged, keep the page's own", null =
    // "the wall is whole". Coercing absent to null is what made a look-only snapshot close the
    // window the operator had just opened.
    // A frame carries only the fields the caller changed; absent means "unchanged". Writing
    // `null` for an absent field is what let a fence-only drag (10 Hz during a drag) erase the
    // persisted look, so the snapshot is merged, not replaced.
    const snap = { rev: this.renderRev || 0, note, t: Date.now() };
    if (Object.prototype.hasOwnProperty.call(patch, 'look')) snap.look = patch.look || null;
    if (Object.prototype.hasOwnProperty.call(patch, 'ratio')) snap.ratio = patch.ratio ?? null;
    if (Object.prototype.hasOwnProperty.call(patch, 'fence')) snap.fence = patch.fence || null;
    // `live` frames are drag previews: they reach the pages and are not persisted. Only the
    // committed value (a settings PATCH) becomes `lastSnapshot`, so a restart inside a drag
    // restores what the operator actually chose.
    if (!live) {
      this.lastSnapshot = { ...(this.lastSnapshot || {}), ...snap };
      this.save();
    }
    this.events.emit('wall', 'state.snapshot', snap);
    return snap;
  },

  /** What /api/modules/wall/state answers: the bus view, the settings document, the ratio. */
  state() {
    return {
      ...this.snapshot(),
      commands: COMMANDS,
      settings: this.ctx.settings ? this.ctx.settings.describe() : null,
      snapshot: this.lastSnapshot || null,
      ratio: this.ratio ? this.ratio.state : null,
    };
  },

  /** What /api/modules/wall/state answers: the bus view, the settings document, the ratio. */
  state() {
    return {
      ...this.snapshot(),
      commands: COMMANDS,
      settings: this.ctx.settings ? this.ctx.settings.describe() : null,
      snapshot: this.lastSnapshot || null,
      ratio: this.ratio ? this.ratio.state : null,
    };
  },

  send(cmd, args = {}, view = null) {
    const { rec, view: scope } = validateCommand(cmd, args, view);
    // Ratio commands are answered by the server, not the page: the ratio is persisted here and
    // a forcing scene must win over the key (a17).
    if (Object.prototype.hasOwnProperty.call(RATIO_CMDS, cmd)) {
      const out = this[RATIO_CMDS[cmd]]();
      return { ...out, cmd, delivered: out.delivered };
    }
    this.seq += 1;
    const entry = { seq: this.seq, cmd, args: rec, t: Date.now(), view: scope };
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.shift();
    this.history.push({ seq: entry.seq, cmd, view: scope, t: entry.t });
    if (this.history.length > HISTORY_MAX) this.history.shift();
    const frame = { seq: entry.seq, cmd, args: rec, view: scope };
    // The bus already keeps its own per-channel ring for reconnect replay; this one carries the
    // delivery scope, which the bus's `view` argument only uses as a filter.
    // publish(channel, cmd, args, view): the command NAME and its ARGS are separate parameters.
    // Passing the whole frame as `cmd` is how the page saw `cmd: "cmd"` and ignored everything.
    this.events.publish('wall', cmd, rec, scope);
    const delivered = (this.events.clientsByChannel?.() || {}).wall || 0;
    this.log.info(`wall ${entry.seq} ${cmd} ${scope || '*'}`);
    return { seq: entry.seq, delivered };
  },

  /** 9:16 <-> 16:9, refused inside a forcing scene. */
  _ratioToggle() {
    const cur = this.ctx.settings.get('ratio') || '16:9';
    const next = cur === '16:9' ? '9:16' : '16:9';
    if (next === '9:16' && this.ratio && this.ratio.state.forcing) {
      this.log.info(`ratio: ${this.ratio.state.lastScene} forces 16:9 — toggle ignored`);
      return { seq: this.seq, delivered: 0, ok: false, note: 'refused: scene forces 16:9', ratio: cur };
    }
    this.ctx.settings.set('ratio', next);
    return { seq: this.seq, delivered: 0, ok: true, note: 'ratio', ratio: next };
  },

  // Put it back to 16:9 whatever happened: the pane's escape hatch.
  _ratioForce() {
    // Inside a forcing scene the wall is already 16:9, and `sync` would overwrite the ratio the
    // operator will get back on leaving: "force 16:9" must not eat the remembered 9:16.
    if (this.ratio && this.ratio.state.forcing) {
      return { seq: this.seq, ok: true, note: 'already forced by the active scene', ratio: '16:9' };
    }
    this.ctx.settings.set('ratio', '16:9');
    return { seq: this.seq, ok: true, note: 'ratio', ratio: '16:9' };
  },

  routes() {
    const mod = this;
    const S = () => mod.ctx.settings;
    return [
      {
        // One snapshot for the control pane: settings document, ratio state, engine document
        // and the last broadcast, so a refresh is a single round trip (notifications' shape).
        method: 'GET',
        path: '/live',
        handler() {
          return {
            ok: true,
            seq: mod.seq,
            online: mod.snapshot().online,
            history: mod.history.slice(-30),
            commands: COMMANDS,
            settings: S().describe(),
            ratio: mod.ratio ? mod.ratio.state : null,
            render: mod.renderSettings(),
            snapshot: mod.lastSnapshot || null,
          };
        },
      },
      {
        method: 'PATCH',
        path: '/settings',
        handler(req, res, url, body) {
          // Schema validation is the module manifest's job, exactly as notifications does it.
          const changed = S().patch(body || {});
          if (changed.length && mod.events) {
            mod._bumpRender();
            const { look, ratio, fence } = mod.renderSettings();
            mod.broadcastState({ look, ratio, fence }, 'settings');
            mod.pushState();
          }
          return { ok: true, changed, settings: S().describe(), ratio: mod.ratio ? mod.ratio.state : null };
        },
      },
      {
        method: 'POST',
        path: '/cmd',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
          const view = body.view === undefined ? null : body.view;
          // An explicit `view` alongside a page-scoped command is a contradiction; validate
          // rejects a bad view, and a scope mismatch is honest to refuse too.
          const out = mod.send(body.cmd, body.args || {}, view);
          // The dispatcher's own answer rides along: a ratio command answers `{ratio}` and a
          // refused toggle answers `ok:false`. Rebuilding the body here silently dropped both,
          // which made a dead ratio key look like a working ones (2026-10-29).
          return {
            ...out,
            ok: out.ok !== false,
            note: out.note || 'delivered counts SSE writes, not acknowledgements',
            delivered: out.delivered,
          };
        },
      },
      {
        method: 'GET',
        path: '/cmd',
        handler() {
          return { ok: true, commands: COMMANDS, seq: mod.seq };
        },
      },
      {
        method: 'POST',
        path: '/state',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
          const view = body.view;
          if (view !== 'landscape' && view !== 'portrait') throw new HttpError(400, 'view must be landscape | portrait');
          if (!body.state || typeof body.state !== 'object') throw new HttpError(400, 'state must be an object');
          // The page may report anything it likes; `received` is ours so a skewed page clock
          // cannot make itself look permanently online.
          const clean = { ...body.state };
          delete clean.received;
          mod.views[view] = { ...clean, received: Date.now() };
          mod.save();
          return { ok: true, online: mod.online(view) };
        },
      },
      {
        method: 'GET',
        path: '/render',
        handler() {
          return { ok: true, settings: mod.renderSettings(), online: { landscape: mod.online('landscape'), portrait: mod.online('portrait') }, seq: mod.seq };
        },
      },
      {
        method: 'GET',
        path: '/state',
        handler() {
          const { ratio, ...rest } = mod.state();
          return { ok: true, ...rest, ratio };
        },
      },
      {
        method: 'PUT',
        path: '/state',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
          const extra = Object.keys(body).filter((k) => k !== 'gates');
          if (extra.length) throw new HttpError(400, `PUT /state accepts {gates} only — unexpected: ${extra.join(', ')}`);
          if (!body.gates || typeof body.gates !== 'object') throw new HttpError(400, 'gates must be an object');
          for (const [k, v] of Object.entries(body.gates)) {
            if (!(k in mod.gates)) throw new HttpError(400, `unknown gate: ${k}`);
            if (typeof v !== 'boolean') throw new HttpError(400, `gate ${k} must be a boolean`);
            mod.gates[k] = v;
          }
          mod.save();
          mod.pushState();
          return { ok: true, gates: { ...mod.gates } };
        },
      },
      {
        method: 'POST',
        path: '/broadcast',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
          if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
            throw new HttpError(400, 'patch must be an object');
          }
          if (JSON.stringify(body.patch).length > 16 * 1024) throw new HttpError(400, 'patch > 16 KB');
          // A drag previews the fence and nothing else: any other key here would be a second,
          // unvalidated write path to settings the schema owns. Real look changes go through
          // PATCH /settings, which validates against the manifest.
          const keys = Object.keys(body.patch).filter((k) => k !== 'fence');
          if (keys.length) throw new HttpError(400, `/broadcast carries the fence only — unexpected: ${keys.join(', ')}`);
          // Bumped before the frame is built so its `rev` is fresh: a page drops a frame whose
          // revision it already has, and a live drag preview followed by its commit carry the
          // same rect — an un-bumped second frame read as "unchanged" and never landed.
          mod._bumpRender();
          const snap = mod.broadcastState(
            body.patch,
            typeof body.note === 'string' ? body.note : 'settings',
            body.live === true,
          );
          mod.pushState();
          return { ok: true, seq: snap.seq };
        },
      },
      {
        // Commit a fence rect the operator dragged: same value, but it becomes the persisted
        // document (a live drag never does) and reaches every page as a normal snapshot.
        method: 'PUT',
        path: '/fence',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
          const f = body.fence;
          if (f !== null) {
            if (!f || typeof f !== 'object') throw new HttpError(400, 'fence must be an object or null');
            for (const k of ['x', 'y', 'w', 'h']) {
              if (!Number.isFinite(Number(f[k]))) throw new HttpError(400, `fence.${k} must be a number`);
            }
            if (Number(f.w) < 1 || Number(f.h) < 1) throw new HttpError(400, 'fence w/h must be positive');
            // Persist as well as broadcast. A broadcast-only PUT moved the pane and the OBS pages
            // and left the settings document on the old rect, so every `/live` poll and every
            // settings frame repainted the window where it used to be — a drag that "did not
            // commit" while the wall had already moved.
            S().assign('fence', { x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h) });
          }
          mod._bumpRender();
          const snap = mod.broadcastState({ fence: f }, 'fence');
          mod.pushState();
          return { ok: true, fence: snap.fence, rev: snap.rev };
        },
      },
      {
        method: 'GET',
        path: '/history',
        handler(req, res, url) {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 50, HISTORY_MAX);
          return { ok: true, commands: mod.history.slice(-limit) };
        },
      },
      {
        method: 'POST',
        path: '/replay',
        handler(req, res, url, body) {
          const since = Number(body && body.since);
          if (!Number.isFinite(since)) throw new HttpError(400, 'since must be a number');
          // A page whose cursor is older than the ring must be told to resync, not silently
          // skipped: the gap is exactly the bug the old agent had.
          const oldest = mod.ring.length ? mod.ring[0].seq : mod.seq + 1;
          if (since + 1 < oldest) return { ok: true, reset: true, seq: mod.seq };
          const frames = mod.ring.filter((e) => e.seq > since).map((e) => ({ seq: e.seq, cmd: e.cmd, args: e.args, view: e.view }));
          return { ok: true, reset: false, seq: mod.seq, frames };
        },
      },
    ];
  },
};
