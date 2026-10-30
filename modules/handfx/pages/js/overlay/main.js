// The overlay page: camera in, hands out, effects on a transparent canvas for OBS.
//
// Contract with the server (`GET /api/handfx/status`, SSE `handfx`, `POST /api/handfx/cmd`):
//   · the settings document is the server's; this page applies it and never writes it, except
//     through the same PATCH the pane uses (the page's own start/stop is a camera action, not a
//     setting)
//   · the bus carries commands; the page owns the effect *cursor* (which effect is "current")
//     and reports it back on `POST /api/handfx/ack` together with honest tracking state
//   · nothing here is a live parameter the server could learn: frames, landmarks, gestures and
//     intensities live and die in this page. /ack is a status line (effect, tracking, model,
//     hands, gesture), not a frame.
//
// Camera privacy: the camera opens on the overlay's own start button, or on `tracking.toggle`
// only if this document already holds permission — a deck key can start a session the operator
// armed, it can never prompt for the camera without a gesture in this page.

import { Tracker, syntheticHands } from '../engine/tracker.js';
import { classify, Motion, GestureGate } from '../engine/gestures.js';
import { FxRenderer, EFFECT_ORDER, anchorsFrom } from '../engine/fx.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('fx');
const badge = $('badge');
const banner = $('banner');

// Effect → beat. The shipped gestures are the two from the OBS project; the two-hand gestures
// the classifier can also see are used for the cursor so they never race the lightning arc.
const GESTURE_EFFECT = {
  palmUp: 'fireball',
  bothFingertips: 'lightning',
  palmFront: 'sparkring',
  swipe: 'smoke',
  palmTouch: 'next', // fingertips of both hands touching: step the effect list
  bothPalmsUp: 'embers', // both palms up: a pile of embers (the "handful of fire" pose)
};

const state = {
  settings: null,
  cursor: 0,
  tracking: false,
  camera: 'off', // off | asking | on | denied | held | error
  error: null,
  effect: null,
  model: 'idle',
  hands: 0,
  gesture: 'none',
  synthetic: false,
  lastAck: 0,
  startedAt: Date.now(),
};

const fx = new FxRenderer(canvas, { onError: (msg) => setBanner(`Effects unavailable: ${msg}`, 'bad') });
const tracker = new Tracker({ onFrame: onFrame, onState: onTrackerState });
const motion = new Motion();
const gate = new GestureGate();

let debugCtx = null;
let debugCanvas = null;
let lastDebugDraw = 0;

function setBanner(text, tone = 'warn') {
  banner.textContent = text || '';
  banner.dataset.tone = tone;
  banner.hidden = !text;
}

function setBadge(text, tone = 'idle') {
  badge.textContent = text || '';
  badge.dataset.tone = tone;
  badge.hidden = !text;
}

/* ---------------------------------------------------------------- settings + bus */

async function loadStatus() {
  const res = await fetch('/api/handfx/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function applySettings(status) {
  const s = {};
  for (const [k, d] of Object.entries(status.settings || {})) s[k] = d.value;
  state.settings = s;
  fx.setSettings({
    effects: s.effects && s.effects.length ? s.effects : [],
    intensity: s.intensity || {},
    bufferScroll: s.bufferScroll ?? 0.35,
    mirror: s.mirror !== false,
    debugOverlay: s.debugOverlay === true,
    enabled: s.enabled !== false,
  });
  if (s.debugOverlay && !debugCanvas) {
    debugCanvas = document.createElement('canvas');
    debugCanvas.className = 'debug';
    stage.insertBefore(debugCanvas, canvas);
    debugCtx = debugCanvas.getContext('2d');
  } else if (!s.debugOverlay && debugCanvas) {
    debugCanvas.remove();
    debugCanvas = null;
    debugCtx = null;
  }
  const list = effectiveEffects();
  if (state.cursor >= list.length) state.cursor = Math.max(0, list.length - 1);
  renderState();
}

/** The module's effect list, restricted to ids this build implements, in the served order. */
function effectiveEffects() {
  const list = (state.settings?.effects || []).filter((id) => EFFECT_ORDER.includes(id));
  return list;
}

function currentEffect() {
  const list = effectiveEffects();
  if (!list.length) return null;
  return list[Math.max(0, Math.min(list.length - 1, state.cursor))];
}

function stepEffect(dir) {
  const list = effectiveEffects();
  if (!list.length) return null;
  state.cursor = (state.cursor + dir + list.length) % list.length;
  state.effect = list[state.cursor];
  return state.effect;
}

function applyBusCommand(msg) {
  // Command frames are `{seq, channel, cmd, args, view}` on the SSE stream (see core/events).
  if (!msg || msg.channel !== 'handfx') return;
  if (msg.cmd === 'page') return; // this page's own status echo
  if (!msg.cmd) return;
  // `at` and `id` are the server's per-publish stamp: a ring replay after a reconnect must not
  // re-fire a one-shot (a reload would loop forever, an effect would double-spawn).
  if (msg.args && typeof msg.args.id === 'string') {
    if (!state.seenIds) state.seenIds = new Set();
    if (state.seenIds.has(msg.args.id)) return;
    state.seenIds.add(msg.args.id);
    if (state.seenIds.size > 200) state.seenIds = new Set([...state.seenIds].slice(-100));
  }
  const cmd = msg.cmd;
  if (cmd === 'effect.next' || cmd === 'effect.prev') {
    const id = stepEffect(cmd === 'effect.next' ? 1 : -1);
    fx.trigger(id, {});
    renderState();
    ack();
  } else if (cmd === 'effect.set') {
    const id = msg.args && msg.args.id;
    const list = effectiveEffects();
    if (list.includes(id)) {
      state.cursor = list.indexOf(id);
      state.effect = id;
      fx.trigger(id, {});
      renderState();
      ack();
    }
  } else if (cmd === 'tracking.toggle') {
    if (state.tracking) stopTracking();
    else startTracking({ fromBus: true });
  } else if (cmd === 'mirror.toggle' || cmd === 'settings.patch') {
    // The server already wrote the document; re-read it so the picture follows the operator.
    scheduleRefresh();
  } else if (cmd === 'reload') {
    location.reload();
  }
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadStatus().then(applySettings).catch(() => {});
  }, 120);
}

function connectBus() {
  const es = new EventSource('/events');
  let retry = 250;
  es.addEventListener('handfx', (ev) => {
    retry = 250;
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    applyBusCommand(data);
  });
  es.addEventListener('hello', () => {
    retry = 250;
  });
  es.onerror = () => setBadge('bus offline — retrying', 'warn');
  // The page keeps its cursor when the stream drops; the server's ring replays what it missed,
  // and the `id` check above drops anything already applied.
  es.onopen = () => {
    setBadge('', 'idle');
    scheduleRefresh();
  };
  return es;
}

/* ---------------------------------------------------------------- camera + tracking */

/** The camera needs an explicit action in this document: a click, or (for the deck) this tab
 *  already showing, already permitted, and in the foreground. A background tab that opens a
 *  camera on a bus command is exactly what browsers block, and what the pane must never do. */
function canStartFromBus() {
  // The operator has used this page recently (started, or pressed anything on it): a deck key may
  // continue that session, never open the first camera of a page nobody has touched.
  return document.visibilityState === 'visible' && (performance.now() - (startClicks.at || 0)) < 20000;
}
const startClicks = { at: 0 };

function noteStartClick() {
  startClicks.at = performance.now();
}

async function startTracking({ fromBus = false, synthetic = false } = {}) {
  if (state.tracking) return;
  if (fromBus && !canStartFromBus()) {
    setBanner('Camera not started: press Start once in this page (a browser only opens a camera from a real click).', 'warn');
    renderState();
    return;
  }
  state.synthetic = synthetic;
  state.camera = 'asking';
  renderState();
  const status = await loadStatus().catch(() => null);
  const s = state.settings || {};
  const opts = {
    resolution: s.resolution || '720p',
    deviceId: s.deviceId || '',
    sensitivity: s.sensitivity ?? 1,
    modelLocal: Boolean(status && status.model && status.model.local),
    modelUrl: status && status.model ? status.model.url : undefined,
  };
  if (synthetic) {
    tracker.startSynthetic();
    return;
  }
  const snap = await tracker.start(opts);
  if (snap.state === 'error') {
    state.camera = snap.error && /denied/i.test(snap.error) ? 'denied' : 'error';
    state.error = snap.error;
    state.tracking = false;
    setBanner(snap.error, 'bad');
  }
}

function stopTracking() {
  tracker.stop();
  state.tracking = false;
  state.camera = 'off';
  fx.releaseAll();
  renderState();
}

function onTrackerState(snap) {
  state.model = snap.model;
  state.tracking = snap.state === 'running';
  // The overlay's start is the operator's action for the bus: a deck key may start a session the
  // operator has just opened this page for, and may never open a camera on its own.
  if (snap.state === 'running') noteStartClick();
  if (snap.state === 'error') {
    state.camera = /denied/i.test(snap.error || '') ? 'denied' : 'error';
    state.error = snap.error;
    setBanner(snap.error, 'bad');
  } else if (snap.state === 'running') {
    state.camera = 'on';
    setBanner('');
  }
  renderState();
}

function onFrame(frame) {
  // Mirroring happens here, once: the classifier and the effects both work in page space.
  const mirror = state.settings?.mirror !== false;
  const hands = (frame.hands || []).map((h) => ({
    handedness: h.handedness,
    landmarks: mirror ? h.landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })) : h.landmarks,
  }));
  const centre = hands.length ? { x: hands[0].landmarks[9].x, y: hands[0].landmarks[9].y } : null;
  const swipe = motion.push(centre, frame.at);
  const result = classify(hands, { swipe });
  state.hands = hands.length;
  state.gesture = result.gesture || 'none';

  const now = frame.at;
  gate.tick(now);
  const fired = gate.update(result.gesture, now);
  if (fired.fire) {
    const want = GESTURE_EFFECT[fired.fire];
    if (want === 'next') {
      stepEffect(1);
      renderState();
    } else if (want && effectiveEffects().includes(want)) {
      fx.trigger(want, {});
    }
  }

  // Every pose feeds the effect it belongs to; the classifier's gesture *is* the beat. The cursor
  // (`effect.next` / `effect.prev`) is the list position a deck key steps, and the badge says so.
  // Embers are ambience, not a beat: any hand present keeps a rising ember field alive.
  if (hands.length && effectiveEffects().includes('embers') && !fx.live.has('embers') && result.gesture) {
    fx.trigger('embers', {});
  }
  const beat = GESTURE_EFFECT[fired.fire || result.gesture];
  if (beat && beat !== 'next' && effectiveEffects().includes(beat)) fx.trigger(beat, {});
  const anchors = anchorsFrom(result.hands);
  if (swipe && swipe.speed > 0.5 && anchors.anchor) anchors.swipe = { ...anchors.anchor, radius: 0.18 };
  fx.view = anchors;
  if (debugCtx) drawDebug(frame, hands, now);
  if (fx.settings.debugOverlay && tracker.video && now - (onFrame._texAt || 0) > 60) {
    onFrame._texAt = now;
    try {
      fx.setCameraTexture(tracker.video);
    } catch {
      /* a texture upload failure is a debug-overlay problem, not an effects one */
    }
  }
  state.effect = currentEffect();
  renderState(now);
  ack(now);
}

/* ---------------------------------------------------------------- honest state out */

function ack(now = performance.now()) {
  // At most 2/s: this is a status line, not telemetry.
  if (now - state.lastAck < 500) return;
  state.lastAck = now;
  fetch('/api/handfx/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      effect: state.effect,
      tracking: state.tracking,
      model: state.model,
      hands: state.hands,
      gesture: state.gesture,
      error: state.error,
    }),
  }).catch(() => {});
}

let statePaint = 0;
function renderState(now = performance.now()) {
  if (now - statePaint < 100 && state.tracking) return;
  statePaint = now;
  const bits = [];
  if (state.settings?.enabled === false) bits.push('effects off');
  if (state.synthetic) bits.push('SYNTHETIC replay — no camera, not tracking');
  else if (state.tracking) bits.push(`tracking · ${state.hands} hand${state.hands === 1 ? '' : 's'}`);
  else if (state.camera === 'asking') bits.push('starting camera…');
  else if (state.camera === 'denied') bits.push('camera denied');
  else if (state.camera === 'error') bits.push('camera error');
  else bits.push('idle');
  const list = effectiveEffects();
  const cur = currentEffect();
  state.effect = cur;
  const label = list.length ? `${state.cursor + 1}/${list.length} ${cur}` : 'no effects';
  setBadge(`${label} · ${bits.join(' · ')}`, state.tracking ? (state.synthetic ? 'warn' : 'ok') : 'idle');
  document.body.dataset.tracking = state.tracking ? 'true' : 'false';
  document.body.dataset.synthetic = state.synthetic ? 'true' : 'false';
  document.body.dataset.cursor = String(state.cursor);
  for (const b of startButtons) b.dataset.state = state.tracking ? 'on' : 'off';
}

/* ---------------------------------------------------------------- debug drawing */

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function drawDebug(frame, hands, now) {
  if (now - lastDebugDraw < 33) return;
  lastDebugDraw = now;
  const w = (debugCanvas.width = canvas.clientWidth);
  const h = (debugCanvas.height = canvas.clientHeight);
  debugCtx.clearRect(0, 0, w, h);
  if (tracker.video && tracker.video.readyState >= 2) {
    try {
      debugCtx.drawImage(tracker.video, 0, 0, w, h);
    } catch {
      /* first frame can be empty */
    }
  }
  for (const hand of hands) {
    const lm = hand.landmarks;
    debugCtx.strokeStyle = hand.handedness === 'Right' ? 'rgba(111,179,255,.9)' : 'rgba(177,140,255,.9)';
    debugCtx.lineWidth = 2;
    debugCtx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      debugCtx.moveTo(lm[a].x * w, lm[a].y * h);
      debugCtx.lineTo(lm[b].x * w, lm[b].y * h);
    }
    debugCtx.stroke();
    debugCtx.fillStyle = 'rgba(255,255,255,.85)';
    for (const p of lm) {
      debugCtx.beginPath();
      debugCtx.arc(p.x * w, p.y * h, 2.4, 0, Math.PI * 2);
      debugCtx.fill();
    }
  }
  debugCtx.font = '11px ui-monospace, monospace';
  debugCtx.fillStyle = 'rgba(255,255,255,.8)';
  debugCtx.fillText(`${hands.length} hand${hands.length === 1 ? '' : 's'} · ${state.gesture}${frame.source === 'synthetic' ? ' · synthetic' : ''}`, 10, h - 10);
}

/* ---------------------------------------------------------------- frame loop */

function loop(now) {
  if (state.settings && state.settings.enabled !== false) fx.render(now, fx.view || {});
  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------- buttons */

for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, noteStartClick, { capture: true });

const startButtons = [...document.querySelectorAll('[data-act="start"]')];
for (const b of startButtons) b.addEventListener('click', () => { noteStartClick(); startTracking(); });
const synthBtns = [...document.querySelectorAll('[data-act="synthetic"]')];
for (const b of synthBtns) b.addEventListener('click', () => (state.tracking ? stopTracking() : startTracking({ synthetic: true })));
for (const b of document.querySelectorAll('[data-act="stop"]')) b.addEventListener('click', () => stopTracking());

/* ---------------------------------------------------------------- boot */

(async function boot() {
  // In OBS the page is a browser source: no chrome. A normal tab keeps the small controls, and
  // `?controls=1` shows them over the source on purpose; `?clean=1` hides the badge too.
  const q = new URLSearchParams(location.search);
  const obs = Boolean(navigator.userAgent.match(/OBS\//i)) || q.has('obs');
  if (obs) document.body.dataset.obs = 'true';
  if (q.get('controls') === '1') document.body.dataset.controls = 'true';
  if (q.get('clean') === '1') document.body.dataset.clean = 'true';
  // The page is only cross-origin isolated if the server served it with COOP/COEP. If it is not,
  // say so rather than letting MediaPipe fail with something opaque later.
  const isolated = self.crossOriginIsolated === true;
  document.body.dataset.isolated = isolated ? 'true' : 'false';
  if (!isolated) {
    setBanner(
      `Not cross-origin isolated: this page was served without COOP/COEP. Tracking needs it; check /api/handfx/status → isolation.`,
      'bad',
    );
  } else if (!window.isSecureContext) {
    setBanner('Insecure origin: a camera cannot open here. Use http://127.0.0.1 or http://localhost.', 'bad');
  }
  const ok = fx.init();
  if (!ok) setBanner(fx.error, 'bad');
  try {
    const status = await loadStatus();
    applySettings(status);
    if (!status.runtime || !status.runtime.vendored) setBanner('MediaPipe runtime is not vendored — run the vendor copy step (modules/handfx/vendor/README.md).', 'bad');
  } catch (err) {
    setBanner(`Cannot read /api/handfx/status: ${err.message}`, 'bad');
  }
  connectBus();
  renderState();
  requestAnimationFrame(loop);
  // Test hook: the browser test drives the page through this, not through the DOM.
  window.__handfx = {
    state,
    fx,
    tracker,
    classify,
    syntheticHands,
    stepEffect,
    startTracking,
    stopTracking,
    applyBusCommand,
    currentEffect,
    isLive: () => fx.live.size > 0,
    liveIds: () => [...fx.live.keys()],
    ready: Boolean(fx.supported),
  };
})();
