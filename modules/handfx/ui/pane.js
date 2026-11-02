// Hand FX admin pane.
//
// What the operator sets here is the server's (`PATCH /api/handfx/settings`): enable, effect order
// and per-effect intensity, mirror, sensitivity, camera device, resolution, debug overlay, the
// "next effect" gesture and the effect travel. What the pane shows about tracking is honest by
// construction:
//
//   · the camera is one document's to hold. If the overlay page has it, this pane lists the hands
//     and gestures the overlay reports on the bus (`handfx` → the `page` event) and says
//     "camera held by the overlay" — it does not open a second stream
//   · if the overlay is not tracking, the pane's own preview asks for the camera on the operator's
//     explicit click. Denied, held elsewhere, insecure origin and "model failed" are all named
//   · with no camera and no overlay it shows "synthetic replay" on request: a scripted hand that
//     goes through the real classifier, labelled as synthetic everywhere it appears
//   · the effect registry is the union of the server's ids and this build's implementations; a
//     setting naming an effect this build cannot draw is shown as such, not silently dropped
//
// The pane lives off the shell's own tokens (public/src/shell.css) and a small pane.css.

import { el, frag, clear, actionButton } from '/src/ui.js';
import { syntheticHands } from '../pages/js/engine/tracker.js';
import { classify as classifyPose, Motion } from '../pages/js/engine/gestures.js';
import { EFFECTS as ENGINE_EFFECTS, FxRenderer, anchorsFrom } from '../pages/js/engine/fx.js';

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

  const s = {
    status: null, // /api/handfx/status
    settings: {}, // plain values from the settings describe
    deviceList: [],
    streaming: false,
    streamError: null,
    camera: 'off', // off | asking | on | denied | held | error | insecure
    devices: 'idle', // idle | listing | denied | error
    page: null, // last honest status line from the overlay
    live: new Map(), // effect id -> {startedAt, hands, gesture} (from the overlay's reports)
    synthetic: false,
    underlay: true, // the camera feed under the effects; off leaves the dark backdrop
    previewEffect: null, // the effect id the preview draws live
    log: [],
  };

  let stream = null;
  let videoEl = null;
  let stopStream = () => {};

  /* -------------------------------------------------------------- data */

  async function refresh() {
    s.status = await api.get('/api/handfx/status');
    s.settings = Object.fromEntries(Object.entries(s.status.settings || {}).map(([k, d]) => [k, d.value]));
    return s.status;
  }

  async function patch(key, value) {
    const before = s.settings[key];
    const res = await api.patch('/api/handfx/settings', { [key]: value });
    s.settings = Object.fromEntries(Object.entries(res.settings || {}).map(([k, d]) => [k, d.value]));
    if (Array.isArray(res.changed) && !res.changed.includes(key)) {
      push(`“${key}” did not change on the server (sent ${JSON.stringify(value)})`, 'warn');
    }
    return { before, res };
  }

  async function bus(cmd, args) {
    const res = await api.post('/api/handfx/cmd', { cmd, args });
    push(`${cmd} → accepted by the server (seq ${res.seq ?? '—'})`, 'ok');
    return res;
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

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      s.devices = 'error';
      return;
    }
    if (!window.isSecureContext) {
      s.devices = 'insecure';
      return;
    }
    s.devices = 'listing';
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      s.deviceList = all.filter((d) => d.kind === 'videoinput');
      // Labels are blank until this origin has permission; say so rather than showing blanks.
      s.devices = s.deviceList.some((d) => d.label) ? 'ok' : 'unlabelled';
    } catch {
      s.devices = 'error';
    }
    if (root.isConnected) render();
  }

  async function startPreview(deviceId) {
    stopPreview();
    const insecure = secureText();
    if (insecure) {
      s.camera = 'insecure';
      s.streamError = insecure;
      render();
      return;
    }
    s.camera = 'asking';
    s.streamError = null;
    render();
    try {
      const res = s.settings.resolution || '720p';
      const size = { '480p': [640, 480], '720p': [1280, 720], '1080p': [1920, 1080] }[res] || [1280, 720];
      const constraints = { video: { width: { ideal: size[0] }, height: { ideal: size[1] } }, audio: false };
      const want = deviceId || s.settings.deviceId;
      if (want) constraints.video.deviceId = { exact: want };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      s.camera = 'on';
      await listDevices();
    } catch (err) {
      s.camera = /NotAllowed|Security/i.test(err.name || '') ? 'denied' : /NotReadable|Abort/i.test(err.name || '') ? 'held' : 'error';
      s.streamError = err.message || err.name;
      push(`camera: ${s.camera} — ${s.streamError}`, 'bad');
    }
    render();
  }

  function stopPreview() {
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null;
    if (s.camera !== 'held') s.camera = 'off';
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl = null;
    }
  }

  /* -------------------------------------------------------------- effects */

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
    if (!last) return { tone: 'idle', text: 'no body mask yet — open the body page and start it' };
    if (age < BODY_FRESH_MS) return { tone: 'ok', text: `mask arriving (${Math.round(age / 100) / 10}s ago)` };
    return { tone: 'warn', text: `mask stopped ${Math.round(age / 1000)}s ago — body effects are off` };
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
    clear(root);
    const status = s.status;
    const reg = registry();
    const enabled = s.settings.enabled !== false;
    const insecure = secureText();
    const page = pageSummary();

    root.append(header(status, reg, page, enabled));

    if (insecure) root.append(banner(insecure, 'bad'));
    if (status && (!status.runtime || !status.runtime.vendored)) {
      root.append(banner('The MediaPipe runtime is not vendored. The overlay will report “model failed”; see modules/handfx/vendor/README.md.', 'bad'));
    }
    if (status && status.model && !status.model.local) {
      root.append(banner(`No local model file: the overlay downloads hand_landmarker.task once from ${status.model.url} and caches it in Cache Storage.`, 'info'));
    }

    const body = el('div', { class: 'hfx-body' });
    body.append(previewCard(), sideColumn(reg, enabled));
    root.append(body);
    root.append(effectsCard(reg), footer(reg));
    renderLog();
  }

  function header(status, reg, page, enabled) {
    const list = (s.settings.effects || []).filter((id) => reg.some((e) => e.id === id));
    const bar = el('div', { class: 'hfx-head' });
    bar.append(
      el('div', { class: 'hfx-head-left' },
        el('span', { class: 'hfx-title', text: 'Hand FX' }),
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
    return el('div', { class: 'hfx-hero' }, bar, strip);
  }

  function banner(text, tone) {
    return el('div', { class: 'hfx-banner', 'data-tone': tone, text });
  }

  function previewCard() {
    const card = el('section', { class: 'panel hfx-preview' });
    const head = el('div', { class: 'panel-head' },
      el('span', { class: 'panel-title', text: 'Preview' }),
      el('span', { class: 'panel-hint mono', 'data-hfx-preview-state': s.camera }),
      effectPicker(),
    );
    const stage = el('div', { class: 'hfx-stage', 'data-state': s.camera, 'data-underlay': s.underlay ? 'on' : 'off' });
    const cam = el('video', { class: 'hfx-video', autoplay: true, muted: true, playsInline: true });
    cam.muted = true;
    const fxLayer = previewCanvas();
    const lm = document.createElement('canvas');
    lm.className = 'hfx-landmarks';
    const hud = el('div', { class: 'hfx-hud' });
    stage.append(cam, fxLayer, lm, hud);
    videoEl = cam;

    const note = el('div', { class: 'hfx-preview-note' });
    if (s.camera === 'on') note.append(el('span', { class: 'hfx-note ok', text: 'camera live in this pane' }));
    else if (s.camera === 'asking') note.append(el('span', { class: 'hfx-note', text: 'waiting for the permission prompt…' }));
    else if (s.camera === 'denied') note.append(el('span', { class: 'hfx-note bad', text: 'camera permission denied — allow it for this origin and try again' }));
    else if (s.camera === 'held') note.append(el('span', { class: 'hfx-note bad', text: 'camera held by another app or tab (the overlay, OBS, a call) — stop it there first' }));
    else if (s.camera === 'insecure') note.append(el('span', { class: 'hfx-note bad', text: 'camera needs a secure origin (127.0.0.1 / localhost / https)' }));
    else if (s.camera === 'error') note.append(el('span', { class: 'hfx-note bad', text: s.streamError || 'camera error' }));
    else {
      const page = pageSummary();
      if (page.tone === 'ok') note.append(el('span', { class: 'hfx-note', text: 'the overlay is tracking; its picture stays in its page (one camera, one document)' }));
      else note.append(el('span', { class: 'hfx-note', text: 'no camera here. The preview opens it on your click only; nothing is captured before that.' }));
    }
    note.append(
      underlayToggle(),
      actionButton({ label: s.camera === 'on' ? 'Stop preview' : 'Start preview', variant: 'btn btn-sm hfx-preview-btn', run: async () => (s.camera === 'on' ? stopPreview() : startPreview()), onDone: () => render(), onError: (err) => push(err.message, 'bad') }),
      actionButton({ label: s.synthetic ? 'Stop synthetic' : 'Synthetic', variant: 'btn btn-sm', run: async () => { s.synthetic = !s.synthetic; s.syntheticAt = performance.now(); synthMotion.push(null, performance.now()); }, onDone: () => render(), onError: (err) => push(err.message, 'bad') }),
    );
    if (s.synthetic) note.append(el('span', { class: 'hfx-note ok', text: 'synthetic hands — drawn over the camera feed when it is live, on the dark backdrop when it is not' }));
    card.append(head, stage, el('div', { class: 'panel-body hfx-preview-body' }, note));

    // After the DOM is in place: attach the live stream and start the landmark loop.
    queueMicrotask(() => {
      if (!videoEl) return;
      if (stream) videoEl.srcObject = stream;
      drawLandmarks();
      startFx();
    });
    return card;
  }

  function sideColumn(reg, enabled) {
    const col = el('div', { class: 'hfx-side' });
    col.append(trackingCard(), bodyCard(), cameraCard(), lookCard());
    return col;
  }

  function trackingCard() {
    const card = el('section', { class: 'panel' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Tracking' })));
    const body = el('div', { class: 'panel-body hfx-fields' });
    body.append(
      row('effects enabled', switchControl('enabled', s.settings.enabled !== false, async (v) => { await patch('enabled', v); if (v) await bus('tracking.toggle').catch(() => {}); })),
      row('mirror', switchControl('mirror', s.settings.mirror !== false, async (v) => patch('mirror', v))),
      row('debug overlay', switchControl('debugOverlay', s.settings.debugOverlay === true, async (v) => patch('debugOverlay', v))),
      row('sensitivity', sliderControl('sensitivity', s.settings.sensitivity ?? 1, 0.4, 2, 0.05, (v) => patch('sensitivity', v))),
      row('travel', sliderControl('bufferScroll', s.settings.bufferScroll ?? 0.35, 0, 1.5, 0.05, (v) => patch('bufferScroll', v))),
      row('next-effect gesture', selectControl('nextGesture', s.settings.nextGesture || 'bothFingertips', (s.status?.settings?.nextGesture?.values) || ['bothFingertips', 'palmTouch', 'bothPalmsUp', 'fist'], (v) => patch('nextGesture', v))),
      row('resolution', selectControl('resolution', s.settings.resolution || '720p', (s.status?.settings?.resolution?.values) || ['480p', '720p', '1080p'], (v) => patch('resolution', v))),
    );
    card.append(body);
    return card;
  }

  /** Body tracking: a read-only report of the body page's mask, plus its page link and buttons. */
  function bodyCard() {
    const card = el('section', { class: 'panel' });
    const b = bodySummary();
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Body tracking' }),
      el('span', { class: 'hfx-pill', 'data-tone': b.tone, text: b.text })));
    const body = el('div', { class: 'panel-body hfx-fields' });
    const page = s.status && s.status.body;
    body.append(
      el('p', { class: 'hfx-help', text: `The body page runs PoseLandmarker + ImageSegmenter in its own small Browser Source and posts one mask at ~15 Hz over BroadcastChannel('handfx.body'). Only timestamps come back here — a frame never crosses the wire. Body effects stop 1 s after the mask does.` }),
      el('div', { class: 'hfx-row hfx-actions' },
        actionButton({ label: 'projectile.fire', title: 'throw the projectile from the current hand anchor', variant: 'btn btn-sm', run: () => bus('projectile.fire', { skin: shootSkin() }), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
        actionButton({ label: 'edit.clear', title: 'wipe the hand-edit canvas', variant: 'btn btn-quiet btn-sm', run: () => bus('edit.clear'), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
      ),
      (s.status && s.status.bodyPage)
        ? el('a', { class: 'gen-link hfx-open', href: s.status.bodyPage, target: '_blank', rel: 'noopener' },
            el('span', { class: 'gen-link-title', text: 'Open the body tracking page' }), el('span', { class: 'gen-link-go', text: 'open ↗', 'aria-hidden': 'true' }))
        : null,
    );
    if (page && page.lastPoseAt) {
      body.append(el('div', { class: 'hfx-note', text: `body page beat ${Math.round((Date.now() - page.lastPoseAt) / 1000)}s ago` }));
    }
    card.append(body);
    return card;
  }

  function cameraCard() {
    const card = el('section', { class: 'panel' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Camera' })));
    const body = el('div', { class: 'panel-body hfx-fields' });
    const list = el('div', { class: 'hfx-devices' });
    if (s.devices === 'insecure') list.append(el('div', { class: 'hfx-note bad', text: 'device list unavailable: insecure origin' }));
    else if (!s.deviceList.length) list.append(el('div', { class: 'hfx-note', text: s.devices === 'unlabelled' ? 'camera found, name hidden until this origin has permission' : 'no camera listed yet — press Refresh' }));
    else {
      for (const d of s.deviceList) {
        const chosen = (s.settings.deviceId || '') === d.deviceId || (!s.settings.deviceId && d.deviceId === s.deviceList[0].deviceId);
        const b = el('button', { type: 'button', class: 'hfx-dev', 'data-chosen': chosen ? 'true' : 'false', title: d.label || d.deviceId });
        b.append(el('span', { class: 'hfx-dev-name', text: d.label || `camera ${d.deviceId.slice(0, 8) || '?'}` }), el('span', { class: 'hfx-dev-id mono', text: d.deviceId ? d.deviceId.slice(0, 10) : '' }));
        b.addEventListener('click', async () => {
          await patch('deviceId', d.deviceId || '');
          if (s.camera === 'on') await startPreview(d.deviceId);
          else render();
        });
        list.append(b);
      }
    }
    body.append(
      el('div', { class: 'hfx-row' }, el('span', { class: 'hfx-label', text: 'device' }), list),
      el('div', { class: 'hfx-row hfx-actions' },
        actionButton({ label: 'Refresh list', variant: 'btn btn-sm', run: listDevices, onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
        actionButton({ label: 'Clear device', variant: 'btn btn-quiet btn-sm', run: () => patch('deviceId', ''), onDone: () => render(), onError: (e) => push(e.message, 'bad') }),
      ),
      el('p', { class: 'hfx-help', text: 'The camera opens only on Start preview (or the overlay’s own Start). One document holds the camera at a time; the overlay holds it while it is tracking.' }),
    );
    card.append(body);
    return card;
  }

  function lookCard() {
    const card = el('section', { class: 'panel' });
    card.append(el('div', { class: 'panel-head' }, el('span', { class: 'panel-title', text: 'Overlay' }), el('span', { class: 'panel-hint mono', text: (s.status && s.status.page) || '/handfx' })));
    const body = el('div', { class: 'panel-body' });
    const link = el('a', { class: 'gen-link hfx-open', href: (s.status && s.status.page) || '/handfx', target: '_blank', rel: 'noopener' },
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
  let fxr = null;
  let fxCanvas = null;
  let fxRaf = 0;
  let fxKey = '';

  function previewCanvas() {
    if (!fxCanvas) {
      fxCanvas = document.createElement('canvas');
      fxCanvas.className = 'hfx-fx';
      fxCanvas.setAttribute('aria-hidden', 'true');
    }
    return fxCanvas;
  }

  /** What this build can draw, in the server's order — the preview offers only those. */
  function previewChoices() {
    const ids = registry().filter((e) => e.id && KNOWN.has(e.id)).map((e) => e.id);
    const list = [...new Set(ids)];
    return list.length ? list : [...KNOWN];
  }

  function previewEffectId() {
    const choices = previewChoices();
    if (s.previewEffect && choices.includes(s.previewEffect)) return s.previewEffect;
    return (s.settings.effects || []).find((id) => choices.includes(id)) || choices[0] || null;
  }

  function effectPicker() {
    const current = previewEffectId();
    const sel = el('select', { class: 'hfx-select hfx-preview-effect', 'aria-label': 'effect shown in the preview' });
    const choices = previewChoices();
    if (!choices.length) sel.append(el('option', { value: '', text: 'no effects in this build' }));
    for (const id of choices) {
      const title = effectTitle({ id }, id);
      sel.append(el('option', { value: id, text: `${title.text}${effectEnabled(id) ? '' : ' — off'}` }));
    }
    if (current) sel.value = current;
    sel.addEventListener('change', () => {
      s.previewEffect = sel.value || null;
      startFx();
    });
    return sel;
  }

  function underlayToggle() {
    const input = el('input', { type: 'checkbox', id: 'hfx-underlay' });
    input.checked = s.underlay;
    input.addEventListener('change', () => {
      s.underlay = input.checked;
      render();
    });
    return el('label', { class: 'hfx-underlay', title: 'the camera feed under the effects' },
      input, el('span', { class: 'hfx-note', text: 'Underlay' }));
  }

  /**
   * Anchors for the preview's frame. The pane has no detector of its own: with the synthetic rig on
   * the effects follow those hands; with it off there is nothing to anchor to, so they are drawn at
   * a fixed centre anchor rather than at a hand the pane cannot see.
   */
  function previewView(now) {
    if (s.synthetic) {
      if (!s.syntheticAt) s.syntheticAt = performance.now();
      return anchorsFrom(syntheticHands((now - s.syntheticAt) / 1000));
    }
    return {
      palms: [{ x: 0.5, y: 0.55, radius: 0.16 }],
      fingertipPairs: [],
      front: { x: 0.5, y: 0.55, radius: 0.12 },
      anchor: { x: 0.5, y: 0.55, radius: 0.2 },
      swipe: null,
      hands: [],
    };
  }

  function startFx() {
    cancelAnimationFrame(fxRaf);
    if (!fxCanvas || !fxCanvas.isConnected) return;
    if (!fxr) {
      fxr = new FxRenderer(fxCanvas, { onError: (msg) => push(`preview effects: ${msg}`, 'bad') });
      if (!fxr.init()) {
        fxr = null;
        return;
      }
    }
    const tick = (now) => {
      fxRaf = requestAnimationFrame(tick);
      if (!fxr || !fxr.gl) return;
      const id = previewEffectId();
      if (!id) return;
      const intensity = Number((s.settings.intensity || {})[id] ?? 1);
      const key = `${id}|${intensity}|${s.settings.mirror !== false}|${s.settings.bufferScroll ?? 0.35}`;
      if (key !== fxKey) {
        fxKey = key;
        fxr.setSettings({
          effects: [id],
          intensity: { [id]: intensity },
          mirror: s.settings.mirror !== false,
          bufferScroll: Number(s.settings.bufferScroll ?? 0.35),
          enabled: true,
        });
      }
      fxr.view = previewView(now);
      const live = fxr.live.get(id);
      // One-shots run out; re-fire instead of leaving an empty box after the first burst.
      if (!live || !live.active || (Number(live.age) || 0) > 3) fxr.trigger(id, { view: fxr.view });
      fxr.render(now, fxr.view);
    };
    fxRaf = requestAnimationFrame(tick);
  }

  /* -------------------------------------------------------------- landmark loop */

  let landmarkRaf = 0;
  function drawLandmarks() {
    cancelAnimationFrame(landmarkRaf);
    const canvas = root.querySelector('.hfx-landmarks');
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    const tick = () => {
      const stageEl = canvas.parentElement;
      const w = (canvas.width = stageEl.clientWidth);
      const h = (canvas.height = stageEl.clientHeight);
      ctx2d.clearRect(0, 0, w, h);
      const p = s.page;
      const fresh = p && Date.now() - (p.at || 0) < 6000;
      if (s.camera === 'on' && videoEl && videoEl.videoWidth) {
        // The pane draws its own landmarks when it holds the camera (same 21-point skeleton);
        // there is no detector in the pane, so it shows the picture only and says so in the HUD.
        ctx2d.font = '11px ui-monospace, monospace';
        ctx2d.fillStyle = 'rgba(255,255,255,.75)';
        ctx2d.fillText('preview only — detection runs in the overlay', 8, h - 8);
      } else if (fresh && p.tracking) {
        ctx2d.font = '11px ui-monospace, monospace';
        ctx2d.fillStyle = 'rgba(255,255,255,.75)';
        ctx2d.fillText(`overlay reports: ${p.hands} hand${p.hands === 1 ? '' : 's'} · ${p.gesture || 'none'}`, 8, h - 8);
      }
      if (s.synthetic) drawSynthetic(ctx2d, w, h);
      else synthMotion.push(null, performance.now());
      landmarkRaf = requestAnimationFrame(tick);
    };
    landmarkRaf = requestAnimationFrame(tick);
  }

  const synthMotion = new Motion();
  function drawSynthetic(c2d, w, h) {
    if (!s.syntheticAt) s.syntheticAt = performance.now();
    const t = (performance.now() - s.syntheticAt) / 1000;
    const hands = syntheticHands(t);
    const centre = hands.length ? { x: hands[0].landmarks[9].x, y: hands[0].landmarks[9].y } : null;
    const mv = synthMotion.push(centre, performance.now());
    const result = classifyPose(hands, { swipe: mv });
    s.syntheticReading = result.gesture;
    c2d.save();
    c2d.font = '11px ui-monospace, monospace';
    c2d.fillStyle = 'rgba(242,193,78,.9)';
    c2d.fillText(`SYNTHETIC REPLAY — not a camera, not tracking · ${result.gesture}`, 8, 16);
    const CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
    for (const hand of hands) {
      const lm = hand.landmarks;
      c2d.strokeStyle = hand.handedness === 'Right' ? 'rgba(111,179,255,.85)' : 'rgba(177,140,255,.85)';
      c2d.lineWidth = 2;
      c2d.beginPath();
      for (const [a, b] of CONN) {
        c2d.moveTo(lm[a].x * w, lm[a].y * h);
        c2d.lineTo(lm[b].x * w, lm[b].y * h);
      }
      c2d.stroke();
      c2d.fillStyle = 'rgba(255,255,255,.85)';
      for (const p of lm) {
        c2d.beginPath();
        c2d.arc(p.x * w, p.y * h, 2.4, 0, Math.PI * 2);
        c2d.fill();
      }
    }
    c2d.restore();
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
  await listDevices();
  render();

  // The body-tracking row is about the last few seconds (mask freshness), not the last command:
  // re-read the status on a slow beat so it ages honestly on an idle pane.
  const bodyTimer = setInterval(() => {
    if (document.hidden) return;
    refresh().then(render).catch(() => {});
  }, 3000);

  signal.addEventListener('abort', () => {
    cancelAnimationFrame(landmarkRaf);
    cancelAnimationFrame(fxRaf);
    clearTimeout(refreshTimer);
    clearInterval(bodyTimer);
    stopPreview();
    unsub();
  });

  return () => {
    cancelAnimationFrame(landmarkRaf);
    cancelAnimationFrame(fxRaf);
    clearTimeout(refreshTimer);
    stopPreview();
    unsub();
  };
}

