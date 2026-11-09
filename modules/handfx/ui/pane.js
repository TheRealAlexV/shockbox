// ShockFX admin pane.
//
// What the operator sets here is the server's (`PATCH /api/handfx/settings`): enable, effect order
// and per-effect intensity, mirror, sensitivity, camera device, resolution, debug overlay, the
// "next effect" gesture and the effect travel. What the pane shows about tracking is honest by
// construction:
//
//   · the camera belongs to the overlay page. The pane's preview is that page itself (/shockfx) in
//     a live 16:9 iframe, so hands, effects, camera and backdrop are the ones OBS draws — the pane
//     no longer opens a second stream or draws its own approximation
//   · the overlay reports hands and gestures on the bus (`handfx` → the `page` event); the pane
//     turns those into the honest status line and timestamps it
//   · the effect registry is the union of the server's ids and this build's implementations; a
//     setting naming an effect this build cannot draw is shown as such, not silently dropped
//
// The pane lives off the shell's own tokens (public/src/shell.css) and a small pane.css.

import { el, frag, clear, actionButton } from '/src/ui.js';
import { mountPreview } from '/src/preview.js';
import { EFFECTS as ENGINE_EFFECTS } from '../pages/js/engine/fx.js';

// What this build can actually draw. The page's registry is the truth (it is the same module the
// overlay imports), so the pane can never claim an effect the page would silently skip.
const KNOWN = new Set(Object.keys(ENGINE_EFFECTS));
const SKINS = ['projectile', 'heart'];
// The body page's masks arrive over a BroadcastChannel between two OBS sources; the pane only
// learns a timestamp, never a frame. "Recent" matches the overlay's own 1 s mask expiry, with
// room for the 2 s /ack throttle on top.
const BODY_FRESH_MS = 3000;


export async function render(container, ctx) {
  const { api, events, signal } = ctx;
  const root = el('div', { class: 'hfx' });
  container.append(root);
  // Persistent slots: the preview slot is never emptied, so the iframe is never detached and
  // reloaded by a status poll or a bus event. Only the slot beside it is rebuilt.
  const headerHost = el('div');
  const bannerHost = el('div');
  const body = el('div', { class: 'hfx-body' });
  const previewSlot = el('div', { class: 'hfx-preview-slot' });
  const sideSlot = el('div', { class: 'hfx-side-slot' });
  body.append(previewSlot, sideSlot);
  const effectsHost = el('div');
  const footerHost = el('div');
  // The body view gets its own slot, outside the column that render() rebuilds: an iframe
  // detached from the document reloads, and this one must not.
  const bodySlot = el('div', { class: 'hfx-body-slot' });
  root.append(headerHost, bannerHost, body, bodySlot, effectsHost, footerHost);

  const s = {
    status: null, // /api/handfx/status
    settings: {}, // plain values from the settings describe
    page: null, // last honest status line from the overlay
    live: new Map(), // effect id -> {startedAt, hands, gesture} (from the overlay's reports)
    underlay: true, // the camera feed under the effects; off leaves the dark backdrop
    log: [],
    // Camera card. The device list is read once and only re-enumerated on a button press: listing
    // DirectShow launches the virtual-camera clients, so it is never polled.
    cameras: null, // last /api/handfx/cameras payload
    camerasReadAt: 0, // when that payload was produced (ageMs already subtracted)
    camerasBusy: false, // a rescan is in flight
    camerasErr: null,
    cameraPending: null, // {from,to}: written to settings, not yet in the feed
    cameraRestartErr: null,
  };

  /* ------------------------------------------------------------ apply gate */
  // Every write to the server funnels through patch() and bus() below. Auto Apply off makes those
  // collect instead of send (settings in pendingPatch, page commands in pendingCmds); one Apply
  // flushes both and re-reads the status. The pane has no prefs store, so localStorage remembers
  // the choice.
  //
  // The gate is about the document the OBS page follows, never about the preview: the preview is
  // that page itself and stays live either way. Restarting the camera relay is the one write that
  // is not a settings key, and it queues the same way (restartCamera).
  const AUTO_KEY = 'handfx.autoApply';
  let autoApply = true;
  try {
    const saved = localStorage.getItem(AUTO_KEY);
    if (saved !== null) autoApply = saved === '1';
  } catch { /* storage can be denied: keep the live default */ }

  const pendingPatch = Object.create(null);
  const pendingCmds = []; // { name, args } for /api/handfx/cmd, or { name, restart: true }
  let applying = false;
  let applyBtn = null; // the header's Apply button; rebuilt with the header

  // The pane asks OBS's body source to start or stop on the control channel. It never publishes a
  // mask and never opens the body camera: pages/js/body/main.js owns 'handfx.body' publishing.
  const bodyCtl = 'BroadcastChannel' in window ? new BroadcastChannel('handfx.body.ctl') : null;

  /* -------------------------------------------------------------- data */

  async function refresh() {
    s.status = await api.get('/api/handfx/status');
    s.settings = Object.fromEntries(Object.entries(s.status.settings || {}).map(([k, d]) => [k, d.value]));
    s.underlay = s.settings.underlay !== false;
    // A poll just replaced the document: put the queued edits back on top of it, so the pane
    // keeps showing what Apply will send instead of snapping to the OBS source's old values.
    paintQueued();
    return s.status;
  }

  /** One settings object through PATCH (which also broadcasts). The pane's whole settings view is
   *  replaced by the server's answer, so a control can never disagree with the document. */
  async function sendPatch(patchObj) {
    const res = await api.patch('/api/handfx/settings', patchObj);
    s.settings = Object.fromEntries(Object.entries(res.settings || {}).map(([k, d]) => [k, d.value]));
    return res;
  }

  /** One settings key. With Auto Apply off and no {force}, it is collected instead of sent. */
  async function patch(key, value, { force = false } = {}) {
    if (signal.aborted) return null;
    if (!autoApply && !force) return queuePatch({ [key]: value });
    const before = s.settings[key];
    const res = await sendPatch({ [key]: value });
    if (Array.isArray(res.changed) && !res.changed.includes(key)) {
      push(`“${key}” did not change on the server (sent ${JSON.stringify(value)})`, 'warn');
    }
    return { before, res };
  }

  /** One page command. With Auto Apply off and no {force}, it is collected instead of sent. */
  async function bus(cmd, args, { force = false } = {}) {
    if (signal.aborted) return null;
    if (!autoApply && !force) return queueCmd(cmd, args);
    const res = await api.post('/api/handfx/cmd', { cmd, args });
    push(`${cmd} → accepted by the server (seq ${res.seq ?? '—'})`, 'ok');
    return res;
  }

  /** The camera relay restart is a write to the OBS feed, not a settings key, so it takes the
   *  same gate and drains through the same queue. */
  async function restartCamera({ force = false } = {}) {
    if (signal.aborted) return null;
    if (!autoApply && !force) return queueCmd('camera.restart', undefined, { restart: true });
    const res = await api.post('/api/handfx/cameras/restart', {});
    push('camera restart sent. The feed drops for a second or two, then comes back on the selected device.', 'warn');
    return res;
  }

  /* ------------------------------------------------------- apply gate: queue */

  function pendingCount() {
    return Object.keys(pendingPatch).length + pendingCmds.length;
  }

  function paintPending() {
    if (!applyBtn) return;
    const n = pendingCount();
    applyBtn.textContent = n ? `Apply (${n})` : 'Apply';
    applyBtn.disabled = autoApply || applying;
  }

  /** Show collected edits on the pane the way a server answer would, so nothing snaps back. */
  function mirrorQueuedPatch(patchObj) {
    s.settings = { ...s.settings, ...patchObj };
    if ('underlay' in patchObj) s.underlay = patchObj.underlay !== false;
  }

  /** Re-assert the queued view after a poll replaced s.settings with the server's document. */
  function paintQueued() {
    if (autoApply) return;
    if (Object.keys(pendingPatch).length) mirrorQueuedPatch(pendingPatch);
  }

  function queuePatch(patchObj) {
    const keys = Object.keys(patchObj);
    const before = keys.length === 1 ? s.settings[keys[0]] : undefined;
    Object.assign(pendingPatch, patchObj);
    mirrorQueuedPatch(patchObj);
    render(); // redraws the Apply count and the controls from the queued values
    return { before, res: { ok: true, queued: true, settings: null } };
  }

  function queueCmd(name, args, opts = undefined) {
    pendingCmds.push(opts && opts.restart ? { name, restart: true } : { name, args });
    render();
    return { ok: true, queued: true };
  }

  function setAutoApply(on) {
    autoApply = !!on;
    try { localStorage.setItem(AUTO_KEY, autoApply ? '1' : '0'); } catch { /* not fatal */ }
    paintPending();
  }

  /** Send what was collected, in the wall's order: one settings PATCH, then the commands one at a
   *  time. A failure keeps the rest queued and stops, so nothing is silently lost. */
  async function applyPending() {
    if (applying || signal.aborted) return;
    applying = true;
    paintPending();
    try {
      const patchObj = { ...pendingPatch };
      if (Object.keys(patchObj).length) {
        try {
          await sendPatch(patchObj);
        } catch (err) {
          push(`not applied: ${err.message}`, 'bad');
          return; // everything stays queued for the next Apply
        }
        for (const k of Object.keys(patchObj)) delete pendingPatch[k];
      }
      while (pendingCmds.length) {
        const c = pendingCmds[0];
        try {
          if (c.restart) await restartCamera({ force: true });
          else await bus(c.name, c.args, { force: true });
        } catch (err) {
          push(`not applied: ${c.name}: ${err.message}`, 'bad');
          break; // it stays at the head of the queue, and the rest behind it
        }
        pendingCmds.shift();
      }
      await refresh();
      render();
    } finally {
      applying = false;
      paintPending();
    }
  }

  function push(text, tone = 'info') {
    s.log.unshift({ at: Date.now(), text, tone });
    s.log = s.log.slice(0, 6);
    renderLog();
  }

  function renderLog() {
    const box = root.querySelector('.hfx-log');
    if (!box) return;
    clear(box);
    if (!s.log.length) {
      box.append(el('div', { class: 'hfx-log-empty', text: 'no commands yet' }));
      return;
    }
    for (const row of s.log) {
      const t = new Date(row.at).toTimeString().slice(0, 8);
      box.append(
        el('div', { class: 'hfx-log-row', 'data-tone': row.tone }, el('span', { class: 'mono hfx-log-t', text: t }), el('span', { text: row.text })),
      );
    }
  }

  /* -------------------------------------------------------------- camera */

  function secureText() {
    if (window.isSecureContext) return null;
    return `This page is served from ${location.origin}, which is not a secure context. A browser only allows the camera on https, http://localhost or http://127.0.0.1 — open the pane there.`;
  }

  function registry() {
    const served = (s.status && s.status.effects) || [];
    return served.map((e) => {
      const id = effectId(e);
      return { ...e, id, known: KNOWN.has(id), skin: id === 'shoot' };
    });
  }

  /**
   * One registry entry's id. `/status` serves objects (`{ id, title, gesture, from }`); the
   * `Object.keys(FX)` shape a bare engine would give is a plain string, so read both and never
   * render `undefined` into a row. An entry with neither is not an effect and is dropped.
   */
  function effectId(e) {
    if (typeof e === 'string') return e;
    return (e && (e.id || e.name)) || null;
  }

  /**
   * What a row is called. The pane never invents a name: the registry's `title` is the engine's
   * own (`EFFECTS[id].title` in pages/js/engine/fx.js — the same module the overlay imports). Only
   * when a build serves ids alone does the row fall back to the id in words, and then the id
   * itself is not repeated beside it.
   */
  function effectTitle(e, effect) {
    if (e.title) return { text: String(e.title), derived: false };
    // The engine this build carries may still know the id — ask it before spelling the id out.
    const own = effect && ENGINE_EFFECTS[effect];
    if (own && own.title) return { text: String(own.title), derived: false };
    const words = String(effect).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    return { text: words.replace(/^./, (ch) => ch.toUpperCase()), derived: true };
  }

  /** Shoot's skin: `skins.shoot` is optional, absent means the default projectile orb. */
  function shootSkin() {
    const skins = s.settings.skins;
    const want = skins && typeof skins === 'object' ? skins.shoot : null;
    return SKINS.includes(want) ? want : 'projectile';
  }

  async function setSkin(skin) {
    try {
      await patch('skins', { ...(s.settings.skins || {}), shoot: skin });
      push(`shoot skin → ${skin}`, 'ok');
    } catch (err) {
      push(`skin refused: ${err.message}`, 'bad');
    }
    render();
  }

  /** Body-tracking facts: the mask timestamp the overlay reports, and the body page's own beat. */
  function bodySummary() {
    const b = (s.status && s.status.body) || {};
    const last = Number(b.lastMaskAt) || 0;
    const age = last ? Date.now() - last : Infinity;
    if (!last) return { tone: 'idle', text: 'no body mask yet. Start the body source below.' };
    if (age < BODY_FRESH_MS) return { tone: 'ok', text: `mask arriving (${Math.round(age / 100) / 10}s ago)` };
    return { tone: 'warn', text: `mask stopped ${Math.round(age / 1000)}s ago, body effects are off` };
  }

  function effectEnabled(id) {
    return (s.settings.effects || []).includes(id);
  }

  async function toggleEffect(id) {
    if (!id) return;
    const on = effectEnabled(id);
    const all = registry().map((e) => e.id).filter(Boolean);
    let next;
    if (on) next = (s.settings.effects || []).filter((x) => x !== id);
    else next = all.filter((x) => effectEnabled(x) || x === id);
    try {
      await patch('effects', next);
      push(`${id} ${on ? 'off' : 'on'} — effect list: ${next.join(', ') || '(empty)'}`, 'ok');
    } catch (err) {
      push(`effect list refused: ${err.message}`, 'bad');
    }
    render();
  }

  async function moveEffect(id, dir) {
    const list = (s.settings.effects || []).slice();
    const i = list.indexOf(id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    try {
      await patch('effects', list);
    } catch (err) {
      push(`order refused: ${err.message}`, 'bad');
    }
    render();
  }

  async function setIntensity(id, value) {
    const intensity = { ...(s.settings.intensity || {}), [id]: value };
    try {
      await patch('intensity', intensity);
    } catch (err) {
      push(`intensity refused: ${err.message}`, 'bad');
    }
  }

  /* -------------------------------------------------------------- overlay state */

  function pageSummary() {
    const p = s.page;
    if (!p) return { tone: 'idle', text: 'no status from the overlay yet — open it and press Start (or Synthetic) there' };
    const age = Date.now() - (p.at || 0);
    if (age > 8000) return { tone: 'warn', text: `overlay last reported ${Math.round(age / 1000)}s ago (closed, or its tab is asleep)` };
    if (p.error) return { tone: 'bad', text: `overlay: ${p.error}` };
    if (p.tracking) return { tone: 'ok', text: `overlay tracking · ${p.hands} hand${p.hands === 1 ? '' : 's'} · ${p.gesture || 'none'} · effect ${p.effect || '—'}` };
    return { tone: 'idle', text: 'overlay open, not tracking' };
  }

  /* -------------------------------------------------------------- render */

  function render() {
    const status = s.status;
    const reg = registry();
    const enabled = s.settings.enabled !== false;
    const insecure = secureText();
    const page = pageSummary();

    headerHost.replaceChildren(header(status, reg, page, enabled));

    const notices = [];
    if (insecure) notices.push(banner(insecure, 'bad'));
    if (status && (!status.runtime || !status.runtime.vendored)) {
      notices.push(banner('The MediaPipe runtime is not vendored. The overlay will report “model failed”; see modules/handfx/vendor/README.md.', 'bad'));
    }
    if (status && status.model && !status.model.local) {
      notices.push(banner(`No local model file: the overlay downloads hand_landmarker.task once from ${status.model.url} and caches it in Cache Storage.`, 'info'));
    }
    bannerHost.replaceChildren(...notices);

    if (!pv) {
      previewCard();
      previewSlot.append(previewHost);
    }
    sideSlot.replaceChildren(sideColumn(reg, enabled));
    // Built once, then only its text changes: the body iframe inside must never be recreated.
    if (!bodyCardEl) bodySlot.append((bodyCardEl = bodyCard()));
    updateBodyCard();
    effectsHost.replaceChildren(effectsCard(reg));
    footerHost.replaceChildren(footer(reg));
    renderLog();
  }

  /** The gate beside the title, built with the header: the wall's markup and words, wired to this
   *  pane's queue. */
  function applyGate() {
    const box = el('input', { type: 'checkbox', id: 'handfx-auto-apply' });
    box.checked = autoApply;
    box.addEventListener('change', () => {
      setAutoApply(box.checked);
      // turning the gate back on must not strand what was collected while it was off
      if (box.checked) void applyPending();
    });
    const n = pendingCount();
    applyBtn = el('button', {
      type: 'button', class: 'btn btn-sm', text: n ? `Apply (${n})` : 'Apply',
      title: 'Send the held settings and commands to the OBS overlay, then re-read the status',
    });
    applyBtn.disabled = autoApply || applying;
    applyBtn.addEventListener('click', () => { void applyPending(); });
    return el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      el('label', { class: 'switch-inline', for: 'handfx-auto-apply', title: 'Controls the OBS overlay source, not the preview: on, every change reaches the source at once; off, changes are held and reach it with Apply. The preview is always live.' },
        box, el('span', { text: 'Auto Apply to OBS' })),
      applyBtn,
    );
  }

  function header(status, reg, page, enabled) {
    const list = (s.settings.effects || []).filter((id) => reg.some((e) => e.id === id));
    const bar = el('div', { class: 'hfx-head' });
    bar.append(
      el('div', { class: 'hfx-head-left', style: { flexWrap: 'wrap', rowGap: '6px' } },
        el('span', { class: 'hfx-title', text: 'ShockFX' }),
        applyGate(),
        el('span', { class: 'hfx-dot', 'data-tone': enabled ? 'ok' : 'idle' }),
        el('span', { class: 'hfx-state', text: enabled ? 'effects on' : 'effects off' }),
        el('span', { class: 'hfx-sep' }),
        el('span', { class: 'hfx-list', text: `list: ${list.join(' › ') || '(empty — nothing is drawn)'}` }),
      ),
      el('div', { class: 'hfx-head-right' },
        actionButton({ label: '◀ effect.prev', variant: 'btn-quiet btn-sm', run: () => bus('effect.prev'), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
        actionButton({ label: 'effect.next ▶', variant: 'btn-quiet btn-sm', run: () => bus('effect.next'), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
        actionButton({ label: 'reload page', variant: 'btn-quiet btn-sm', run: () => bus('reload'), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
      ),
    );
    const strip = el('div', { class: 'hfx-strip' },
      el('span', { class: 'hfx-pill', 'data-tone': enabled ? 'ok' : 'warn' }, `effects ${enabled ? 'enabled' : 'disabled'}`),
      el('span', { class: 'hfx-pill', 'data-tone': s.settings.mirror !== false ? 'info' : 'idle' }, `mirror ${s.settings.mirror !== false ? 'on' : 'off'}`),
      el('span', { class: 'hfx-pill', 'data-tone': window.isSecureContext ? 'ok' : 'bad' }, window.isSecureContext ? 'secure context' : 'insecure origin'),
      el('span', { class: 'hfx-pill', 'data-tone': window.crossOriginIsolated ? 'ok' : 'warn' }, window.crossOriginIsolated ? 'cross-origin isolated' : 'not isolated (pane)'),
      el('span', { class: 'hfx-pill', 'data-tone': page.tone }, page.text),
    );
    return el('div', { class: 'hfx-hero' }, bar,
      el('p', { class: 'hfx-note hfx-gate-desc', text: 'The preview is the overlay page itself, so it shows what OBS draws. With Auto Apply off, the OBS source keeps the applied settings until you press Apply.' }),
      strip);
  }

  function banner(text, tone) {
    return el('div', { class: 'hfx-banner', 'data-tone': tone, text });
  }

  /* The page is mounted once and re-attached on every render, so the iframe is never recreated
     by a bus event or a status poll. */
  const previewHost = el('div', { class: 'hfx-preview-host' });
  let pv = null;
  // The body view's own host, created once so a status poll never reloads the iframe.
  const bodyHost = el('div', { class: 'hfx-body-embed-host' });
  let bodyPv = null;
  let bodyCardEl = null;
  let bodyPillEl = null;
  let bodyBeatEl = null;

  function previewCard() {
    if (!pv) {
      pv = mountPreview(previewHost, {
        title: 'Preview',
        // A preview draws synthetic hands and forces the underlay off in its own iframe; say so,
        // so the operator never reads the preview as the OBS source's exact look.
        hint: 'live /shockfx · synthetic hands, underlay off in this preview',
        src: '/shockfx',
        interactive: false,
        // The 9:16 collision column the particles are fenced to (`engine/fx.js`
        // fenceRectFor(9:16)` at 16:9: full height, w = 9/16 · h/w), in the preview frame's
        // fractions. Not the component's wall-crop default, which is a different column.
        fence: { x: 0.3418, w: 0.3164 },
      });
      pv.el.querySelector('.pv-headright')?.append(underlayToggle());
    }
    return pv.el;
  }

  function sideColumn(reg, enabled) {
    const col = el('div', { class: 'hfx-side' });
    // Camera first: it is the one control an operator reaches for when the picture is missing.
    col.append(cameraCard(), trackingCard(), lookCard());
    return col;
  }

  /**
   * What is actually driving the particles, from /status (`effectiveSource`, the page's own anchor
   * source) beside the persisted mode (`trackingSource`). `auto` + synthetic is a fallback, named
   * with the camera's own error; it must never read the same as the operator choosing synthetic.
   */
  function effectiveSource() {
    const st = s.status || {};
    const setting = st.trackingSource || s.settings.trackingSource || 'auto';
    const eff = st.effectiveSource || 'none';
    const why = (st.cameraError && (st.cameraError.message || st.cameraError.name)) || st.relayError || (st.cameraSource === 'synthetic' ? 'no camera' : '');
    if (eff === 'camera') return { tone: 'ok', text: setting === 'auto' ? 'camera (auto)' : 'camera' };
    if (eff === 'stale') return { tone: 'warn', text: `stale — no page report for ${Math.round((st.staleForMs || 0) / 1000)} s`, why: st.lastAckedSource ? `last said: ${st.lastAckedSource}` : '' };
    if (eff === 'synthetic' && setting === 'synthetic') return { tone: 'info', text: 'synthetic (chosen)' };
    if (eff === 'synthetic') return { tone: why ? 'warn' : 'info', text: 'synthetic — auto fallback', why };
    if (setting === 'camera') return { tone: 'warn', text: 'camera only — nothing drawn' };
    return { tone: 'idle', text: 'nothing drawn yet' };
  }

  /**
    * The overlay's paint loop, from /status (`renderLoop`, computed there from the page's own paint
    * clock). `stale` used to cover two different faults at once: a page that stopped reporting and a
    * page Chrome stopped compositing. `running` is the healthy reading; `stopped` is a page alive and
    * acking whose document gets no frames — an occluded OBS source draws nothing on air, which is not
    * an error in the page and must not read as one; `unknown` is no page reporting, so nothing is
    * known about its loop. The `why` comes from what the page itself last reported (`hidden`,
    * `visibility`) so the operator never has to guess which of the two happened.
    */
  function renderLoop() {
    const st = s.status || {};
    const loop = st.renderLoop || 'unknown';
    const idle = Number(st.loopIdleMs);
    if (loop === 'running') return { tone: 'ok', text: 'running' };
    if (loop === 'unknown') return { tone: 'idle', text: 'unknown', note: 'no page reporting, so its loop is unknown' };
    const why = st.hidden === true ? 'page hidden'
      : (st.visibility && st.visibility !== 'visible') ? `page ${st.visibility}`
        : 'page not painting';
    return {
      tone: 'warn',
      text: 'stopped',
      note: Number.isFinite(idle) ? `${why}, not painting — last frame ${Math.round(idle / 1000)} s ago` : `${why}, not painting`,
    };
  }

  /* -------------------------------------------------------------- camera card */

  // The camera dropdown lives here, in the pane, on the main page. Nothing opens a second window,
  // and the separate device window is gone: the select is the whole device list.

  /**
   * The relay's own facts, plus the device the operator selected in settings.
   *
   * `drawing` is the server's own answer from the page's draw progress (its paint clock or an
   * advancing draw counter), not `lastAckAt`: a page can ack while painting nothing, and a socket
   * still taking frames proves nothing about the picture. `=== true` on purpose — the field is
   * `null` when nothing is known, and unknown must not be read as healthy.
   */
  function cameraFacts() {
    const f = (s.status && s.status.cameraFeed) || {};
    const selected = String(s.settings.cameraRelaySource || '');
    const clients = Array.isArray(f.clientList) ? f.clientList : [];
    const drawing = clients.find((c) => c && c.drawing === true && c.source === 'camera' && !c.hidden);
    return { f, selected, clients, drawing, state: String(f.state || 'unknown') };
  }

  /**
   * The camera's state, computed from /status only. A select that wrote the setting is
   * `selected, not active` until the relay reports the new source running, so the pane never
   * claims a switch that has not happened. `idle` is never spelled as a missing camera: that
   * conflation is what made a 16 hour outage look like unplugged hardware.
   */
  function cameraPill() {
    const { f, selected, state, drawing } = cameraFacts();
    if (s.cameraPending) {
      const to = s.cameraPending.to ? `“${s.cameraPending.to}”` : 'the first camera';
      return { tone: 'warn', text: `selected ${to}, not active. The feed still reads the old device until you press Restart camera.` };
    }
    if (state === 'off') return { tone: 'idle', text: 'relay off. The cameraRelay setting is off, so nothing reads a camera.' };
    if (state === 'failed' || f.error) return { tone: 'bad', text: `relay failed: ${String(f.error || f.reason || 'ffmpeg stopped').slice(0, 140)}` };
    if (state === 'stalled') return { tone: 'bad', text: 'feed stalled. ffmpeg is still running but no frame arrived in the last 2 s.' };
    if (state === 'starting' || state === 'restarting') {
      return { tone: 'warn', text: `starting. ffmpeg is opening ${selected || 'the camera'}.` };
    }
    if (state === 'idle' && Number(f.clients || 0) === 0) {
      // Honest idle. Never "no camera": the device exists, nothing has asked the relay for it.
      return { tone: 'idle', text: 'relay idle, no page connected. Nothing has asked the relay for a picture.' };
    }
    if (state === 'live' && drawing) {
      return { tone: 'ok', text: `live. The page is drawing the feed${Number(f.fps) > 0 ? ` at ${Math.round(Number(f.fps))} fps` : ''}.` };
    }
    if (state === 'live') {
      return {
        tone: 'warn',
        text:
          Number(f.clients || 0) === 0
            ? 'feed ready, no page connected. The relay stops five seconds after the last page leaves.'
            : 'feed running, but no page is drawing the camera yet.',
      };
    }
    return { tone: 'idle', text: `relay state: ${state}. ${f.reason ? String(f.reason).slice(0, 140) : 'No reason reported.'}` };
  }

  /** One line of relay arithmetic, in the operator's words. */
  function cameraDiagnostic() {
    const { f, clients, selected } = cameraFacts();
    const bits = [`relay ${f.state || 'unknown'}`];
    bits.push(selected ? `source “${selected}”` : 'source not set');
    if (Number.isFinite(Number(f.frames))) bits.push(`${Number(f.frames)} frames`);
    if (Number(f.dropped) > 0) bits.push(`${Number(f.dropped)} dropped`);
    const pages = Number(f.clientCount ?? f.clients ?? 0);
    bits.push(`${pages} page${pages === 1 ? '' : 's'}`);
    // The relay's client records and its page count can disagree; that gap is worth seeing.
    if (clients.length && clients.length !== pages) bits.push(`${clients.length} client records`);
    const quiet = clients.filter((c) => c && c.hidden);
    if (quiet.length) bits.push(`${quiet.length} hidden`);
    return bits.join(' · ');
  }

  /** How old the device list is. The cache is 30 s, so this says when, not whether. */
  function cameraListLine() {
    if (s.camerasBusy) return 'scanning. DirectShow enumeration takes 2 to 8 s and switches the virtual cameras on.';
    if (s.camerasErr && !s.cameras) return `camera list unavailable: ${s.camerasErr}`;
    if (!s.cameras) return 'camera list not read yet.';
    const age = Math.max(0, Math.round((Date.now() - (s.camerasReadAt || Date.now())) / 1000));
    const when = age < 2 ? 'as of just now' : `as of ${age} s ago`;
    const n = Array.isArray(s.cameras.devices) ? s.cameras.devices.length : 0;
    return `${n} camera${n === 1 ? '' : 's'} ffmpeg can open, ${when}${s.cameras.cached ? ', from the 30 s cache' : ''}.`;
  }

  async function loadCameras(rescan = false) {
    s.camerasBusy = true;
    s.camerasErr = null;
    render();
    try {
      const out = rescan ? await api.post('/api/handfx/cameras/rescan', {}) : await api.get('/api/handfx/cameras');
      s.camerasReadAt = Date.now() - Math.max(0, Number((out && out.ageMs) || 0));
      if (out && out.ok === false) {
        s.camerasErr = String(out.error || 'the server could not list devices');
      } else {
        s.cameras = out || null;
      }
      if (out && out.error && !s.camerasErr) s.camerasErr = String(out.error);
    } catch (err) {
      s.camerasErr = err.message;
    } finally {
      s.camerasBusy = false;
      render();
    }
  }

  /** The dropdown. Virtual cameras are marked in the option text and by a badge beside the select. */
  function cameraSelect(selected) {
    const wrap = el('div', { class: 'hfx-cam-pick' });
    const sel = el('select', { class: 'hfx-select', id: 'cam-source', 'aria-label': 'camera device' });
    const c = s.cameras;
    const devices = c && Array.isArray(c.devices) ? c.devices.slice() : [];
    const known = devices.some((d) => d.name === selected);

    if (!devices.length) {
      sel.append(el('option', { value: selected || '', text: c ? 'no camera ffmpeg can open' : 'device list not read yet' }));
    } else if (selected && !known) {
      sel.append(el('option', { value: selected, text: `${selected} (set here, not in this list)` }));
    } else if (!selected) {
      // An empty setting means "whatever ffmpeg opens first"; say that instead of silently
      // displaying the first device as if the operator had chosen it.
      sel.append(el('option', { value: '', text: '(first camera ffmpeg opens)' }));
    }
    for (const d of devices) {
      sel.append(el('option', { value: d.name, text: d.virtual ? `${d.name} · virtual` : d.name }));
    }
    sel.value = selected || (devices[0] ? devices[0].name : '');
    sel.disabled = s.camerasBusy;
    sel.addEventListener('change', async () => {
      const to = sel.value;
      const active = (s.cameras && s.cameras.live) || cameraFacts().f.source || '';
      sel.disabled = true;
      try {
        await patch('cameraRelaySource', to);
        s.cameraPending = to && to !== active ? { from: active, to } : null;
        push(
          s.cameraPending
            ? `camera set to “${to}”. The feed still reads the old device until you press Restart camera.`
            : `camera set to “${to}”. It is already the device the feed reads.`,
          'warn',
        );
      } catch (err) {
        push(`camera setting refused: ${err.message}`, 'bad');
      }
      render();
    });
    wrap.append(sel);

    const dev = devices.find((d) => d.name === selected);
    if (dev && dev.virtual) wrap.append(el('span', { class: 'hfx-badge', text: 'virtual' }));
    return wrap;
  }

  function cameraActions() {
    const box = el('div', { class: 'hfx-row hfx-actions' });

    const restart = el('button', {
      type: 'button',
      class: 'btn btn-sm hfx-cam-restart',
      text: 'Restart camera',
      title: 'Stops ffmpeg and starts it again on the selected device. The feed drops for a second or two.',
    });
    restart.disabled = s.camerasBusy;
    restart.addEventListener('click', async () => {
      restart.disabled = true;
      restart.textContent = 'restarting…';
      s.cameraRestartErr = null;
      try {
        const res = await restartCamera();
        if (res && res.queued) {
          // held until Apply: the feed still reads the old device, so cameraPending stays set
          push('camera restart held. It reaches the relay when you press Apply.', 'warn');
          render();
          return;
        }
        s.cameraPending = null;
        await refresh();
      } catch (err) {
        s.cameraRestartErr = `${err.message}. Nothing was restarted.`;
      }
      render();
    });

    const scan = el('button', {
      type: 'button',
      class: 'btn btn-quiet btn-sm',
      text: s.camerasBusy ? 'scanning…' : 'Refresh list',
      title: 'Asks ffmpeg to list DirectShow devices again. Takes 2 to 8 s and switches the virtual cameras on.',
    });
    scan.disabled = s.camerasBusy;
    scan.addEventListener('click', () => loadCameras(true));

    box.append(restart, scan);
    return box;
  }

  /** Devices ffmpeg cannot open as video: listed, never selectable. */
  function cameraOtherDevices() {
    const list = s.cameras && Array.isArray(s.cameras.nonVideo) ? s.cameras.nonVideo : [];
    if (!list.length) return null;
    return el(
      'details',
      { class: 'hfx-cam-other' },
      el('summary', { text: `${list.length} device${list.length === 1 ? '' : 's'} ffmpeg cannot open as video` }),
      el('ul', {}, list.map((d) => el('li', { text: `${d.name}${d.kind && d.kind !== 'none' ? ` (${d.kind})` : ''}` }))),
    );
  }

  function cameraCard() {
    const { f, selected } = cameraFacts();
    const pill = cameraPill();
    const card = el('section', { class: 'panel hfx-cam' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Camera' })));

    const bodyEl = el('div', { class: 'panel-body hfx-fields' });
    bodyEl.append(cameraSelect(selected));
    bodyEl.append(el('div', { class: 'hfx-cam-state' }, el('span', { class: 'hfx-pill', 'data-tone': pill.tone, text: pill.text })));
    bodyEl.append(cameraActions());
    bodyEl.append(el('div', { class: 'hfx-note hfx-cam-diag', text: cameraDiagnostic() }));
    if (f.reason) bodyEl.append(el('div', { class: 'hfx-note', text: `Relay says: ${String(f.reason).slice(0, 200)}` }));
    if (f.error) bodyEl.append(el('pre', { class: 'hfx-stderr', text: String(f.error).slice(-600) }));
    if (s.cameraRestartErr) bodyEl.append(el('div', { class: 'hfx-note bad', text: `restart: ${s.cameraRestartErr}` }));
    bodyEl.append(el('div', { class: 'hfx-note hfx-cam-list', text: cameraListLine() }));
    if (s.camerasErr && s.cameras) bodyEl.append(el('div', { class: 'hfx-note', text: `this read failed: ${s.camerasErr}` }));
    const other = cameraOtherDevices();
    if (other) bodyEl.append(other);
    card.append(bodyEl);
    return card;
  }

  function trackingCard() {
    const card = el('section', { class: 'panel' });
    const src = effectiveSource();
    const loop = renderLoop();
    card.append(el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Tracking' }),
      el('span', { class: 'hfx-pill', 'data-tone': src.tone, text: src.text }),
    ));
    const body = el('div', { class: 'panel-body hfx-fields' });
    body.append(
      row('effects enabled', switchControl('enabled', s.settings.enabled !== false, async (v) => { await patch('enabled', v); if (v) await bus('tracking.toggle').catch(() => {}); })),
      // The persisted hand source. The pill above shows what it resolved to right now, so `auto`
      // that fell back to the rig is visible without reading the camera error.
      row('hand source', selectControl('trackingSource', s.settings.trackingSource || 'auto', (s.status?.settings?.trackingSource?.values) || ['auto', 'camera', 'synthetic'], (v) => patch('trackingSource', v))),
      ...(src.why ? [el('div', { class: 'hfx-note', text: `camera: ${String(src.why).slice(0, 160)}` })] : []),
      // The paint loop beside the source that feeds it: the page can be alive and acking while its
      // document gets no frames, and the rows above would still read healthy without this.
      row('render loop', el('span', { class: 'hfx-pill', 'data-tone': loop.tone, text: loop.text })),
      ...(loop.note ? [el('div', { class: 'hfx-note', text: loop.note })] : []),
      // The source (the overlay page) and this preview read the same flag, so the operator can
      // never tune effects that the OBS source is not drawing.
      row('effects in OBS', switchControl('obsHandFx', s.settings.obsHandFx !== false, async (v) => patch('obsHandFx', v))),
      row('mirror', switchControl('mirror', s.settings.mirror !== false, async (v) => patch('mirror', v))),
      row('debug overlay', switchControl('debugOverlay', s.settings.debugOverlay === true, async (v) => patch('debugOverlay', v))),
      row('sensitivity', sliderControl('sensitivity', s.settings.sensitivity ?? 1, 0.4, 2, 0.05, (v) => patch('sensitivity', v))),
      row('travel', sliderControl('bufferScroll', s.settings.bufferScroll ?? 0.35, 0, 1.5, 0.05, (v) => patch('bufferScroll', v))),
      row('resolution', selectControl('resolution', s.settings.resolution || '720p', (s.status?.settings?.resolution?.values) || ['480p', '720p', '1080p'], (v) => patch('resolution', v))),
    );
    card.append(body);
    if (s.settings.obsHandFx === false) {
      card.append(el('p', { class: 'hfx-help hfx-note warn', text: 'Effects are off for OBS: the overlay page still tracks hands and reports gestures, but it draws no effects — and neither does this preview.' }));
    }
    return card;
  }

  /** Start and Stop for the body source: a command on the control channel, never a camera open. */
  function bodyAction(cmd, label, variant) {
    return el('button', {
      type: 'button',
      class: variant,
      text: label,
      title:
        cmd === 'start'
          ? 'asks the OBS body source to open its camera and start publishing the mask'
          : 'asks the OBS body source to stop and close its camera',
      onclick: () => {
        if (!bodyCtl) {
          push('this browser has no BroadcastChannel, so the pane cannot reach the body source', 'bad');
          return;
        }
        bodyCtl.postMessage({ cmd, at: Date.now() });
        push(`body ${cmd} sent to the OBS body source`, 'ok');
      },
    });
  }

  /**
   * The body view, embedded in the pane. `?embed=1` makes the page a viewer: OBS keeps the camera,
   * the mask publishing and the /ack beat (see pages/js/body/main.js), and this card only watches
   * the mask arrive. Built once and then updated in place: a detached iframe reloads, and a
   * reload here would restart the viewer on every status poll.
   */
  function bodyCard() {
    const card = el('section', { class: 'panel hfx-body-card' });
    bodyPillEl = el('span', { class: 'hfx-pill', 'data-tone': 'idle', text: 'reading status' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Body camera' }), bodyPillEl));

    const body = el('div', { class: 'panel-body hfx-fields' });
    bodyPv = mountPreview(bodyHost, {
      title: 'Body view',
      hint: 'live mask from the OBS body source; this view never opens a camera',
      src: '/shockfx/body?embed=1',
      interactive: false,
    });
    bodyBeatEl = el('div', { class: 'hfx-note', text: '' });
    body.append(
      el('div', { class: 'hfx-body-embed' }, bodyHost),
      el(
        'div',
        { class: 'hfx-row hfx-actions' },
        bodyAction('start', 'Start body source', 'btn btn-sm'),
        bodyAction('stop', 'Stop body source', 'btn btn-quiet btn-sm'),
        actionButton({ label: 'projectile.fire', title: 'throw the projectile from the current hand anchor', variant: 'btn btn-quiet btn-sm', run: () => bus('projectile.fire', { skin: shootSkin() }), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
        actionButton({ label: 'edit.clear', title: 'wipe the hand-edit canvas', variant: 'btn btn-quiet btn-sm', run: () => bus('edit.clear'), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
      ),
      el('p', { class: 'hfx-help', text: 'The body browser source in OBS owns the camera and publishes the mask. Start and Stop ask it to open or close that camera. This pane never opens the camera itself, so the two cannot fight over the device.' }),
      bodyBeatEl,
    );
    if (s.status && s.status.bodyPage) {
      body.append(
        el('a', { class: 'gen-link hfx-open', href: s.status.bodyPage, target: '_blank', rel: 'noopener' },
          el('span', { class: 'gen-link-title', text: 'Open the body tracking page on its own' }),
          el('span', { class: 'gen-link-go', text: 'open ↗', 'aria-hidden': 'true' })),
      );
    }
    card.append(body);
    return card;
  }

  /** The body card's text, updated in place so its iframe is never rebuilt. */
  function updateBodyCard() {
    if (!bodyPillEl) return;
    const b = bodySummary();
    bodyPillEl.dataset.tone = b.tone;
    bodyPillEl.textContent = b.text;
    const page = (s.status && s.status.body) || {};
    if (bodyBeatEl) {
      bodyBeatEl.textContent = page.lastPoseAt
        ? `body source beat ${Math.round((Date.now() - page.lastPoseAt) / 1000)} s ago`
        : 'no beat from the OBS body source yet. Start it above, or check that its browser source is open in OBS.';
    }
  }

  function lookCard() {
    const card = el('section', { class: 'panel' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Overlay' }), el('span', { class: 'panel-hint mono', text: (s.status && s.status.page) || '/shockfx' })));
    const body = el('div', { class: 'panel-body' });
    const link = el('a', { class: 'gen-link hfx-open', href: (s.status && s.status.page) || '/shockfx', target: '_blank', rel: 'noopener' },
      el('span', { class: 'gen-link-title', text: 'Open the overlay page' }), el('span', { class: 'gen-link-go', text: 'open ↗', 'aria-hidden': 'true' }));
    body.append(link, el('p', { class: 'hfx-help', text: 'In OBS, add this URL as a Browser Source at the canvas size. The page hides its controls in OBS; ?controls=1 shows them.' }));
    card.append(body);
    return card;
  }

  function effectsCard(reg) {
    const card = el('section', { class: 'panel hfx-effects' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Effect registry' }), el('span', { class: 'panel-hint', text: `${(s.settings.effects || []).length} in the list of ${reg.length}` })));
    const grid = el('div', { class: 'hfx-effect-grid' });
    for (const e of reg) {
      if (!e.id) continue;
      const on = effectEnabled(e.id);
      const intensity = Number((s.settings.intensity || {})[e.id] ?? 1);
      const live = s.live.get(e.id);
      const title = effectTitle(e, e.id);
      const tile = el('div', { class: 'hfx-effect', 'data-on': on ? 'true' : 'false', 'data-known': e.known ? 'true' : 'false' });
      const top = el('div', { class: 'hfx-effect-top' });
      // `frag` drops the absent children; a raw `.append` is the browser's, and this browser's
      // `Node.append` stringifies `null` into a text node — "nullnull" was exactly that: two
      // absent pills next to every effect's name. Anything that may be absent goes through `frag`.
      top.append(
        frag(
          el('span', { class: 'hfx-effect-name', text: title.text }),
          // A derived title is the id in words, so the id next to it would only repeat it.
          title.derived ? null : el('span', { class: 'hfx-effect-id mono', text: e.id }),
          live ? el('span', { class: 'hfx-pill', 'data-tone': 'ok', text: 'live' }) : null,
          e.known ? null : el('span', { class: 'hfx-pill', 'data-tone': 'bad', text: 'not in this build' }),
        ),
      );
      const mid = el('div', { class: 'hfx-effect-meta' },
        el('span', { class: 'hfx-note', text: e.gesture ? `gesture: ${e.gesture}` : '' }),
        el('span', { class: 'hfx-note mono', text: e.from ? `port: ${e.from}` : '' }),
      );
      const controls = el('div', { class: 'hfx-effect-controls' },
        switchControl(`fx-${e.id}`, on, async () => toggleEffect(e.id), { disabled: !e.known }),
        el('span', { class: 'hfx-sep' }),
        actionButton({ label: 'earlier', title: 'move earlier in the list', variant: 'btn btn-sm', run: () => moveEffect(e.id, -1), onDone: () => render(), onError: (err) => push(err.message, 'bad') }),
        actionButton({ label: 'later', title: 'move later in the list', variant: 'btn btn-sm', run: () => moveEffect(e.id, 1), onDone: () => render(), onError: (err) => push(err.message, 'bad') }),
      );
      const slider = sliderControl(`intensity-${e.id}`, intensity, 0, 2, 0.05, (v) => setIntensity(e.id, v), { disabled: !e.known || !on });
      controls.append(slider);
      tile.append(top, mid, controls);
      // `shoot` wears one of two skins; the setting is optional and per-id (module.json: skins).
      if (e.skin && e.known) {
        tile.append(el('div', { class: 'hfx-effect-meta' },
          el('span', { class: 'hfx-note', text: 'skin' }),
          selectControl(`skin-${e.id}`, shootSkin(), SKINS, (v) => setSkin(v)),
        ));
      }
      grid.append(tile);
    }
    card.append(grid);
    return card;
  }

  function footer(reg) {
    const card = el('section', { class: 'panel hfx-footer' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Bus' }), el('span', { class: 'panel-hint mono', text: (s.status && s.status.cmds ? s.status.cmds.join(' · ') : '') })));
    const body = el('div', { class: 'panel-body hfx-footer-body' });
    const log = el('div', { class: 'hfx-log' });
    body.append(el('p', { class: 'hfx-help', text: 'Commands go to the page over the handfx channel; the page reports the effect it reached. A deck key sends the same POST /api/handfx/cmd.' }), log);
    card.append(body);
    return card;
  }

  /* -------------------------------------------------------------- controls */

  function row(label, control) {
    return el('div', { class: 'hfx-row' }, el('span', { class: 'hfx-label', text: label }), control);
  }

  function switchControl(id, value, onChange, opts = {}) {
    const input = el('input', { type: 'checkbox', id, disabled: opts.disabled ? true : undefined });
    input.checked = Boolean(value);
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        await onChange(input.checked);
      } catch (err) {
        input.checked = !input.checked;
        push(`“${id}”: ${err.message}`, 'bad');
      }
      input.disabled = false;
      render();
    });
    return el('label', { class: 'switch hfx-switch' }, input, el('span', { class: 'switch-track' }));
  }

  function sliderControl(id, value, min, max, step, onChange, opts = {}) {
    const wrap = el('span', { class: 'hfx-slider' });
    const range = el('input', { type: 'range', id: `set-${id}`, min, max, step, value: String(value), disabled: opts.disabled ? true : undefined });
    const num = el('span', { class: 'mono hfx-slider-value', text: Number(value).toFixed(2) });
    range.addEventListener('input', () => {
      num.textContent = Number(range.value).toFixed(2);
    });
    range.addEventListener('change', async () => {
      try {
        const out = await onChange(Number(range.value));
        if (out && out.before !== undefined && Number(out.before) === Number(range.value)) num.textContent = Number(range.value).toFixed(2);
      } catch (err) {
        push(`“${id}”: ${err.message}`, 'bad');
      }
    });
    wrap.append(range, num);
    return wrap;
  }

  function selectControl(id, value, values, onChange) {
    const sel = el('select', { class: 'hfx-select', id });
    for (const v of values) {
      const o = el('option', { value: v, text: v });
      if (v === value) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', async () => {
      try {
        await onChange(sel.value);
        render();
      } catch (err) {
        push(`“${id}”: ${err.message}`, 'bad');
        render();
      }
    });
    return sel;
  }

  /* -------------------------------------------------------------- effect preview */

  // The pane draws with the same engine module the overlay does, on its own canvas and its own
  // settings: the operator's list, intensity and mirror come in, but only the chosen effect is
  // live here. The renderer and its canvas outlive a re-render (the canvas is re-attached, never
  // remade), so the WebGL context survives the pane's status refresh.
  function underlayToggle() {
    const input = el('input', { type: 'checkbox', id: 'hfx-underlay' });
    input.checked = s.underlay !== false;
    input.addEventListener('change', async () => {
      const want = input.checked;
      s.underlay = want;
      try {
        await patch('underlay', want);
        push(`underlay ${want ? 'on' : 'off'}`, 'ok');
      } catch (err) {
        s.underlay = !want;
        input.checked = !want;
        push(`underlay refused: ${err.message}`, 'bad');
      }
    });
    return el('label', { class: 'hfx-underlay', title: 'the camera feed under the effects' },
      input, el('span', { class: 'hfx-note', text: 'Underlay' }));
  }

  /* -------------------------------------------------------------- wiring */

  const unsub = events.subscribe('handfx', (msg) => {
    if (!msg) return;
    // The overlay's honest status line is `events.emit('handfx', 'page', {...})`, which reaches
    // the bus as `{event: 'page', channel: 'handfx', data}` (a command frame carries `cmd`).
    if (msg.event === 'page') {
      const data = msg.data || {};
      s.page = data;
      if (data.effect) {
        if (!s.live.has(data.effect)) s.live.set(data.effect, { startedAt: Date.now(), hands: data.hands, gesture: data.gesture });
      }
      render();
      return;
    }
    // Any command can have changed the document (mirror.toggle writes it), and the pane's own
    // controls rendered from the old values would then lie: re-read rather than guess.
    if (msg.cmd) scheduleRefresh();
    // The body page's beat arrives as its own /ack; the mask timestamp lives on /status, so a
    // page event is a reason to re-read the status too (throttled like everything else).
    if (msg.event === 'page') scheduleRefresh();
  });

  let refreshTimer = 0;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().then(render).catch(() => {}), 150);
  }

  try {
    await refresh();
  } catch (err) {
    root.append(banner(`Cannot read /api/handfx/status: ${err.message}`, 'bad'));
    return () => unsub();
  }
  render();

  // The device list, read once. It is cached for 30 s and enumeration is a real side effect (it
  // launches the virtual-camera clients), so this never joins the status poll.
  loadCameras().catch(() => {});

  // The body-tracking row is about the last few seconds (mask freshness), not the last command:
  // re-read the status on a slow beat so it ages honestly on an idle pane.
  const bodyTimer = setInterval(() => {
    if (document.hidden) return;
    refresh().then(render).catch(() => {});
  }, 3000);

  signal.addEventListener('abort', () => {
    clearTimeout(refreshTimer);
    clearInterval(bodyTimer);
    unsub();
  });

  return () => {
    clearTimeout(refreshTimer);
    unsub();
  };
}

