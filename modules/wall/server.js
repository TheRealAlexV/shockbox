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
import fs from 'node:fs';
import path from 'node:path';
import { validateCommand, COMMANDS } from './commands.mjs';
import { MAX_BYTES, acceptUpload, nameFor } from './image.mjs';

// Commands the server answers itself (settings it owns) instead of forwarding to the page bus.
const RATIO_CMDS = { 'ratio.toggle': '_ratioToggle', 'ratio.force16x9': '_ratioForce' };

const RING_MAX = 500;
const STALE_MS = 10_000; // a page that stops posting /state is offline after this
const HISTORY_MAX = 200;

// The wall's text pool is the core message pool, filtered to the wall's own pool id
// (`kind: 'wall'`). Resolved here rather than on the page: the page has only a
// last-known snapshot, so a message edited after the send would render stale — and a
// `poolId` that resolves to nothing must fail at the POST, not silently on the wall.
const WALL_POOL = 'wall';

// What a preset captures — the look of the wall. Deliberately excludes grid geometry (a property
// of the installation, not of a look) and everything under `views.*.text` (a preset must never
// touch a text-mode message pool).
//
// Two runtimes need this list: this module writes a preset to disk, and the render page applies
// one. Keeping a copy in each is how `image*` came to be captured here and not there, so the list
// is read out of the engine source once, at load, and fails loudly if it cannot be.
const PRESET_DIMS = readPresetDims();

function readPresetDims() {
  const src = fs.readFileSync(new URL('./engine/engine.js', import.meta.url), 'utf8');
  const m = /var PRESET_DIMS = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error('wall: PRESET_DIMS not found in engine/engine.js');
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  const dims = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (!dims.length) throw new Error('wall: PRESET_DIMS in engine/engine.js is empty');
  return dims;
}

function poolMessage(pool, id) {
  const rec = pool && typeof pool.byId === 'function' ? pool.byId(id) : null;
  return rec && rec.kind === WALL_POOL ? rec : null;
}

function poolSlot(pool, slot) {
  const list = pool && typeof pool.list === 'function' ? pool.list() : [];
  const mine = list.filter((m) => m.kind === WALL_POOL);
  return mine[slot - 1] || null;
}

/** Turn a `poolId`/`slot` send into the `item` the engine consumes. */
export function resolvePoolArgs(pool, args) {
  if (args && typeof args.item === 'object' && args.item) return args;
  if (!args || (args.poolId === undefined && args.slot === undefined)) return args;
  const rec = args.poolId !== undefined ? poolMessage(pool, args.poolId) : poolSlot(pool, args.slot);
  if (!rec) {
    const what = args.poolId !== undefined ? `pool message ${args.poolId}` : `wall pool slot ${args.slot}`;
    throw new HttpError(404, `text.send: no ${what}`);
  }
  const item = {
    id: rec.id,
    title: rec.title || '',
    paras: [{ align: 'center', runs: [{ t: rec.text }] }],
  };
  // The scope must survive resolution: validateCommand reads `args.view`, and a send that
  // loses it is addressed to nobody and silently ignored by every page.
  const out = { item };
  for (const k of ['duration', 'view', 'preset', 'pattern', 'safe']) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  return out;
}

import { createRatioWatcher, normaliseSceneList } from './ratio.mjs';

export default {
  id: 'wall',
  title: 'LED Wall',
  description: 'The dot-matrix wall: patterns, presets, text pool, blackout.',

  channels: ['wall', 'wall-state'],

  // The pane (module.json `ui.pane` → ui/pane.js) is the operator surface; there is no
  // separate control.html page. A page entry here is only for what OBS loads as a browser
  // source, and that is declared in module.json `pages[]`.
  pages: {},

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
    // Operator-saved presets (`preset.save`). Kept beside the module state, not inside the
    // wall's settings document: a preset is a *look*, and the shipped ones live in the engine
    // (engine/presets/presets.js). This is the only place a saved look is stored.
    this.savedPresets = {};
    // The image layer's file, as last accepted by `POST /api/wall/image`. `rev` is what the
    // engine keys its texture on: a new upload bumps it, and a page that renders the revision it
    // already holds never re-downloads the picture. The bytes live under the wall's state dir.
    this.image = null; // { rev, file, mime, w, h, bytes, name }
    this.imageRev = 0;
    // Every picture a saved preset might point at. A preset captures `imageRev`, so restoring a
    // look has to be able to serve the revision it names even when a newer upload replaced the
    // live one; `revs` is `{ [rev]: { rev, file, mime, w, h, bytes } }`, loaded from disk.
    this.imageRevs = {};
    this.load();
    this.loadImage();
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

  /** Where an upload is stored: `<state>/wall/images/<sha1>.<ext>`. */
  imageDir() {
    const fs = this.ctx.fs;
    const d = this.file('images');
    if (d && fs) fs.mkdirSync(d, { recursive: true });
    return d;
  },

  /**
   * Re-attach the picture this module was last holding, so an OBS reload (or a server restart)
   * brings the wall back with its image and no upload needed. The settings document carries
   * `imageRev` + the placement; this file carries the bytes.
   */
  loadImage() {
    try {
      const fs = this.ctx.fs;
      const f = this.file('image.json');
      if (!f || !fs) return;
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.file) return;
      const abs = this.file(path.join('images', raw.file));
      if (!abs || !fs.existsSync(abs)) return;
      this.image = raw;
      this.imageRev = Number(raw.rev) || 1;
      // The picture a given revision points at is what a preset restores, so the table lives
      // beside the live record and is loaded with it.
      const rf = this.file('image-revs.json');
      if (rf && fs.existsSync(rf)) {
        const revs = JSON.parse(fs.readFileSync(rf, 'utf8'));
        if (revs && typeof revs === 'object') this.imageRevs = revs;
      }
      if (!this.imageRevs[this.imageRev]) this.imageRevs[this.imageRev] = { ...raw };
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`wall: cannot read image state (${err.message})`);
    }
  },

  saveImage() {
    try {
      const fs = this.ctx.fs;
      const f = this.file('image.json');
      if (!f || !fs) return;
      fs.mkdirSync(this.ctx.paths.dir('wall'), { recursive: true });
      const tmp = `${f}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.image || null, null, 1));
      fs.renameSync(tmp, f);
      const rf = this.file('image-revs.json');
      if (rf) {
        const rtmp = `${rf}.tmp`;
        fs.writeFileSync(rtmp, JSON.stringify(this.imageRevs || {}, null, 1));
        fs.renameSync(rtmp, rf);
      }
    } catch (err) {
      this.log.warn(`wall: image state save failed (${err.message})`);
    }
  },

  /**
   * The picture revision `rev` names, or the live one when `rev` is absent/0. A preset's
   * `imageRev` is a revision, not "whatever is live": after the operator uploads a second
   * picture, applying the preset must bring back the first, not paint the second in its place.
   */
  imageForRev(rev) {
    const n = Math.round(Number(rev) || 0);
    if (n && this.imageRevs[n]) return this.imageRevs[n];
    return this.image || null;
  },

  /**
   * Take one upload: validate, store, make it the live picture and tell every page.
   *
   * The placement keys are written through the settings document (not beside it), so
   * `preset.save` captures the transform with the look and a reload restores exactly what the
   * operator saw. The engine keys its texture on `imageRev`, so this is the one thing that
   * makes a page re-download.
   */
  acceptImage(buf) {
    const fs = this.ctx.fs;
    if (!fs) throw new HttpError(500, 'wall: no filesystem');
    const info = acceptUpload(buf);
    const dir = this.imageDir();
    if (!dir) throw new HttpError(500, 'wall: no state directory');
    const name = `${nameFor(buf)}.${info.ext}`;
    const abs = this.file(path.join('images', name));
    fs.writeFileSync(abs, buf);
    this.imageRev += 1;
    this.image = {
      rev: this.imageRev,
      file: name,
      mime: info.mime,
      w: info.w,
      h: info.h,
      bytes: info.bytes,
      at: Date.now(),
    };
    this.imageRevs[this.image.rev] = { ...this.image };
    this.saveImage();
    const S = this.ctx.settings;
    if (S) {
      S.patch({ imageOn: 1, imageRev: this.imageRev });
      this._bumpRender();
      const { look, ratio, fence } = this.renderSettings();
      this.broadcastState({ look, ratio, fence }, 'image');
      this.pushState();
    }
    this.log.info(`wall image: ${name} ${info.w}x${info.h} ${info.bytes} B rev ${this.imageRev}`);
    return { ...this.image, limit: MAX_BYTES };
  },

  /** The stored file for a GET, or null. */
  imageFile(rev) {
    const fs = this.ctx.fs;
    const meta = rev ? this.imageRevs[Math.round(Number(rev))] : this.image;
    if (!meta || !fs) return null;
    const abs = this.file(path.join('images', meta.file));
    if (!abs || !fs.existsSync(abs)) return null;
    return { abs, meta };
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

  // A state push is the page's view of the server: the flat look frame the page applies (see
  // `snapshotFrame`), not the operator-facing diagnostic `state()`.
  pushState() {
    const snap = this.snapshotFrame('push');
    this.events.emit('wall', 'state.snapshot', snap);
    return snap;
  },

  /**
   * How the live picture sits on the wall, in the one number the engine needs.
   *
   * `aspect` is (picture height / picture width) * (wall width / wall height): exactly the
   * vertical stretch that makes a picture `imageScale` of the wall WIDTH come out at the file's
   * own proportions. Derived from the dimensions read out of the uploaded header and from the
   * ratio (a 16:9 wall is 16/9 of a wall-height tall), so it is the same geometry on a fresh
   * upload, after a reload, and out of a preset — no page ever guesses it from a decoded bitmap,
   * and the picture is never stretched by the wall's shape.
   */
  imageGeometry() {
    const meta = this.image;
    const w = Number(meta && meta.w) || 0;
    const h = Number(meta && meta.h) || 0;
    const picH = w > 0 && h > 0 ? h / w : 1;
    const ratio = this.effectiveRatio();
    const parts = ratio.split(':').map(Number);
    const wallAspect = parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : 16 / 9;
    return { picH, wallAspect, aspect: picH * wallAspect, w, h };
  },

  /**
   * The look frames a page receives, in the shape it applies: `{look, ratio, fence, rev, presets}`.
   *
   * Two callers needed the same shape — `broadcastState` when the control pane changes something,
   * and `pushState` on every state push — and `presets` was only ever added by the first. A page
   * that connected, or that missed the one frame a save emitted, therefore never learned the
   * operator's saved presets, and `preset.set` for one of them resolved to the shipped defaults.
   */
  snapshotFrame(note) {
    const { look, ratio, fence } = this.renderSettings();
    return {
      rev: this.renderRev || 0,
      note: note || 'snapshot',
      t: Date.now(),
      look,
      ratio,
      fence,
      presets: this.presetsForPage(),
      imageGeometry: this.imageGeometry(),
    };
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
    const ratio = this.effectiveRatio();
    return {
      look,
      ratio,
      // The window is a property of the ratio, never a stored rect: 9:16 is the portrait column
      // inside the full-surface 16:9 page, 16:9 is the whole wall. Derived on every frame, so a
      // stale rect from an old scale can never put the window off the surface.
      fence: this.derivedFence(ratio),
      rev: this.renderRev,
      // The image layer's identity. Derived from what the module actually holds, never from the
      // settings document alone: a page holding a picture for a revision this server no longer
      // has must re-download instead of trusting a stale key.
      image: this.image
        ? { rev: this.image.rev, file: this.image.file, mime: this.image.mime, w: this.image.w, h: this.image.h, bytes: this.image.bytes, limit: MAX_BYTES }
        : null,
      // How the picture sits in the placements `look` describes. `aspect` is the picture's
      // height over its width times the wall's own aspect, which is exactly the vertical
      // stretch the engine needs to draw the file at its own proportions while `imageScale`
      // stays "fraction of the wall WIDTH". Derived here, on the server, from the dimensions it
      // read out of the uploaded header: the page never guesses it from a decoded bitmap, so a
      // picture restored out of a preset has the same geometry as the one just uploaded.
      imageGeometry: this.imageGeometry(),
      // Every preset the pane's Preset dropdown offers: the shipped looks plus the operator's
      // own. The page hands these to the engine so `preset.set` resolves a saved name too.
      presets: this.presetsForPage(),
    };
  },

  /**
   * The preset bank the page and the pane both read: shipped names plus saved ones, with the
   * saved look attached so the engine can apply it without another round trip.
   */
  presetsForPage() {
    const shipped = ['neonwave', 'arctic', 'chase', 'bassline', 'ember'];
    const saved = this.savedPresets || {};
    const names = shipped.concat(Object.keys(saved).filter((n) => shipped.indexOf(n) < 0));
    return { order: names, saved };
  },

  /**
   * The ratio the wall is actually running: the module's own value, or the core-wide one when the
   * module says `default`. One resolver, used by the snapshot frame, the pane and `/live`, so a
   * page and its control pane can never disagree about what "default" resolves to.
   */
  effectiveRatio() {
    const s = this.ctx.settings;
    const own = s && typeof s.get === 'function' ? s.get('ratio') : 'default';
    if (own === '9:16' || own === '16:9') return own;
    const core = this.ctx.core && this.ctx.core.settings;
    const global = core && typeof core.get === 'function' ? core.get('ratio') : null;
    return global === '9:16' ? '9:16' : '16:9';
  },

  /**
   * The 9:16 window, derived from the ratio and the landscape page's grid.
   *
   *   width  = canvas height * 9 / 16      height = canvas height
   *   x      = (canvas width - width) / 2  y      = 0
   *
   * In cells on the 1280x720 (x2) surface that is the centred 35x63 window inside the 112x63
   * grid. Never stored: a rect in the settings document went stale the moment the surface's
   * scale or grid changed, and the pane dragged a window the page then ignored.
   */
  derivedFence(ratio = this.effectiveRatio()) {
    if (ratio !== '9:16') return null;
    const s = this.ctx.settings;
    const cols = Math.max(4, Math.round(Number(s ? s.get('gridCols') : 0) || 112));
    const scale = 2; // the engine's default scale; the page reports its real one on heartbeat
    const W = 1280 * scale;
    const H = 720 * scale;
    const pitchX = W / cols;
    const rows = Math.max(4, Math.round(Number(s ? s.get('gridRows') : 0) || 0) || Math.round(H / pitchX));
    const pitchY = H / rows;
    const wPx = (H * 9) / 16;
    const xPx = (W - wPx) / 2;
    const x = Math.max(0, Math.min(cols - 2, Math.round(xPx / pitchX)));
    const w = Math.max(2, Math.round(wPx / pitchX));
    return {
      cells: { x, y: 0, w, h: rows },
      px: { x: xPx, y: 0, w: wPx, h: H },
      pitch: { x: pitchX, y: pitchY },
      cols,
      rows,
    };
  },

  /**
   * Whole-cell window from a pixel rect, using the landscape page's grid (the one source OBS
   * loads). The engine re-snaps against its own grid anyway; this is what the pane shows.
   */
  // Idempotent: `renderSettings()` already returns this function's converted shape, and every
  fenceCellsFor(px) {
    // settings/image/preset frame hands that converted fence straight back to `broadcastState`,
    // which calls this again. Without the pass-through the `w/h > 0` bail below reads a converted
    // fence as "no fence" and clears it on every live page. Both shapes reach here (converted
    // from `renderSettings`, raw pixels from the pane's drag/commit), so the guard lives here.
    if (px && typeof px === 'object' && px.cells && typeof px.cells === 'object'
      && Number.isFinite(Number(px.cols)) && Number.isFinite(Number(px.rows))) return px;
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
    // The preset bank rides every frame: a page that connected after a save, or missed the one
    // frame the save emitted, would otherwise resolve a saved name to nothing and load defaults.
    snap.presets = this.presetsForPage();
    // The picture's geometry rides with the look: a page that applies an `imageScale` needs the
    // same stretch the uploader had, or restoring a preset draws the picture at another aspect.
    snap.imageGeometry = this.imageGeometry();
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

  /**
   * Ingest the picture the operator dropped on the wall. The route names the picture; the
   * settings document names where it sits. The engine keys its texture on `rev`, so only this
   * bumps it — a drag changes the transform and never re-downloads the file.
   */
  sendImageCommand(cmd, args = {}) {
    const S = this.ctx.settings;
    const push = (note) => {
      if (!S) return;
      this._bumpRender();
      const { look, ratio, fence } = this.renderSettings();
      this.broadcastState({ look, ratio, fence }, 'image');
      this.pushState();
      this.log.info(`wall image: ${note}`);
    };
    if (cmd === 'wall.image.clear') {
      if (S) S.patch({ imageOn: 0 });
      push('cleared');
      return { seq: this.seq, delivered: 0, ok: true, note: 'cleared', image: null };
    }
    // A placement-only command moves the picture that is already stored; only a command that
    // actually carries bytes stores a new one.
    const hasBody = Buffer.isBuffer(args.body) ? args.body.length > 0 : Boolean(args.body);
    let rec = this.image ? { ...this.image, limit: MAX_BYTES } : null;
    if (hasBody) rec = this.acceptImage(args.body);
    const patch = {};
    if (args.rev !== undefined) {
      patch.imageRev = args.rev;
      patch.imageOn = 1;
    }
    if (args.x !== undefined) patch.imageX = args.x;
    if (args.y !== undefined) patch.imageY = args.y;
    if (args.scale !== undefined) patch.imageScale = args.scale;
    if (args.rotate !== undefined) patch.imageRotate = args.rotate;
    if (args.colour !== undefined) patch.imageColour = args.colour;
    if (args.bits !== undefined) patch.imageBits = String(args.bits);
    if (args.dither !== undefined) patch.imageDither = args.dither;
    if (S && Object.keys(patch).length) S.patch(patch);
    if (!hasBody) push(Object.keys(patch).length ? 'placement' : 'resend');
    return {
      seq: this.seq,
      delivered: (this.events.clientsByChannel?.() || {}).wall || 0,
      ok: true,
      note: hasBody ? 'image set' : 'image placed',
      image: rec,
    };
  },

  send(cmd, args = {}, view = null) {
    if (cmd === 'text.send') args = resolvePoolArgs(this.ctx.pool, args);
    // The image commands are answered here: the server owns the file, so `wall.image.set` is an
    // upload (bytes in, revision out) and `wall.image.clear` is a release. Neither is forwarded
    // as a bare message — the pages learn the outcome through the settings snapshot, which
    // carries `imageRev`/`imageOn` the same way it carries every other look key.
    if (cmd === 'wall.image.set' || cmd === 'wall.image.clear') {
      return this.sendImageCommand(cmd, args || {});
    }
    // `preset.save` is answered here, not by the page: the look being captured is the settings
    // document the SERVER already holds (the pane writes every look change to it in the same
    // round trip), and the saved preset has to survive an OBS reload. Reading it off a page
    // would capture whatever that page happened to have applied last, and lose it on reload.
    if (cmd === 'preset.save') return this._savePreset(args || {});
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

  /**
   * Origin-level route for the picture upload. Core's HTTP layer parses every module route body
   * as JSON, so a picture body cannot arrive through `routes()`; `POST /api/wall/image` is
   * registered here instead, is read RAW by core (content types that are not JSON) and handed
   * over verbatim. It delegates to the same `wall.image.set` path a script would call.
   *
   * `DELETE /api/wall/image` is the same as `wall.image.clear`, for a `fetch(del)` shape.
   */
  coreExtraRoutes() {
    const mod = this;
    return [
      {
        method: 'POST',
        path: '/api/wall/image',
        // The picture arrives as bytes, not JSON (core reads it raw and passes the Buffer).
        rawBody: true,
        rawLimit: MAX_BYTES,
        async handler(req, res, url, body) {
          const fs = mod.ctx.fs;
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(body && body.__rawBody ? body.__rawBody : '');
          if (!buf.length) throw new HttpError(400, 'image: empty body');
          if (buf.length > MAX_BYTES) throw new HttpError(413, `image: ${buf.length} bytes > ${MAX_BYTES}`);
          if (!fs) throw new HttpError(500, 'wall: no filesystem');
          const rec = mod.acceptImage(buf);
          return { ok: true, cmd: 'wall.image.set', image: rec };
        },
      },
      {
        method: 'DELETE',
        path: '/api/wall/image',
        handler() {
          const out = mod.sendImageCommand('wall.image.clear', {});
          return { ...out, ok: true };
        },
      },
      {
        // What the picture is, and the size ceiling, without downloading it.
        method: 'GET',
        path: '/api/wall/image/info',
        handler() {
          return { ok: true, image: mod.image ? { ...mod.image, limit: MAX_BYTES } : null, limit: MAX_BYTES };
        },
      },
    ];
  },

  /** 9:16 <-> 16:9, refused inside a forcing scene. */  _ratioToggle() {
    const cur = this.ctx.settings.get('ratio') || '16:9';
    const next = cur === '16:9' ? '9:16' : '16:9';
    if (next === '9:16' && this.ratio && this.ratio.state.forcing) {
      this.log.info(`ratio: ${this.ratio.state.lastScene} forces 16:9 — toggle ignored`);
      return { seq: this.seq, delivered: 0, ok: false, note: 'refused: scene forces 16:9', ratio: cur };
    }
    this.ctx.settings.set('ratio', next);
    return { seq: this.seq, delivered: 0, ok: true, note: 'ratio', ratio: next };
  },

  /**
   * Snapshot the current look under `args.name` and make it the live preset.
   *
   * Only look dimensions are captured (PRESET_DIMS mirrors engine.js): grid geometry belongs to
   * the physical installation, and nothing under `views.*.text` is ever read — a preset must
   * never carry or overwrite a text-mode message pool.
   */
  _savePreset(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) throw new HttpError(400, 'preset.save: name is required');
    if (!/^[A-Za-z0-9 ._:-]{1,64}$/.test(name)) {
      throw new HttpError(400, 'preset.save: name must be 1..64 chars of [A-Za-z0-9 ._:-]');
    }
    const S = this.ctx.settings;
    const look = {};
    for (const f of PRESET_DIMS) {
      const v = S.get(f);
      if (v !== undefined && v !== null) look[f] = JSON.parse(JSON.stringify(v));
    }
    // The named look becomes the one the wall runs, so the saved preset and the live look
    // cannot drift apart. `preset` is a real schema field (module.json), so this is the same
    // write the pane's dropdown makes.
    look.preset = name;
    this.savedPresets[name] = look;
    S.patch(look);
    this._bumpRender();
    const { look: lk, ratio, fence } = this.renderSettings();
    const presets = this.presetsForPage();
    this.broadcastState({ look: lk, ratio, fence }, 'preset.save');
    this.pushState();
    this.log.info(`wall preset saved: ${name}`);
    return { seq: this.seq, delivered: 0, ok: true, note: 'preset saved', preset: name, presets };
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
        // The picture itself. No `uniforms` in the URL: the last accepted upload is the
        // picture (a new one replaces it), and the version query only defeats a stale cache.
        method: 'GET',
        path: '/image',
        handler(req, res, url) {
          const found = mod.imageFile(url && url.searchParams ? url.searchParams.get('rev') : 0);
          if (!found) {
            res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
            res.end(JSON.stringify({ ok: false, error: 'no image' }));
            return undefined;
          }
          const fs = mod.ctx.fs;
          const buf = fs.readFileSync(found.abs);
          res.writeHead(200, {
            'content-type': found.meta.mime || 'application/octet-stream',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'content-length': buf.length,
            'x-wall-image': found.meta.file,
            'x-wall-image-rev': String(found.meta.rev),
            'x-wall-image-w': String(found.meta.w || 0),
            'x-wall-image-h': String(found.meta.h || 0),
          });
          res.end(buf);
          return undefined;
        },
      },
      {
        // A typed command path: `wall.image.set` with the bytes as `body`, or
        // `wall.image.clear`. `POST /api/wall/image` is the browser's own door (core mediates
        // the raw body there); this one exists so a script or the deck can drive the same thing
        // through the normal JSON envelope.
        method: 'POST',
        path: '/image/set',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object' || !body.cmd) throw new HttpError(400, 'body must be {cmd, args}');
          const out = mod.send(body.cmd, body.args || {});
          return { ...out, ok: out.ok !== false };
        },
      },
      {
        // The same door the browser posts bytes to, for a JSON client: `{body: "<base64>"}`.
        // base64 rather than a JSON string of binary, so a UTF-8 round trip cannot corrupt it.
        method: 'POST',
        path: '/image/upload',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object' || typeof body.base64 !== 'string') {
            throw new HttpError(400, 'body must be {base64}');
          }
          const buf = Buffer.from(body.base64, 'base64');
          if (!buf.length) throw new HttpError(400, 'image: empty body');
          if (buf.length > MAX_BYTES) throw new HttpError(413, `image: ${buf.length} bytes > ${MAX_BYTES}`);
          const rec = mod.acceptImage(buf);
          return { ok: true, cmd: 'wall.image.set', image: rec };
        },
      },
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
            image: mod.image ? { ...mod.image, limit: MAX_BYTES } : null,
            snapshot: mod.lastSnapshot || null,
          };
        },
      },
      {
        method: 'PATCH',
        path: '/settings',
        handler(req, res, url, body) {
          // Schema validation is the module manifest's job, exactly as notifications does it.
          // The page hands back the dims a preset it just applied carries, and a few preset
          // dimensions are page state with no schema field (`mode` is the view's, not the
          // document's). The document refuses a patch containing one unknown key - which made
          // every write-back fail wholesale - so keys this document does not own are dropped
          // here rather than by every caller.
          const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
          const known = S().schema || null;
          const patch = {};
          const dropped = [];
          for (const [k, v] of Object.entries(raw)) {
            if (known && !(k in known)) { dropped.push(k); continue; }
            patch[k] = v;
          }
          const changed = S().patch(patch);
          if (changed.length && mod.events) {
            mod._bumpRender();
            const { look, ratio, fence } = mod.renderSettings();
            mod.broadcastState({ look, ratio, fence }, 'settings');
            mod.pushState();
          }
          return { ok: true, changed, dropped, settings: S().describe(), ratio: mod.ratio ? mod.ratio.state : null };
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
        // Commit a fence rect the operator dragged. The window is derived from the ratio now, so
        // the rect itself is not stored: a queued drag pins 9:16 (or 16:9 when cleared) and the
        // page gets the derived window back. Kept as a route because the pane's gesture commits
        // here and an older pane still calls it.
        method: 'PUT',
        path: '/fence',
        handler(req, res, url, body) {
          if (!body || typeof body !== 'object') throw new HttpError(400, 'body must be a JSON object');
          const f = body.fence;
          if (f !== null && (!f || typeof f !== 'object')) throw new HttpError(400, 'fence must be an object or null');
          S().set('ratio', f === null ? '16:9' : '9:16');
          mod._bumpRender();
          const snap = mod.broadcastState({}, 'fence');
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
