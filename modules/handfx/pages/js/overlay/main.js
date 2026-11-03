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
// Camera privacy: the overlay is the page that asks for the camera. It opens one on load (an OBS
// browser source nobody clicks must still see hands), on its own start button, or on
// `tracking.toggle` only if this document already holds permission — a deck key can start a
// session the operator armed, it can never prompt for the camera without a gesture in this page.
// No camera, no blank page: the synthetic rig draws until a real track runs, and comes back when
// that track fails or ends.

import { Tracker, syntheticHands } from '../engine/tracker.js';
import { createPublisher } from './publish.js';
import { createRelay } from './relay.js';
import { rearmCamera } from './rearm.js';
import { createWatchdog } from './watchdog.js';
import { classify, Motion, GestureGate } from '../engine/gestures.js';
import { FxRenderer, EFFECTS, anchorsFrom } from '../engine/fx.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('fx');
const badge = $('badge');
const banner = $('banner');

/** The cursor's list order is the registry's (engine/fx.js → EFFECTS): one source of truth. */
export const EFFECT_ORDER = Object.keys(EFFECTS);

// Gesture → the registry ids it beats. The left-hand names are the classifier's own results
// (`gestures.js`); the right-hand side is the registry's `gesture` documentation. A gesture can
// beat more than one effect, and the *current* cursor picks which one draws, so eight gestures
// can drive the whole list without racing each other. `next` steps the cursor (`palmTouch`,
// the shipped "fingertips touching" gesture, stays the "next effect" action).
const GESTURE_EFFECTS = {
  palmUp: ['fireball'],
  bothFingertips: ['lightning'],
  palmFront: ['sparkring', 'frost', 'portal', 'electroshock'],
  swipe: ['smoke', 'inkflow', 'echo'],
  palmTouch: 'next',
  bothPalmsUp: ['embers', 'bloomlife'],
  bothRaised: ['disco', 'meteor'],
  fist: ['shatter', 'cyber', 'edit'],
  point: ['shoot'],
  // `bodyAny` is not a hand gesture: the body page's mask is the trigger (see bodyChannel()).
};

const state = {
  settings: null,
  cursor: 0,
  tracking: false,
  camera: 'off', // off | asking | on | denied | held | error
  error: null,
  // Why the camera did not open: { at, stage, name, message }, stage is one of
  // enumerate | getUserMedia | track | timeout. Cleared the moment a camera track runs.
  cameraError: null,
  cameraLabel: null, // the label of the device the camera actually opened; null until one does
  // Where the frames actually come from: relay | device | synthetic | none.
  cameraSource: 'none',
  // The persisted camera mode: auto (camera when frames arrive, synthetic otherwise), camera only,
  // or synthetic only. Read from the settings document; no click decides it.
  trackingSource: 'auto',
  // The camera picture under the effects, persisted. Off leaves the page transparent for OBS.
  underlay: true,
  // Why the relay is not the source (string or null), reported next to cameraError.
  relayError: null,
  effect: null,
  model: 'idle',
  hands: 0,
  gesture: 'none',
  synthetic: false,
  anchors: 'none', // camera | synthetic | none — where the current frame's anchors came from
  draws: 0, // frames the renderer actually drew: the loop's own counter, reported on /ack
  lastDrawAt: 0,
  lastAck: 0,
  startedAt: Date.now(),
  bodyAt: 0, // last body-mask message (performance.now)
  bodySeen: false,
  status: null, // last /api/handfx/status read (the body page's model facts)
};

const fx = new FxRenderer(canvas, { onError: (msg) => setBanner(`Effects unavailable: ${msg}`, 'bad') });
const tracker = new Tracker({ onFrame: onFrame, onState: onTrackerState });
// The relayed camera: the server's ffmpeg feed of the WebcamSwitcher virtual camera. The page
// cannot open that device itself (WebcamSwitcher holds it), so it reads the MJPEG stream instead
// and feeds each decoded frame to the tracker's own detect path.
const relay = createRelay({
  onFrame: (bitmap) => tracker.pushFrame(bitmap),
  onState: (s) => {
    state.relayError = s.error || null;
    renderState();
    if (s.state !== 'error' || state.cameraSource !== 'relay') return;
    // The relayed camera went away (EOF, a read error, or 3 s without a frame). Hand the view back
    // the way a device track ending does — tracker to idle, then fallBackToSynthetic — and make the
    // page's one bounded retry, which the 5 s gap and the attempt cap already limit. No reconnect
    // loop. `anchors` is cleared here because the render loop only rewrites it when a frame arrives,
    // so a dead feed would otherwise keep reporting the last camera frame's `camera` forever.
    state.cameraSource = 'none';
    tracker.stop();
    state.anchors = 'none';
    void autoCamera();
  },
});
// The virtual camera's feed: only runs when the server says `publish` is not `off`.
const publisher = createPublisher({
  source: () => tracker.frameSurface() || tracker.video,
  fx: () => canvas,
  settings: () => state.settings || {},
  log: (msg) => console.warn(msg),
});
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

/** Record why a camera acquisition failed. `stage` is enumerate | getUserMedia | track | timeout. */
function setCameraError(stage, name, message) {
  state.cameraError = {
    at: Date.now(),
    stage,
    name: String(name || '').slice(0, 60),
    message: String(message || '').slice(0, 240),
  };
}

/* ---------------------------------------------------------------- settings + bus */

async function loadStatus() {
  const res = await fetch('/api/handfx/status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function applySettings(status) {
  // Values may arrive bare (the test and the pane's console hand in plain values) or wrapped as
  // `{ value }` (what server.js serves from settings.describe()). Both are the same document.
  const s = {};
  for (const [k, d] of Object.entries(status.settings || {})) s[k] = d && typeof d === 'object' && 'value' in d ? d.value : d;
  const prevSource = state.trackingSource;
  state.settings = s;
  state.status = status;
  state.trackingSource = s.trackingSource === 'camera' || s.trackingSource === 'synthetic' ? s.trackingSource : 'auto';
  state.underlay = s.underlay !== false;
  fx.setSettings({
    effects: s.effects && s.effects.length ? s.effects : [],
    intensity: s.intensity || {},
    skins: s.skins && typeof s.skins === 'object' ? s.skins : {},
    bufferScroll: s.bufferScroll ?? 0.35,
    mirror: s.mirror !== false,
    debugOverlay: s.debugOverlay === true,
    enabled: s.enabled !== false && s.obsHandFx !== false,
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
  // The virtual camera's mode and geometry travel with the status document; nothing else tells
  // this page whether to feed it.
  publisher.fromStatus(status);
  syncSyntheticMode();
  applyUnderlay();
  renderState();
  // The persisted mode changed under a running page (the pane's PATCH): switch the rig over.
  if (prevSource !== state.trackingSource) switchTrackingSource();
}

/** The module's effect list, restricted to ids this build implements, in the served order. An id
 *  this build cannot draw stays in the document and the pane shows it as such; it just never gets
 *  a cursor slot here, so `effect.next` cannot land on a blank. */
function effectiveEffects() {
  return (state.settings?.effects || []).filter((id) => EFFECT_ORDER.includes(id));
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
  syncSyntheticMode();
  return state.effect;
}

/**
 * The gestures that need a second hand. The synthetic rig reads this through the current effect's
 * registry entry, so a two-hand effect gets two hands and a one-hand effect keeps its single hand.
 */
const TWO_HAND_GESTURES = new Set(['bothFingertips', 'bothRaised', 'bothPalmsUp', 'palmTouch']);

function syncSyntheticMode() {
  const id = currentEffect();
  const twoHandEffect = Boolean(id && TWO_HAND_GESTURES.has(EFFECTS[id] && EFFECTS[id].gesture));
  // An explicit synthetic run shows a two-hand field; in auto the rig follows the current effect, so
  // a two-hand gesture never appears next to one floating hand.
  tracker.syntheticTwoHands = twoHandEffect || state.trackingSource === 'synthetic';
}

/** The persisted mode changed: drop what the old mode owns and start what the new one asks for. */
function switchTrackingSource() {
  if (state.tracking) stopTracking({ manual: false, keepView: true });
  autoCam.attempts = 0;
  autoCam.lastAt = 0;
  if (state.trackingSource !== 'camera') ensureSyntheticAnchors();
  else ack();
  if (state.trackingSource !== 'synthetic') autoCamera().catch(() => {});
}

/* ---------------------------------------------------------------- underlay */

// The camera picture under the effects. A second canvas rather than a <video>, because the relay
// carries decoded frames and the device path a video element; both land here the same way.
const camCanvas = $('cam');
const camCtx = camCanvas ? camCanvas.getContext('2d') : null;

function applyUnderlay() {
  document.body.dataset.underlay = state.underlay ? 'on' : 'off';
  if (!state.underlay && camCanvas && camCtx) camCtx.clearRect(0, 0, camCanvas.width, camCanvas.height);
}

/** One camera frame under the effects, mirrored like the effects (both live in page space). */
function paintUnderlay(surface) {
  if (!state.underlay || !camCtx || !surface) return;
  const w = Math.max(1, canvas.clientWidth || 0);
  const h = Math.max(1, canvas.clientHeight || 0);
  if (camCanvas.width !== w || camCanvas.height !== h) {
    camCanvas.width = w;
    camCanvas.height = h;
  }
  camCtx.save();
  if (state.settings?.mirror !== false) {
    camCtx.translate(w, 0);
    camCtx.scale(-1, 1);
  }
  try {
    camCtx.drawImage(surface, 0, 0, w, h);
  } catch {
    /* a surface that is not ready yet is not an error */
  }
  camCtx.restore();
}

function applyBusCommand(msg) {
  // Command frames are `{seq, channel, cmd, args, view}` on the SSE stream (see core/events).
  if (!msg || msg.channel !== 'handfx') return;
  if (msg.cmd === 'page') return; // this page's own status echo
  if (!msg.cmd) return;
  // `sid` is the server's per-publish stamp: a ring replay after a reconnect must not re-fire a
  // one-shot (a reload would loop forever, an effect would double-spawn). `args.id` is the
  // caller's own value — the effect id — so it is never used as the dedupe key.
  if (msg.args && typeof msg.args.sid === 'string') {
    if (!state.seenIds) state.seenIds = new Set();
    if (state.seenIds.has(msg.args.sid)) return;
    state.seenIds.add(msg.args.sid);
    if (state.seenIds.size > 200) state.seenIds = new Set([...state.seenIds].slice(-100));
  }
  const cmd = msg.cmd;
  if (cmd === 'effect.next' || cmd === 'effect.prev') {
    const id = stepEffect(cmd === 'effect.next' ? 1 : -1);
    ensureSyntheticAnchors(); // no camera: draw on the synthetic rig instead of nothing
    fx.trigger(id, {});
    renderState();
    ack();
  } else if (cmd === 'effect.set') {
    const id = msg.args && msg.args.id;
    const list = effectiveEffects();
    if (list.includes(id)) {
      state.cursor = list.indexOf(id);
      state.effect = id;
      // An effect is a render, not a promise of a hand: with no camera the synthetic anchors are
      // the rig, so the command draws now.
      ensureSyntheticAnchors();
      fx.trigger(id, {});
      renderState();
      ack();
    }
  } else if (cmd === 'tracking.toggle') {
    // The synthetic rig runs from load; only a real camera session counts as "started" here.
    if (state.tracking && !state.synthetic) stopTracking();
    else startTracking({ fromBus: true });
  } else if (cmd === 'projectile.fire') {
    const skin = msg.args && msg.args.skin;
    if (skin && state.settings) fx.setSettings({ skins: { ...(state.settings.skins || {}), shoot: skin } });
    const n = spawnShoot(fx.view || null);
    setBanner(n ? '' : 'projectile.fire: no hand in view — nothing fired', n ? 'ok' : 'warn');
    ack(performance.now());
  } else if (cmd === 'edit.clear') {
    fx.editClear();
    ack(performance.now());
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
  bus = es;
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

/** The page's EventSource, kept so recovery can drop the dead one and make a fresh connection. */
let bus = null;
/** A recovery is in flight: one at a time, and no re-entry from a second stale tick. */
let recovering = false;

/**
 * Re-arm the whole overlay path after the server comes back: a new bus connection, the current
 * settings (which carry the publish mode and the pipe geometry), a fresh relay reader and a fresh
 * tracker. The relay reader is torn down first: after a server restart it holds a stream that will
 * never deliver again, and `relay.start()` is a no-op while one is live.
 */
async function recoverOverlay(status) {
  if (recovering) return;
  recovering = true;
  try {
    try {
      bus?.close();
    } catch {
      /* already closed */
    }
    bus = null;
    connectBus();
    applySettings(status && status.settings ? status : await loadStatus());
    // A server restart is the server's failure, not this page's second camera failure: the check
    // that a machine has no camera at all must run again from zero.
    autoCam.attempts = 0;
    autoCam.lastAt = 0;
    // Re-arm the camera the settings ask for, not the one that last failed: a dead relay has
    // already set `camAttempted = false` and stopped tracking, so keying this on that state left
    // the page on synthetic hands until someone clicked Start.
    await rearmCamera({
      state,
      relay,
      tracker,
      autoCamera,
      userStopped,
      visible: document.visibilityState === 'visible',
    });
    publisher.kick();
    // A forced status line: `ack` is rate limited to 2/s and the recovery may have been silent.
    state.lastAck = 0;
    ack();
  } finally {
    recovering = false;
  }
}

/**
 * The connection watchdog. `ok()` is called by every successful /ack; when 5 s pass without one,
 * `probe` reads /status with capped exponential backoff (0.5 s doubling to 10 s), and the first
 * answer re-arms the page. Forty probes per page life: a server that never returns costs 40
 * requests, not a storm.
 */
const watchdog = createWatchdog({
  now: () => performance.now(),
  probe: loadStatus,
  recover: recoverOverlay,
  onState: (s) => {
    if (s.state === 'gave-up') setBanner('server is not back — reload this browser source when it is', 'bad');
    else if (s.state === 'stale') setBadge('bus offline — reconnecting', 'warn');
  },
});

/** The 1 s liveness beat. A hidden source has nothing to recover (its render loop is paused, so
 *  its acks stop too) and a tab coming back fires `visibilitychange`, which re-runs autoCamera. */
let booted = false;
setInterval(() => {
  if (!booted || document.visibilityState === 'hidden') return;
  void watchdog.tick();
}, 1000);

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

/** The operator pressed Stop: a stop is not a camera failure, so the synthetic rig stays off. */
let userStopped = false;
/** A camera session owned the page and has not handed it back yet (fallback is due when it does). */
let camWasLive = false;
/** A real camera acquisition was started: a failure of it goes back to the synthetic rig. */
let camAttempted = false;

/**
 * Hand the page back to the synthetic rig after a camera failed or its track ended, so the overlay
 * keeps animating instead of freezing on the last camera frame. Never on the operator's own Stop.
 */
function fallBackToSynthetic() {
  if (userStopped) return false;
  if (state.trackingSource === 'camera') return false; // camera only: a blank page beats a fake one
  if (state.tracking && !state.synthetic) return false; // another camera session owns the view
  const drew = ensureSyntheticAnchors();
  if (drew) {
    setBanner(state.error ? `${state.error} — drawing on synthetic hands` : 'No camera — drawing on synthetic hands', 'warn');
    ack();
  }
  return drew;
}

/**
 * The load attempt, and the one retry when the page is shown again. No gesture, no click: a page
 * nobody can click (an OBS browser source) still asks for the camera. `startTracking` tries the
 * server's relay first and enumerates only for the device path, so a machine whose camera belongs
 * to another app is never reported as having none. Two attempts at most, at least 5 s apart, never
 * in a loop.
 */
const AUTO_CAM_ATTEMPTS = 2;
const AUTO_CAM_GAP = 5000;
const autoCam = { attempts: 0, lastAt: 0, busy: false };

async function autoCamera() {
  if (state.trackingSource === 'synthetic') return false; // the operator asked for synthetic only
  if (autoCam.busy || autoCam.attempts >= AUTO_CAM_ATTEMPTS) return false;
  // No visibility gate: an OBS browser source reports `hidden` while it is not in the program, and
  // the relay needs neither a gesture nor permission, so waiting for "visible" is exactly the
  // click-free page that never starts. The server stops ffmpeg on its own when no client reads.
  if (state.tracking && !state.synthetic) return false; // a camera already owns the page
  const now = Date.now();
  if (autoCam.lastAt && now - autoCam.lastAt < AUTO_CAM_GAP) return false;
  autoCam.attempts += 1;
  autoCam.lastAt = now;
  autoCam.busy = true;
  try {
    userStopped = false;
    // Relay first, device second, synthetic last: all of it inside startTracking/openDevice.
    await startTracking();
    if (state.tracking && !state.synthetic) return true;
    fallBackToSynthetic();
    return false;
  } finally {
    autoCam.busy = false;
    renderState();
    ack();
  }
}

/**
 * The relayed camera, tried before the device: the one camera on this machine belongs to
 * WebcamSwitcher, and getUserMedia here only ever fails. `true` means either relay frames are
 * tracking, or the relay is up and its failure is the model's — a device attempt cannot help
 * with either, so the caller must not make one.
 */
async function startRelay(opts) {
  camAttempted = true; // a relay failure is a camera failure: the synthetic rig gets the view back
  const live = await relay.start();
  if (!live) {
    state.relayError = relay.reason() || 'relay: no frames';
    if (state.cameraSource === 'relay') state.cameraSource = 'none';
    return false;
  }
  const snap = await tracker.startRelay(opts);
  if (snap.state !== 'running') {
    state.relayError = snap.error || 'relay: tracking did not start';
    state.error = snap.error;
    state.camera = 'error';
    return true;
  }
  state.relayError = null;
  state.error = null;
  state.cameraSource = 'relay';
  return true;
}

/**
 * The device path, unchanged in behaviour: one enumerate so a machine with no video input is
 * reported as such instead of prompting for a device it lacks, then the tracker's getUserMedia.
 * Only reached when the relay is unavailable.
 */
async function openDevice(opts) {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
  } catch (err) {
    setCameraError('enumerate', err && err.name, err && err.message);
  }
  if (navigator.mediaDevices && !devices.some((d) => d.kind === 'videoinput')) {
    if (!state.cameraError) {
      setCameraError('enumerate', 'NoCamera', 'No video input device is present — drawing on synthetic hands.');
      setBanner('No camera device — drawing on synthetic hands', 'warn');
    }
    return null;
  }
  camAttempted = true;
  return tracker.start(opts);
}

async function startTracking({ fromBus = false, synthetic = false } = {}) {
  // A running camera owns the view; a running synthetic rig gives way to a real camera (the
  // overlay starts on synthetic when no camera arrives, so the Start button must still work).
  if (state.tracking && !state.synthetic) return;
  if (state.tracking) stopTracking({ manual: false, keepView: true });
  userStopped = false;
  // The persisted mode wins over the button and the bus: `synthetic` never opens a camera, and
  // needs no gesture to do it. `camera` never draws a synthetic frame.
  const wantSynthetic = synthetic || state.trackingSource === 'synthetic';
  if (fromBus && !canStartFromBus() && !wantSynthetic) {
    setBanner('Camera not started: press Start once in this page (a browser only opens a camera from a real click).', 'warn');
    renderState();
    return;
  }
  state.synthetic = wantSynthetic;
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
  syncSyntheticMode();
  if (wantSynthetic) {
    if (synthetic) tracker.syntheticTwoHands = true; // the button asks for the synthetic field
    tracker.startSynthetic();
    return;
  }
  // Relay first: on the rig the camera belongs to WebcamSwitcher, so it cannot be opened here.
  if (await startRelay(opts)) return;
  const snap = await openDevice(opts);
  if (!snap) {
    state.camera = state.cameraError ? 'error' : 'off';
    renderState();
    return;
  }
  if (snap.state === 'error') {
    state.camera = snap.error && /denied/i.test(snap.error) ? 'denied' : 'error';
    state.error = snap.error;
    state.tracking = false;
    setBanner(snap.error, 'bad');
  } else if (snap.state === 'running' && snap.source === 'camera') {
    // The device this page actually opened, not the one the settings asked for.
    state.cameraLabel = snap.deviceLabel || null;
    state.cameraSource = 'device';
  }
}

function stopTracking({ manual = true, keepView = false } = {}) {
  if (manual) userStopped = true;
  camWasLive = false;
  tracker.stop();
  relay.stop();
  state.cameraSource = 'none';
  state.tracking = false;
  state.synthetic = false; // the rig's frame loop is gone with the tracker; the flag goes with it
  state.camera = 'off';
  // Giving way to a camera that is still opening (`keepView`): the page keeps drawing on the
  // anchors it has instead of going blank while the device and the model load.
  if (!keepView) {
    state.anchors = 'none';
    fx.view = null;
    fx.releaseAll();
  }
  renderState();
}

/**
 * The rig this page runs on may have no camera at all (an OBS browser source on a streaming PC,
 * or a laptop with the lid shut). Rather than render nothing, the page keeps drawing on the
 * synthetic hands the pane already offers — same classifier, same renderer, labelled on the badge
 * and on /ack as `synthetic`, never claimed to be camera input. Returns whether it drew.
 */
function ensureSyntheticAnchors() {
  if (state.trackingSource === 'camera') return false; // camera only: never draw a synthetic frame
  if (state.tracking && !state.synthetic) return false; // a camera session owns the view
  // Ask the tracker, never a remembered flag: a camera attempt (and a Stop) closes the rig's frame
  // loop, and `state.synthetic` stayed true across it — the rig was then never restarted, so no
  // frames arrived, `fx.view` stopped moving and /ack (which rides on those frames) went quiet.
  if (tracker.state !== 'running' || tracker.source !== 'synthetic') tracker.startSynthetic();
  state.synthetic = true;
  state.tracking = true;
  state.cameraSource = 'synthetic';
  // Fill the view in this same tick, so a command fired now draws on the very next frame instead
  // of on the first frame of the synthetic loop.
  onFrame({
    hands: syntheticHands(performance.now() / 1000, { twoHands: tracker.syntheticTwoHands === true }),
    width: 640,
    height: 480,
    source: 'synthetic',
    at: performance.now(),
  });
  return true;
}

function onTrackerState(snap) {
  state.model = snap.model;
  state.tracking = snap.state === 'running';
  // Where the frames come from, taken from the tracker rather than remembered: a stopped tracker
  // is a stopped rig, and treating it as running is how the page went quiet while it still drew.
  state.synthetic = snap.state === 'running' && snap.source === 'synthetic';
  // Relay and device both report camera anchors; the feed says which pipe carried them.
  if (snap.state === 'running' && snap.source === 'camera') {
    state.cameraSource = snap.feed === 'relay' ? 'relay' : 'device';
  }
  // The overlay's start is the operator's action for the bus: a deck key may start a session the
  // operator has just opened this page for, and may never open a camera on its own. The synthetic
  // rig is not a start — it runs from load and must not arm the bus.
  if (snap.state === 'running' && snap.source === 'camera') noteStartClick();
  if (snap.state === 'error') {
    state.camera = /denied/i.test(snap.error || '') ? 'denied' : 'error';
    state.error = snap.error;
    // The page's own record of the failure, straight from the tracker's stage and the error name.
    setCameraError(snap.failStage || 'getUserMedia', snap.errorName || 'Error', snap.error);
    setBanner(snap.error, 'bad');
  } else if (snap.state === 'running') {
    state.camera = 'on';
    // A camera track is running: the failure reason is history, and this is the device.
    if (snap.source === 'camera') {
      state.cameraError = null;
      state.error = null;
      if (snap.deviceLabel) state.cameraLabel = snap.deviceLabel;
      setBanner('');
    }
  }
  if (snap.state === 'running' && snap.source === 'camera') camWasLive = true;
  else if (snap.state === 'error' || snap.state === 'idle') {
    if (userStopped || !fx.view) state.anchors = 'none';
    // A camera that failed or ended hands the page back to the synthetic rig.
    if (camWasLive || (snap.state === 'error' && camAttempted)) {
      camWasLive = false;
      camAttempted = false;
      fallBackToSynthetic();
    }
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
    const want = GESTURE_EFFECTS[fired.fire];
    if (want === 'next') {
      stepEffect(1);
      renderState();
    }
  }

  // Every pose feeds the effect it belongs to; the classifier's gesture *is* the beat. The cursor
  // (`effect.next` / `effect.prev`) is the list position a deck key steps, and the badge says so.
  // Embers are ambience, not a beat: any hand present keeps a rising ember field alive.
  // The anchors come first: a gesture that fires `shoot` spawns its burst from them.
  const anchors = anchorsFrom(result.hands);
  if (swipe && swipe.speed > 0.5 && anchors.anchor) anchors.swipe = { ...anchors.anchor, radius: 0.18 };
  fx.view = anchors;
  // `camera` only while a camera track is actually live; every other frame is the synthetic rig.
  state.anchors = frame.source === 'camera' && tracker.state === 'running' && tracker.source === 'camera' ? 'camera' : 'synthetic';
  if (hands.length && effectiveEffects().includes('embers') && !fx.live.has('embers') && result.gesture) {
    fx.trigger('embers', {});
  }
  // A gesture beats one effect. The cursor's effect wins when the gesture owns it (that is how the
  // operator keeps a whole list reachable with eight gestures); otherwise the first enabled effect
  // the gesture owns draws — the shipped "palm up → fireball when it is on" behaviour. The gate
  // insists on a fresh fire, so a held gesture beats once, never every frame.
  const cursorId = currentEffect();
  const own = fired.fire ? GESTURE_EFFECTS[fired.fire] : null;
  const beat =
    Array.isArray(own) && own.length
      ? effectiveEffects().includes(cursorId) && own.includes(cursorId)
        ? cursorId
        : own.find((x) => effectiveEffects().includes(x))
      : null;
  if (beat) {
    if (beat === 'shoot') spawnShoot(anchors);
    else fx.trigger(beat, {});
  }
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
  // This frame is already the newest picture on `tracker.frameSurface()`, and `onFrame` is called
  // by the stream reader (relay.js `drain`) or the tracker, not by the paint loop — so publish
  // from here too. Rate-limited inside the publisher: one clock, one request in flight, newest
  // frame wins, and a kick during a live timer posts nothing extra.
  publisher.kick();
}

/** `shoot`: the projectile skin's burst from the pointing hand (or the palm, if only that is
 *  known). No hand is no shot — the renderer never invents a position. */
function spawnShoot(anchors) {
  const a = anchors && (anchors.anchor || anchors.front);
  if (!a) {
    setBanner('shoot: no hand to fire from', 'warn');
    return 0;
  }
  const skin = state.settings?.skins?.shoot;
  const n = fx.spawnBurst('shoot', a, null, skin === 'heart' ? 10 : 18);
  // The effect is "live" for as long as its particles are: triggering the id keeps the pane's
  // live marker honest and lets the renderer's own layer loop draw the batch.
  if (n && effectiveEffects().includes('shoot') && !fx.live.has('shoot')) fx.trigger('shoot', { centre: a });
  return n;
}

/* ---------------------------------------------------------------- hand edit */

/** Strokes land only when the edit effect is drawn AND live, so a stray click never marks. */
function drawWants() {
  return fx.live.has('edit') && effectiveEffects().includes('edit');
}

/** Is a stroke in progress? The renderer's pointer record is the one truth. */
function drawing() {
  return Boolean(fx.editPointer);
}

function canvasPoint(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / Math.max(1, r.width), y: (ev.clientY - r.top) / Math.max(1, r.height) };
}

// Pointer strokes: only while the edit effect is live, so a stray click on the overlay never
// leaves a mark. Coordinates are page space (the renderer mirrors for itself).
canvas.addEventListener('pointerdown', (ev) => {
  if (!drawWants()) return;
  const p = canvasPoint(ev);
  fx.editBegin(p.x, p.y);
  canvas.setPointerCapture?.(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (!drawWants() || !drawing()) return;
  const p = canvasPoint(ev);
  fx.editMove(p.x, p.y);
});
canvas.addEventListener('pointerup', () => {
  if (!drawWants()) return;
  fx.editEnd();
});
canvas.addEventListener('pointercancel', () => {
  if (drawing()) fx.editEnd();
});

/* ---------------------------------------------------------------- body mask channel */

// The body page (pages/body.html) runs pose + segmentation in its own small OBS source and posts
// one ImageBitmap of the mask per sample on this channel. Nothing crosses HTTP: the bitmap is a
// transferable in-process object, and the page keeps no copy.
const bodyChannel = 'BroadcastChannel' in window ? new BroadcastChannel('handfx.body') : null;

function bodyAlive(now = performance.now()) {
  return state.bodySeen && now - state.bodyAt < 1000;
}

function releaseBodyEffects() {
  for (const id of ['bodyonfire', 'bodysmoke', 'frozenbody']) fx.release(id);
}

if (bodyChannel) {
  bodyChannel.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'mask' && msg.bitmap) {
      const ok = fx.setBodyMask(msg.bitmap);
      // Closing the bitmap is the receiver's job once it is uploaded.
      if (typeof msg.bitmap.close === 'function') msg.bitmap.close();
      if (ok) {
        state.bodyAt = performance.now();
        if (!state.bodySeen) setBanner('');
        state.bodySeen = true;
      }
      return;
    }
    if (msg.type === 'status') {
      state.bodyPage = msg;
    }
  };
  // The page's camera stops (tab closed, camera released): the mask stops arriving on its own,
  // the 1 s expiry below is the only needed contract.
  bodyChannel.postMessage({ type: 'hello' });
}

function tickBody() {
  const now = performance.now();
  if (state.bodySeen && now - state.bodyAt >= 1000) {
    state.bodySeen = false;
    releaseBodyEffects();
    setBanner('body mask stopped arriving (overlay: >1 s) — body effects off', 'warn');
  }
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
      // Why the camera did not open (object or null) and the label it did open (string or null).
      cameraError: state.cameraError,
      cameraLabel: state.cameraLabel,
      // Which pipe is carrying the frames (relay | device | synthetic | none) and why the relay is
      // not it (string or null). Both are status, not frame data.
      cameraSource: state.cameraSource,
      relayError: state.relayError,
      // The mask's receipt time, so the server's status can say "mask arriving" without a frame
      // ever leaving this page. `body` also lets the pane name the body effects honestly.
      maskAt: state.bodySeen ? state.bodyAt : 0,
      body: state.bodySeen,
      // The draw truth: how many frames the loop has rendered, where its anchors came from, and
      // when the last one landed. Counters only — still no frame and no landmark leaves the page.
      draws: state.draws,
      anchors: state.anchors,
      lastDrawAt: state.lastDrawAt,
      // Where a slow publish frame goes: compose, readback, NV12 conversion, upload. Numbers only.
      publishTiming: publisher.timing(),
    }),
  })
    .then((res) => {
      // A failed ack is not page state, but a successful one is the liveness proof the watchdog
      // waits for: no ack for 5 s means this page's own connection is gone.
      if (res.ok) watchdog.ok();
    })
    .catch(() => {});
}

let statePaint = 0;
function renderState(now = performance.now()) {
  if (now - statePaint < 100 && state.tracking) return;
  statePaint = now;
  const bits = [];
  if (state.settings?.enabled === false) bits.push('effects off');
  if (state.synthetic) bits.push('SYNTHETIC replay — no camera, not tracking');
  else if (state.tracking) bits.push(`tracking${state.cameraSource === 'relay' ? ' · relay' : ''} · ${state.hands} hand${state.hands === 1 ? '' : 's'}`);
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
  document.body.dataset.source = state.cameraSource;
  document.body.dataset.underlay = state.underlay ? 'on' : 'off';
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

let bodyTickAt = 0;
function loop(now) {
  // One frame may fail (a GL hiccup, a body bitmap, a broken effect); the loop may not. The frame
  // is what the page has instead of a sign of life, so the next one is always scheduled, and the
  // throw still reaches the console instead of being swallowed here.
  try {
    // The body mask expires 1 s after its last message; checked twice a second, not per frame.
    if (now - bodyTickAt > 500) {
      bodyTickAt = now;
      tickBody();
    }
    // The camera picture under the effects: the same surface the tracker is reading (the relay's
    // frame canvas or the device's video element), so underlay never adds a second decode. Painted
    // even when the effects are off: the underlay is the camera, not an effect.
    if (state.underlay && state.tracking && !state.synthetic && tracker.state === 'running') {
      paintUnderlay(tracker.frameSurface());
    }
    if (state.settings && state.settings.enabled !== false && state.settings.obsHandFx !== false) {
      // Body effects have no hand gesture of their own: while a mask keeps arriving (the body page
      // sees something and the channel is up), each enabled body effect stays alive, so a mask
      // that goes quiet releases them through the expiry above.
      if (state.bodySeen) {
        for (const id of ['bodyonfire', 'bodysmoke', 'frozenbody']) {
          const live = fx.live.get(id);
          if (effectiveEffects().includes(id) && (!live || !live.active || live.age > 6)) fx.trigger(id, {});
        }
      }
      fx.render(now, fx.view || {});
      // What actually reached the canvas: one count per render pass, and when. The pane and a
      // `curl /status` read these back through /ack instead of assuming the picture is alive.
      if (fx.supported) {
        state.draws += 1;
        state.lastDrawAt = Date.now();
      }
    }
    // Publishing is not on this clock. The publisher owns a `setInterval` at the pipe's frame rate
    // (publish.js `arm`) and is kicked by frame arrival (`onFrame`), because this loop only runs
    // while the page paints: in a hidden or paused OBS source the loop stops dead while the camera
    // stream keeps arriving, which froze `publish` at 2402 frames with `stage: "waiting"`.
    // The draw truth rides the render loop, not the tracker's frame callback. On the device path
    // `onFrame` was driven by this page's own rAF, so its `/ack` beat came free; a relayed frame
    // instead arrives from the stream reader (relay.js `drain`), and a reader that stalls (or a
    // throw inside `onFrame` before its own ack) left the loop drawing and counting while
    // `/ack` went quiet, so `/status` showed a frozen `draws` next to a live `publish`. The loop
    // is what counts draws, so the loop reports them; ack() still throttles to 2/s.
    ack(now);
  } finally {
    requestAnimationFrame(loop);
  }
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
  let heard = false;
  try {
    const status = await loadStatus();
    applySettings(status);
    heard = true;
    if (!status.runtime || !status.runtime.vendored) setBanner('MediaPipe runtime is not vendored — run the vendor copy step (modules/handfx/vendor/README.md).', 'bad');
  } catch (err) {
    setBanner(`Cannot read /api/handfx/status: ${err.message}`, 'bad');
  }
  connectBus();
  // The page has just heard from the server: the watchdog starts healthy rather than counting a
  // stale 0 as a failed connection in its first second. A page whose boot could not reach the
  // server is left stale on purpose, so the first tick starts recovering.
  if (heard) watchdog.ok();
  renderState();
  // Never a blank page, not even for one frame: unless the mode is camera-only, the synthetic rig
  // draws now and the camera attempt replaces it the moment a real track runs (onTrackerState →
  // running, source camera). In `synthetic` the camera is never asked for at all.
  ensureSyntheticAnchors();
  requestAnimationFrame(loop);
  // The load attempt, without a gesture: an OBS browser source is never clicked, so a camera only
  // opens here if this page asks for it itself (`auto` and `camera`; `synthetic` skips it).
  autoCamera().catch(() => {});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      autoCamera().catch(() => {});
      void watchdog.tick();
    }
  });
  booted = true;
  // Test hook: the browser test drives the page through this, not through the DOM.
  window.__handfx = {
    state,
    fx,
    tracker,
    relay,
    classify,
    syntheticHands,
    stepEffect,
    // The page's own settings entry point (status shape in, settings applied), so a test or the
    // pane's console can change the effect list the way the server would.
    applySettings,
    startTracking,
    stopTracking,
    applyBusCommand,
    currentEffect,
    effectiveEffects,
    EFFECT_ORDER,
    spawnShoot,
    bodyAlive,
    // Body-mask status for the pane/test: whether a mask arrived in the last second.
    body: () => ({ seen: state.bodySeen, at: state.bodyAt }),
    isLive: () => fx.live.size > 0,
    liveIds: () => [...fx.live.keys()],
    ready: Boolean(fx.supported),
  };
})();
