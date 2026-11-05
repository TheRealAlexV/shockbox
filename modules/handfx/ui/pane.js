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
  root.append(headerHost, bannerHost, body, effectsHost, footerHost);

  const s = {
    status: null, // /api/handfx/status
    settings: {}, // plain values from the settings describe
    page: null, // last honest status line from the overlay
    live: new Map(), // effect id -> {startedAt, hands, gesture} (from the overlay's reports)
    underlay: true, // the camera feed under the effects; off leaves the dark backdrop
    log: [],
  };

  /* -------------------------------------------------------------- data */

  async function refresh() {
    s.status = await api.get('/api/handfx/status');
    s.settings = Object.fromEntries(Object.entries(s.status.settings || {}).map(([k, d]) => [k, d.value]));
    s.underlay = s.settings.underlay !== false;
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
    effectsHost.replaceChildren(effectsCard(reg));
    footerHost.replaceChildren(footer(reg));
    renderLog();
  }

  function header(status, reg, page, enabled) {
    const list = (s.settings.effects || []).filter((id) => reg.some((e) => e.id === id));
    const bar = el('div', { class: 'hfx-head' });
    bar.append(
      el('div', { class: 'hfx-head-left' },
        el('span', { class: 'hfx-title', text: 'ShockFX' }),
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

  /* The page is mounted once and re-attached on every render, so the iframe is never recreated
     by a bus event or a status poll. */
  const previewHost = el('div', { class: 'hfx-preview-host' });
  let pv = null;

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
    col.append(trackingCard(), bodyCard(), lookCard());
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
    if (eff === 'synthetic' && setting === 'synthetic') return { tone: 'info', text: 'synthetic (chosen)' };
    if (eff === 'synthetic') return { tone: why ? 'warn' : 'info', text: 'synthetic — auto fallback', why };
    if (setting === 'camera') return { tone: 'warn', text: 'camera only — nothing drawn' };
    return { tone: 'idle', text: 'nothing drawn yet' };
  }

  function trackingCard() {
    const card = el('section', { class: 'panel' });
    const src = effectiveSource();
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

