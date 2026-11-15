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

import { Tracker, modelSourceFor, syntheticHands } from '../engine/tracker.js';
import { createPublisher } from './publish.js';
import { createRelay } from './relay.js';
import { cameraWanted, rearmCamera } from './rearm.js';
import { createWatchdog } from './watchdog.js';
import { createBuildCheck } from './build-check.js';
import {
  classify,
  dedupeHands,
  Motion,
  GestureGate,
  palmFacing,
  palmFacingSigned,
  facingCorrected,
  palmNormal,
  palmArea,
  aimVector,
  Thrust,
  THRUST_RATE,
  THRUST_FRAMES,
  THRUST_WINDOW,
  THRUST_COOLDOWN_MS,
  THRUST_FACING_MIN,
} from '../engine/gestures.js';
import { FxRenderer, EFFECTS, anchorsFrom, fenceRectFor } from '../engine/fx.js';

/**
 * `?preview=1` is the pane's live preview (public/src/preview.js appends it). A preview is a
 * viewer, not a source: it must never POST /ack, never report draws and never claim the OBS role —
 * otherwise a dead OBS source looks alive because the pane's iframe is painting. It runs the
 * synthetic rig locally, so the effects are visible.
 */
const PREVIEW = new URLSearchParams(location.search).get('preview') === '1';
/**
 * `?preview=1&camera=1` is the pane's camera preview: the operator watching themselves and
 * confirming tracking is live. Still a preview (no ack, no beat, no OBS role, no reload loop) but
 * it acquires like a normal page — relay, tracker, and the camera underlay under the effects.
 * Keyed on `preview` too, so the OBS document can never reach it: the OBS source paints effects
 * only, never camera pixels.
 */
const CAMERA_PREVIEW = PREVIEW && new URLSearchParams(location.search).get('camera') === '1';
/** May this document open the camera, the relay and the tracker at all? */
const canAcquire = !PREVIEW || CAMERA_PREVIEW;
/**
 * Which document this is, for the server's supersede rule (core/events.mjs `attach`, and the
 * camera relay's `addClient`): one path, one holder. A reload boots a *new* document at the same
 * path, so the server can end the predecessor's two long-lived responses — the bus and the camera
 * stream — instead of letting them keep two of the browser's six sockets to this origin, which is
 * what starves the successor's acks (`ack request: signal timed out` with six sockets held).
 * The path is used rather than a fresh clientId because a clientId is new on every load and could
 * never match a predecessor. A plain preview opens neither stream, so its role never matters; a
 * preview with `?camera=1` does open the camera stream, and must not claim the OBS source's role —
 * the relay ends the older client of a role, so sharing it would kill the source's feed every time
 * the pane toggled its underlay.
 */
const ROLE = PREVIEW ? `${location.pathname}/preview` : location.pathname;
/** The bundle this document was loaded from: the `?v=` the page loader put on this module's URL. */
const BUILD = new URL(import.meta.url).searchParams.get('v') || 'unknown';

/**
 * The bootstrap diagnostics installed by `overlay.html`'s inline script, which runs before this
 * module is even fetched. Every call is a no-op if that script was stripped (e.g. a hand-edited
 * page), so instrumentation can never be the reason the overlay fails.
 */
// Every method this module calls on it, not just `phase`: the predicate used to test `phase` alone
// and the loop then called `phaseList()` on its first frame, so a partial shim — exactly what a
// harness injects — was selected and threw on tick 1. `clientId` is a property, not a method.
const DIAG_METHODS = ['phase', 'phaseList', 'report', 'setBuild', 'setClient'];
const diag = self.__handfxDiag && DIAG_METHODS.every((m) => typeof self.__handfxDiag[m] === 'function')
  ? self.__handfxDiag
  : { phase() {}, report() {}, setBuild() {}, setClient() {}, phaseList() { return []; }, clientId: '' };
/**
 * Record a caught error on the page's own event ring — the boot-step/ack-body/boot-throw kinds that
 * used to be swallowed by an empty `.catch(() => {})`. Never throws: a report that becomes the
 * failure it reports is worse than no report. `note` names the call site.
 */
function diagError(kind, err, note) {
  try {
    const message = `${note ? `${note}: ` : ''}${(err && err.message) || String(err)}`;
    diag.report(kind, message.slice(0, 500), { stack: err && err.stack ? String(err.stack) : '' });
  } catch {
    /* diagnostics must never become the failure they report */
  }
}
// First breadcrumb: the module parsed and its imports resolved. If an import had failed, this line
// would never run and the inline script would have reported the resource instead.
diag.phase('module-start');

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
  // The default document: enabled, no effects, no publisher. A boot whose /status read fails keeps
  // this, so the loop's own gate (`enabled !== false`) is open and the page still draws.
  settings: { enabled: true },
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
  // Diagnostics that threw and were swallowed. A broken or partial shim counts here instead of
  // reaching the loop: the readout and the phase() breadcrumbs are narration, never the picture.
  diagFails: 0,
  // performance.now() of the newest tracker frame. A tracking claim without one is stale: the relay
  // reports `running/camera` before its first frame arrives.
  lastFrameAt: 0,
  // The paint clock, reported beside `draws`: a monotonic tick count and its wall-clock stamp.
  // They are what lets /status tell "page alive, loop stopped" from "page gone" — the two used to
  // look identical because the loop also carried the ack.
  loopTicks: 0,
  lastLoopAt: 0,
  // When the last /ack was *sent* (performance.now): the 2/s throttle reads this, not success.
  lastAck: 0,
  // When the server last *answered* an /ack (Date.now), and the acks that failed or timed out
  // since: the ack-failure wedge condition reads these, so a page the server cannot hear still
  // looks different from a page whose loop has stopped.
  ackOkAt: 0,
  ackFails: 0,
  ackFailAt: 0,
  // When this document first decoded a relay frame. A document that got this far has already
  // proven it can reach the server, so a wedge must never replace it: the reload opens a third
  // long-lived stream instead of freeing a socket (rig 03:06:56).
  relayAttachedAt: 0,
  startedAt: Date.now(),
  bodyAt: 0, // last body-mask message (performance.now)
  bodySeen: false,
  status: null, // last /api/handfx/status read (the body page's model facts)
};

const fx = new FxRenderer(canvas, { onError: (msg) => setBanner(`Effects unavailable: ${msg}`, 'bad') });
const tracker = new Tracker({
  onFrame: onFrame,
  onState: onTrackerState,
  // Model load retries belong in the page-event stream, not only in the console: the page that
  // recovered from a deploy-time 500 is otherwise indistinguishable from one that never failed.
  log: (msg) => reportRelayEvent('model', msg),
});
// The relayed camera: the server's ffmpeg feed of the WebcamSwitcher virtual camera. The page
// cannot open that device itself (WebcamSwitcher holds it), so it reads the MJPEG stream instead
// and feeds each decoded frame to the tracker's own detect path.
const relayEventQueue = [];
let relayEventTimer = 0;

/**
 * One line per relay transition, batched. A transition burst (a cap close plus its re-open) used
 * to be five POSTs landing exactly when the ack needed its socket; now it is one. `/events` is
 * server-to-page only, so the ledger cannot ride it without adding a client-to-server route.
 * Fire and forget: never awaited, never able to throw.
 */
function reportRelayEvent(transition, detail = '') {
  try {
    relayEventQueue.push({
      kind: 'relay',
      phase: String(transition || 'note').slice(0, 40),
      message: String(detail || '').slice(0, 300),
      build: BUILD,
      t: Date.now(),
    });
    if (relayEventTimer) return;
    relayEventTimer = setTimeout(() => {
      relayEventTimer = 0;
      if (!relayEventQueue.length) return;
      const events = relayEventQueue.splice(0, relayEventQueue.length);
      try {
        void fetch('/api/handfx/page-event', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: diag.clientId || '', build: BUILD, events }),
        }).catch(() => {});
      } catch {
        /* a report must never break the stream it describes */
      }
    }, 150);
    relayEventTimer.unref?.();
  } catch {
    /* a report must never break the stream it describes */
  }
}

/**
 * The camera→synthetic fallback is a transition, and it used to leave no trace: a 20-minute outage
 * read as a healthy page because only the state was reported, never the change. One line per
 * crossing, through the same page-event path as the relay's own notes, naming the reason and how
 * old the last real frame was at the moment it happened — never per frame.
 */
let notedSource = null;
function noteSource(source, reason) {
  if (source === notedSource) return;
  const from = notedSource || 'none';
  notedSource = source;
  const age = state.lastFrameAt ? `${Math.round(performance.now() - state.lastFrameAt)} ms` : 'never';
  reportRelayEvent('source', `${from} -> ${source} (${reason || 'unspecified'}), last frame ${age} old`);
}

/**
 * Ack and beat live on a worker thread with their own timer. The render loop decodes 30 JPEG
 * frames a second, and a main thread blocked by that work used to take liveness down with it: the
 * server saw a silent page while frames were flowing. The worker carries the last payload the page
 * handed it and posts on its own clock, so a blocked loop reads as "ack fresh, draws stale" in the
 * server's truth table instead of as a dead page. The inline fetch below stays as the fallback.
 */
let ackWorker = null;
try {
  if (!PREVIEW && typeof Worker === 'function') {
    ackWorker = new Worker(new URL('./ack-worker.js', import.meta.url));
    ackWorker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ack-ok') {
        state.ackOkAt = Date.now();
        state.ackFails = 0;
        watchdog.ok();
        diag.phase('first-ack');
        return;
      }
      if (msg.type === 'ack-fail') ackFailed();
    };
    ackWorker.onerror = () => {
      ackWorker = null;
    };
  }
} catch (err) {
  ackWorker = null;
  diagError('boot-step', err, 'ack worker');
}

const relay = createRelay({
  // `?role=` on the stream too, so a predecessor's leaked stream is ended when this one attaches.
  url: `/api/handfx/camera/stream?role=${encodeURIComponent(ROLE)}&clientId=${encodeURIComponent(diag.clientId || '')}`,
  onEvent: reportRelayEvent,
  onFrame: (bitmap) => tracker.pushFrame(bitmap),
  onState: (s) => {
    state.relayError = s.error || null;
    renderState();
    if (s.state === 'live') {
      // Frames are flowing: the backoff starts over, so the next drop retries after 2 s.
      cameraLive();
      state.relayAttachedAt = Date.now();
      diag.phase('relay-attached');
      return;
    }
    if (s.state !== 'error' || state.cameraSource !== 'relay') return;
    // An established stream died (EOF, a read error, or 3 s without a frame). Hand the view back the
    // way a track ending does — tracker to idle, then fallBackToSynthetic — and re-enter the same
    // bounded retry the load path uses. The relay serves a fresh `GET /camera/stream` every time, so
    // a dead feed is a retry, not a dead page. `anchors` is cleared because the render loop only
    // rewrites it when a frame arrives, so a dead feed would otherwise keep reporting `camera`.
    state.cameraSource = 'none';
    state.tracking = false; // the track is gone; the fallback below may claim the view again
    tracker.stop();
    state.anchors = 'none';
    scheduleCameraRetry(s.error || 'relay: stream ended');
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

// A beat effect lives exactly as long as the gesture that fired it. Hands leaving is unambiguous
// (the classifier cannot re-fire a gesture while they are gone), so release at once; a gesture
// *change* with a hand still present waits `BEAT_LINGER_MS`, so one misclassified frame does not
// blink the effect off. `started` is every effect a beat has spawned, so a hand loss retires all
// of them, not only the newest.
const BEAT_LINGER_MS = 200;
const beatFx = { id: null, gesture: null, until: 0, started: new Set() };

// Ambience differs from a beat: `wires` is armed by presence alone, so losing the hand only has to
// outlast a detection dropout. The 121 s capture had 15 single-sample dropouts (7 pure misses, 8
// isolated one-frame glimpses), each long enough to start a half-second fade that the next frame
// could not cancel. Release deadline: 0 means "no release pending".
const WIRES_GRACE_MS = 200;
let wiresGoneAt = 0;

function releaseBeat(id) {
  if (!id) return;
  if (fx.live.has(id)) fx.release(id);
  beatFx.started.delete(id);
  if (beatFx.id === id) {
    beatFx.id = null;
    beatFx.gesture = null;
    beatFx.until = 0;
  }
}

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

/** Record why a camera acquisition failed. `stage` is getUserMedia | track | timeout | exclusive,
 *  or `start` for a wrapper that caught a rejection with no stage of its own. */
function setCameraError(stage, name, message) {
  state.cameraError = {
    at: Date.now(),
    stage,
    name: String(name || '').slice(0, 60),
    message: String(message || '').slice(0, 240),
  };
}

/* ---------------------------------------------------------------- settings + bus */

/** One /status read at a time, and each is bounded: it is awaited by the boot, the watchdog's
 *  probe and recovery, so a read that never settles would freeze all three. */
let statusInFlight = null;
const STATUS_TIMEOUT_MS = 8000;
/** The boot's own read. It races the first frame, so it is bounded to a time no compositor frame
 *  can notice: a status that lands later is worthless, because the loop must already be drawing. */
const BOOT_STATUS_MS = 1500;

async function loadStatus(timeoutMs = STATUS_TIMEOUT_MS) {
  if (statusInFlight) return statusInFlight;
  statusInFlight = (async () => {
    try {
      const res = await fetch('/api/handfx/status', {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } finally {
      statusInFlight = null;
    }
  })();
  return statusInFlight;
}

/**
 * The stage the server resolved for this page: `default` has already followed the global wall
 * ratio there, so `status.settings.ratio` is either a bare string or `{value, effective}`. Absent
 * (an old status document or a bare test harness) means no fence, never a guessed portrait wall.
 */
function ratioOf(status) {
  const doc = status && status.settings && status.settings.ratio;
  if (typeof doc === 'string') return doc;
  if (doc && typeof doc === 'object') return doc.effective || doc.value || 'default';
  return 'default';
}

function applySettings(status = {}) {  // Values may arrive bare (the test and the pane's console hand in plain values) or wrapped as
  // `{ value }` (what server.js serves from settings.describe()). Both are the same document.
  // No document at all is the default document: enabled, no effects, no publisher.
  status = status || {};
  const s = {};
  for (const [k, d] of Object.entries(status.settings || {})) s[k] = d && typeof d === 'object' && 'value' in d ? d.value : d;
  const prevSource = state.trackingSource;
  state.settings = s;
  state.status = status;
  state.trackingSource = s.trackingSource === 'camera' || s.trackingSource === 'synthetic' ? s.trackingSource : 'auto';
  // The OBS document paints effects only; camera pixels belong to the pane's own camera preview.
  // `underlay` as a setting is retired and deliberately not consulted.
  state.underlay = CAMERA_PREVIEW;
  fx.setSettings({
    effects: s.effects && s.effects.length ? s.effects : [],
    intensity: s.intensity || {},
    skins: s.skins && typeof s.skins === 'object' ? s.skins : {},
    bufferScroll: s.bufferScroll ?? 0.35,
    mirror: s.mirror !== false,
    debugOverlay: s.debugOverlay === true,
    enabled: s.enabled !== false && s.obsHandFx !== false,
    // The stage the particles are fenced to. Resolved server-side (`default` already followed the
    // global ratio), so the page never has to guess what `default` means right now.
    ratio: ratioOf(status),
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
  // this page whether to feed it. A preview is not the source, so it never feeds the pipe.
  publisher.fromStatus(PREVIEW ? null : status);
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
  clearCameraRetry();
  autoCam.attempts = 0;
  if (state.trackingSource !== 'camera') ensureSyntheticAnchors();
  else ack();
  if (state.trackingSource !== 'synthetic') autoCamera().catch((err) => diagError('boot-step', err, 'autoCamera (source switch)'));
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
  // `paintUnderlay` only runs when this page paints the camera, so this is `mirrorRule().on`:
  // the camera draw and the landmarks are mirrored by the same answer.
  if (mirrorRule().on) {
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
  if (cmd === 'diag.start') {
    // A capture arms the overlay it is measuring. No reload: the source keeps drawing the same
    // picture while the samples flow.
    diagStart(msg.args && msg.args.seconds);
  } else if (cmd === 'diag.stop') {
    diagStop('cmd');
  } else if (cmd === 'effect.next' || cmd === 'effect.prev') {
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
  } else if (cmd === 'tracking.set' || cmd === 'tracking.toggle') {
    // One verb for the pane's three controls (camera, synthetic, off); `tracking.toggle` is the deck
    // key's one-button form and keeps its own rule. Both are acted on in *this* document, so the
    // OBS source is the only page a command can reach: the pane's preview opens no bus at all.
    const mode = cmd === 'tracking.toggle' ? 'toggle' : msg.args && msg.args.mode;
    if (!applyTrackingMode(mode)) setBanner(`Unknown tracking mode: ${String(mode)}`, 'warn');
    renderState();
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
    // A deploy's push (`POST /api/handfx/page/reload`), over the bus this page already holds.
    camLog('page reload: reason=pushed');
    location.reload();
  }
}

let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadStatus().then(applySettings).catch((err) => diagError('boot-step', err, 'refresh status'));
  }, 120);
}

function connectBus() {
  // `?role=` names this document to the server, which ends any older bus of the same role before
  // serving this one (see ROLE above). No new parameter for OBS to carry: it is this page's own path.
  // `clientId` is the same identity the /ack POST carries, so the server can tie this socket to a
  // client and reap it when that client is superseded instead of waiting out the age cap.
  const es = new EventSource(`/events?${new URLSearchParams({ role: ROLE, clientId: CLIENT_ID })}`);
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
    // that a machine has no camera at all must run again from zero, and the next attempt is now.
    clearCameraRetry();
    autoCam.attempts = 0;
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

/* ---------------------------------------------------------------- wedge watchdog */

/**
 * A page whose document Chrome has stopped compositing answers nothing and never recovers by
 * itself — that is the sixteen-hour inert overlay. Timers still run in that state (measured here:
 * rAF +0 in 3 s while setInterval advanced), so the last thing left is to restart the document.
 *
 * The trigger is the *loop* being stalled, not the picture being still: `loop()` stamps
 * `lastLoopAt` on every rAF tick whether or not a frame moves, so a static scene — a hand held
 * still, effects off, a frozen prediction — never trips this. A hidden document is a legitimate
 * pause, not a wedge, and is skipped.
 */
const WEDGE_MS = 15000;
const RELOAD_GAP_MS = 5 * 60 * 1000;
const RELOAD_KEY = 'handfx.selfReloadAt';
let reloadedThisPage = false;

/** The last self-reload, from sessionStorage when it is usable, else this page's own memory. */
function lastSelfReloadAt() {
  try {
    return Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {
    // No storage: the only memory left is this document, so at most one reload per page life.
    return reloadedThisPage ? Date.now() : 0;
  }
}

/**
 * Reload at most once per 5 minutes, so a page that wedges on boot cannot become a reload loop.
 * `reason` is a machine token (`ack-wedge`, `loop-wedge`) and `detail` the human clause, so the one
 * line written here says which actor fired without a code read — the thing the 03:2x probe could
 * not tell apart (a 25 s build poll and a 12 s ack wedge both looked like one 26 s clock).
 */
function selfReload(reason, detail = '', freeSockets = false) {
  const now = Date.now();
  const last = lastSelfReloadAt();
  if (last && now - last < RELOAD_GAP_MS) return false;
  reloadedThisPage = true;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    /* the in-memory flag above is the fallback */
  }
  camLog(`page reload: reason=${reason}${detail ? ` (${detail})` : ''}`);
  // A network wedge reloads into a document that would otherwise compete with the dead sockets
  // for the browser's six-per-origin budget: drop them first.
  if (freeSockets) releaseSockets();
  location.reload();
  return true;
}

/**
 * Close the two long-lived sockets — the bus EventSource and the relay's camera stream — so the
 * document being abandoned is not holding connections the new one needs.
 */
function releaseSockets() {
  try {
    bus?.close();
  } catch {
    /* already closed */
  }
  bus = null;
  try {
    // A relay built by an older bundle may not expose `stop`: a missing method is not a fault.
    // `forget: false` is the whole point: this teardown closes the socket, it does not decide the
    // page has finished with the camera. `stop()`'s default erases the relay's `wanted` flag, and
    // `wanted` is what every re-open path tests (relay.js `read`'s EOF branch, `visibilitychange`,
    // `pageshow`) — so forgetting here left the feed dead for the rest of the document's life the
    // first time an OBS browser source fired `pagehide`. relay.js's own pagehide listener has
    // always passed `forget: false` for exactly this reason.
    if (typeof relay?.stop === 'function') relay.stop({ forget: false, why: 'release-sockets' });
  } catch {
    /* already stopped */
  }
}

/* ---------------------------------------------------------------- build self-heal */

/**
 * The bundle this document runs is fixed at boot. A deploy changes `/api/handfx/build`, and
 * nothing used to tell the running document, so it kept the old bundle until a human pressed
 * Refresh in OBS — 20 minutes of synthetic frames that every status field called healthy.
 *
 * This is the missing loop. A cheap fetch of the build (no new socket; the 6-per-origin budget is
 * hard), once per BUILD_POLL_MS while the document is visible, and a self-reload on a mismatch.
 * `createBuildCheck` owns the budget: three reloads per observed server build, persisted across
 * the reload it causes, then it stops and the page reports `staleSince` instead of spinning.
 */
const BUILD_POLL_MS = 25000;
const buildCheck = createBuildCheck({
  ownBuild: BUILD,
  storage: (() => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  })(),
  reload: () => {
    camLog('page reload: reason=build-stale');
    location.reload();
  },
});
let lastBuildPollAt = 0;

/** Poll gently: the build is only read, so this costs one small GET per 25 s, never a socket. */
async function pollBuild(now) {
  if (now - lastBuildPollAt < BUILD_POLL_MS) return;
  lastBuildPollAt = now;
  const res = await fetch('/api/handfx/build', { cache: 'no-store', signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!res || !res.ok) return; // a build we could not read is not a mismatch
  const body = await res.json().catch(() => null);
  const verdict = buildCheck.observe(body && body.build);
  if (verdict === 'stop') {
    const s = buildCheck.state();
    setBanner(`stale bundle ${BUILD} — server serves ${s.observed}; reload this browser source`, 'bad');
  }
}

/** Acks attempted, none answered, for this long: the page is alive and its network is not. */
const ACK_WEDGE_MS = 12000;
/** A timeout is a failure, not a success: an ack can never outlive its own beat. */
const ACK_TIMEOUT_MS = 4000;
/** A closed gate with no failed request to explain it is a fault after two timeouts. */
const ACK_GATE_MS = ACK_TIMEOUT_MS * 2;

/**
 * The gate must never be the reason the page is silent. `ackInFlight` has no owner and no clock: a
 * request that is never retired, or a body build that threw before `fetch` existed, would hold it
 * forever and every later tick would return at the gate without a word. This is the belt to
 * `ack()`'s braces — after two timeouts with no failed request behind the wait, the latch is
 * reported and released, so the class cannot recur as silence.
 */
function checkAckGate(now) {
  if (!ackInFlight || !ackLatchedAt) return false;
  // A request that is genuinely failing owns the slot until its own `.finally`; `ackFails` resets
  // to 0 only on a successful ack, so a latch held with zero failures has no request behind it.
  if (state.ackFails !== 0) return false;
  if (now - ackLatchedAt < ACK_GATE_MS) return false;
  const heldMs = now - ackLatchedAt;
  ackInFlight = false;
  ackLatchedAt = 0;
  diagError('ack-gate-latched', new Error(`ackInFlight held ${Math.round(heldMs / 1000)}s with ackFails=0`), 'ack gate');
  return true;
}

function checkWedge(now) {
  // Hidden is a paused document, not a wedged one: OBS reports a source that is not in the program
  // as hidden, and reloading it there would fight the source instead of healing it.
  if (document.visibilityState === 'hidden') return false;

  // Condition 1: the document is not being composited. `lastLoopAt === 0` means the boot has not
  // reached loop-start yet — a slow boot, not a stopped loop. Reading `startedAt` as the loop's
  // clock made every boot longer than WEDGE_MS reload itself before it could finish (a status read
  // that waits on a socket takes exactly that long).
  if (state.lastLoopAt && now - state.lastLoopAt >= WEDGE_MS) {
    return selfReload('loop-wedge', `loop stopped for ${Math.round((now - state.lastLoopAt) / 1000)}s`);
  }

  // Condition 2, independent of the loop: it keeps ticking at full rate through a dead network,
  // so only the acks can see this fault. Acks are still being attempted when a failure landed
  // within the last two timeouts, and none succeeded for ACK_WEDGE_MS.
  //
  // Never for a document that attached the relay: it reached the server already, and reloading it
  // opens a third long-lived stream instead of freeing one (rig 03:06:56). The connection watchdog
  // re-arms that document without a navigation. And never before the first ack was tried: with no
  // attempt, `sinceOk` is measured from `startedAt`, so the condition would be "expired" the
  // instant the boot finally sent one.
  if (state.ackFails > 0 && !state.relayAttachedAt && !recovering) {
    const sinceOk = now - (state.ackOkAt || state.startedAt);
    const stillTrying = now - state.ackFailAt <= ACK_TIMEOUT_MS * 2;
    if (sinceOk >= ACK_WEDGE_MS && stillTrying) {
      return selfReload('ack-wedge', `acks failing for ${Math.round(sinceOk / 1000)}s`, true);
    }
  }
  return false;
}

/** The 1 s liveness beat. A hidden source has nothing to recover (its render loop is paused, so
 *  its acks stop too) and a tab coming back fires `visibilitychange`, which re-runs autoCamera. */
let booted = false;
setInterval(() => {
  if (PREVIEW) return;
  if (document.visibilityState === 'hidden') return;
  // One failing tick loses that tick and every check after it in the same body, and the reason with
  // them. The interval survives either way, so the catch is here to keep the four checks independent
  // of each other and to leave a line behind when one of them throws.
  try {
    // Not gated on `booted`: a boot that hangs on `loadStatus` (a server that is gone, a fetch that
    // never resolves) would otherwise freeze the page before its own recovery could start.
    void watchdog.tick();
    // A latch nobody is serving is reported and released before it can look like a dead network.
    checkAckGate(Date.now());
    // /ack keeps running on its own timer while the loop is dead, so the connection watchdog would
    // report a page that is "alive" and doing nothing. This is the check for that state.
    checkWedge(Date.now());
    // The build this document runs is fixed at boot; this is the only way a deploy reaches it.
    if (booted) void pollBuild(Date.now());
  } catch (err) {
    camLog(`witness tick failed: ${err && err.name}: ${err && err.message}`);
  }
}, 1000);

/* ---------------------------------------------------------------- camera + tracking */

/** The camera needs an explicit action before a command may open it: the operator used this page
 *  recently (started, or pressed something on it). */
function canStartFromBus() {
  // The operator has used this page recently (started, or pressed anything on it): a deck key or
  // the pane may continue that session, never open the first camera of a page nobody has touched.
  //
  // No visibility gate, for the reason `autoCamera` states above its own start: an OBS browser
  // source reports `hidden` whenever it is not in the program, and this command travels the relay
  // path, which needs neither a gesture nor permission. Requiring "visible" protected nothing and
  // refused the camera in exactly the state the pane's button exists for, while the button had
  // already reported success. What is left is the one thing that is actually unsafe: a command
  // arriving at a page the operator has not touched within 20 s — that still refuses, below.
  return (performance.now() - (startClicks.at || 0)) < 20000;
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
 * Does a real camera own the page right now? `state.tracking && !state.synthetic` is the page's
 * claim; a claim with no frame for CAM_STALL_MS is the frame-less `running/camera` the relay reports
 * before its first frame, and treating it as live is what latched every self-heal at once.
 */
function trackingClaimLive() {
  return Boolean(
    state.tracking &&
      !state.synthetic &&
      state.lastFrameAt &&
      performance.now() - state.lastFrameAt <= CAM_STALL_MS,
  );
}

/**
 * Hand the page back to the synthetic rig after a camera failed or its track ended, so the overlay
 * keeps animating instead of freezing on the last camera frame. Never on the operator's own Stop.
 */
function fallBackToSynthetic() {
  if (userStopped) return false;
  if (state.trackingSource === 'camera') return false; // camera only: a blank page beats a fake one
  if (trackingClaimLive()) return false; // another camera session owns the view
  const drew = ensureSyntheticAnchors();
  if (drew) {
    setBanner(state.error ? `${state.error} — drawing on synthetic hands` : 'No camera — drawing on synthetic hands', 'warn');
    ack();
  }
  return drew;
}

/**
 * The camera retry. No gesture, no click: a page nobody can click (an OBS browser source) still
 * asks for the camera, and keeps asking for as long as the settings want one. The old two-attempt
 * cap is why a page whose relay, ffmpeg or camera dropped stayed inert until someone refreshed the
 * OBS source by hand; recovery is now the page's own job.
 *
 * Backoff is bounded: 2 s doubling to 30 s, never a tight loop. Every attempt and its outcome is one
 * console line with the `handfx cam:` prefix, so a page dump says what the camera did and when.
 */
const CAM_RETRY_BASE = 2000;
const CAM_RETRY_MAX = 30000;
/** A `running` claim older than this with no frame is a dead stream, not a camera that owns the
 *  page: the relay reports `running/camera` before its first frame, and that claim must not latch
 *  the retry loop shut. */
const CAM_STALL_MS = 3000;
const autoCam = { attempts: 0, nextAt: 0, timer: 0, busy: false };

function camLog(msg) {
  console.log(`handfx cam: ${msg}`);
}

/**
 * Where a fire-and-forget start reports its rejection. `void startTracking(...)` with no `.catch`
 * left the reason nowhere: the page looked idle while nothing was running and no `cameraError`
 * existed to say why. Same record the camera's own failures use, so `/status` and the pane's
 * diagnostics show it, and one line in the log names the stage.
 */
function noteStartFailed(what) {
  return (err) => {
    if (!err) return;
    camLog(`${what} failed: ${err.name || 'Error'}: ${err.message || err}`);
    // `startTracking` records the precise stage (getUserMedia / track / timeout) before it rejects,
    // so this wrapper must never overwrite that with its generic one. Fill in only when nothing has
    // been recorded — one error surface, and it keeps the more specific reason.
    if (state.cameraError) return;
    setCameraError('start', err.name || 'Error', `${what}: ${err.message || String(err)}`);
  };
}

function clearCameraRetry() {
  if (autoCam.timer) clearTimeout(autoCam.timer);
  autoCam.timer = 0;
  autoCam.nextAt = 0;
}

/** A live stream resets the backoff, so the next drop retries after 2 s again. */
function cameraLive() {
  clearCameraRetry();
  autoCam.attempts = 0;
  camLog('live');
}

/** The server's relay report from the last `/status` read: stalled → restarting → failed. */
function relayFeed() {
  const feed = state.status && state.status.cameraFeed;
  return feed && typeof feed === 'object' ? feed : null;
}

/** Why the last attempt failed, in the same words /ack reports. */
function cameraFailureReason() {
  // A relay that gave up is a different answer from one that dropped the picture and is retrying;
  // the page's own `relayError` records only the latter.
  const feed = relayFeed();
  if (feed && feed.state === 'failed') return `relay gave up: ${feed.error || 'no reason given'}`;
  if (state.relayError) return state.relayError;
  const err = state.cameraError;
  if (!err) return 'no frames';
  const detail = err.message || err.name || err.stage;
  return err.stage ? `${err.stage}: ${detail}` : String(detail);
}

/**
 * Arm the next attempt. One timer per page: a second failure replaces the pending retry instead of
 * stacking another, and an operator Stop (`userStopped`) ends the loop.
 */
function scheduleCameraRetry(reason) {
  if (userStopped) return;
  // A document that cannot acquire at all — a plain preview: no relay, no camera — has no attempt
  // to repeat. Arming the ladder there only re-entered startTracking every 31 s to tear a claim
  // down (`relay stop ... why=tracking-torn-down`), which is the noise, not a recovery: nothing in
  // this page's arming path can ever make it acquire. A camera preview and the OBS source both
  // have canAcquire true, so their ladder is untouched.
  if (!canAcquire) return;
  const delay = Math.min(CAM_RETRY_BASE * 2 ** Math.max(0, autoCam.attempts - 1), CAM_RETRY_MAX);
  if (autoCam.timer) clearTimeout(autoCam.timer);
  autoCam.nextAt = Date.now() + delay;
  camLog(`retry in ${delay}ms reason="${reason}"`);
  autoCam.timer = setTimeout(() => {
    autoCam.timer = 0;
    void autoCamera().catch(noteStartFailed('autoCamera retry'));
  }, delay);
}

async function autoCamera() {
  if (!canAcquire) return false; // a plain preview never opens the camera or the relay
  if (state.trackingSource === 'synthetic') return false; // the operator asked for synthetic only
  if (autoCam.busy) return false;
  // A retry is already armed: a stray caller must not shortcut the backoff.
  if (autoCam.nextAt && Date.now() < autoCam.nextAt) return false;
  // No visibility gate: an OBS browser source reports `hidden` while it is not in the program, and
  // the relay needs neither a gesture nor permission, so waiting for "visible" is exactly the
  // click-free page that never starts. The server stops ffmpeg on its own when no client reads.
  if (state.tracking && !state.synthetic) {
    if (trackingClaimLive()) return false; // a camera already owns the page
    // `trackingClaimLive()` is false both for a stale stamp and for no stamp at all, and a claim
    // that has only just started has none yet. Dropping it there killed a healthy relay mid-start
    // and restarted it in a loop: no landmark yet is "starting", not "stale".
    if (!state.lastFrameAt) return false; // starting: no landmark yet, not stale — leave it
    const stalledFor = Math.round(performance.now() - state.lastFrameAt);
    camLog(`stalled ${stalledFor}ms without a frame: dropping the tracking claim`);
    stopTracking({ manual: false });
  }
  autoCam.attempts += 1;
  autoCam.busy = true;
  camLog(`attempt ${autoCam.attempts} source="${state.trackingSource}"`);
  try {
    userStopped = false;
    // Relay only: the device path is unreachable on this rig (see startTracking).
    await startTracking();
    if (state.tracking && !state.synthetic) {
      cameraLive();
      return true;
    }
    fallBackToSynthetic();
    scheduleCameraRetry(cameraFailureReason());
    return false;
  } catch (err) {
    scheduleCameraRetry(`threw: ${(err && err.message) || err}`);
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
  // The stream is the LAST thing this document may take. Two long-lived responses (the bus, this
  // stream) plus the ack is 3 of the browser's 6 sockets per origin; a page that took the stream
  // before it had been heard once left the ack queued behind it for the full camera cap and looked
  // dead the whole time. The boot's ack is now first, so this is only ever a deferral: the retry
  // path re-enters in 2 s, and `camAttempted` stays false because nothing was attempted.
  // A camera-enabled preview is exempt from the ack proof, and only it. It never acks by three
  // gates (`ack()` returns for PREVIEW, the worker is not created, the interval is not started), so
  // `ackOkAt` stays 0 for that document's whole life and this gate would hold the stream forever:
  // `wanted` never turns true and the pane's underlay toggle does nothing. The trade is one
  // camera-stream socket spent without an ack proving the budget; that is acceptable here because
  // it is a single document the operator opened deliberately, and it stays out of the ack ledger,
  // so `freshestPage()` can never report this preview as the page while the real source is down.
  // The OBS source has CAMERA_PREVIEW false by construction, so its path is unchanged: no ack, no
  // stream.
  if (!state.ackOkAt && !CAMERA_PREVIEW) {
    state.relayError = 'relay: no ack yet — holding the stream for the socket';
    return false;
  }
  camAttempted = true; // a relay failure is a camera failure: the synthetic rig gets the view back
  const live = await relay.start();
  if (!live) {
    // No stream is no claim: a `running/camera` tracker left over from a frame-less start would
    // otherwise latch every self-heal (ensureSyntheticAnchors, fallBackToSynthetic, autoCamera).
    tracker.stop();
    state.tracking = false;
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
 * The bus's tracking command, in one place: `camera`, `synthetic`, `off`, or `toggle` (the deck
 * key's one-button form). Idempotent — asking for the state the page is already in does nothing, so
 * a second press can never restart a healthy relay. False means a mode this build does not know.
 */
function applyTrackingMode(mode) {
  const syntheticNow = Boolean(state.tracking && state.synthetic);
  if (mode === 'off') {
    stopTracking();
    return true;
  }
  if (mode === 'synthetic') {
    if (!syntheticNow) {
      if (state.tracking) stopTracking({ manual: false, keepView: true });
      void startTracking({ fromBus: true, synthetic: true, explicit: true }).catch(noteStartFailed('synthetic start'));
    }
    return true;
  }
  if (mode === 'camera') {
    if (state.tracking && !syntheticNow) return true; // already this camera's session
    // The pane's button is the operator's own click, just in another document: open the same
    // gesture window a press on this page would. A deck key has no such click and stays gated.
    noteStartClick();
    if (state.tracking) stopTracking({ manual: false, keepView: true });
    void startTracking({ fromBus: true, explicit: true }).catch(noteStartFailed('camera start'));
    return true;
  }
  if (mode === 'toggle') {
    // The deck key, unchanged: a live camera stops, anything else starts what the setting asks for.
    if (state.tracking && !state.synthetic) stopTracking();
    else void startTracking({ fromBus: true }).catch(noteStartFailed('toggle start'));
    return true;
  }
  return false;
}

async function startTracking({ fromBus = false, synthetic = false, explicit = false } = {}) {
  if (!canAcquire && !synthetic) return; // a plain preview never acquires a camera or the relay
  // A running camera owns the view; a running synthetic rig gives way to a real camera (the
  // overlay starts on synthetic when no camera arrives, so the Start button must still work).
  if (trackingClaimLive()) return;
  // Tearing the old claim down is only for a document that can take a new one. A plain preview
  // cannot acquire at all (canAcquire false): `stopTracking` would emit a `relay stop ...
  // why=tracking-torn-down` for a stream it never opened, once per retry, and then start again
  // from nothing. Neither the camera preview nor the OBS source is affected: both have
  // canAcquire true.
  if (state.tracking && canAcquire) stopTracking({ manual: false, keepView: true });
  userStopped = false;
  // An explicit mode wins over the persisted setting: `camera` starts the camera whatever the page
  // was last left on, and `synthetic` never opens one. Without a mode the persisted setting decides
  // — the boot path and the deck key's toggle, unchanged.
  const wantSynthetic = explicit ? synthetic : synthetic || state.trackingSource === 'synthetic';
  if (fromBus && !canStartFromBus() && !wantSynthetic) {
    setBanner('Camera not started: this page has not been used for 20 s (a browser only opens a camera after a real click).', 'warn');
    renderState();
    return;
  }
  state.synthetic = wantSynthetic;
  state.camera = 'asking';
  renderState();
  const status = await loadStatus().catch(() => null);
  const s = state.settings || {};
  // The model source is not a fact /status owns: see `modelSourceFor` — a failed read must leave
  // the page on the local route, never with no source at all.
  const opts = {
    resolution: s.resolution || '720p',
    deviceId: s.deviceId || '',
    sensitivity: s.sensitivity ?? 1,
    ...modelSourceFor(status),
  };
  syncSyntheticMode();
  if (wantSynthetic) {
    if (synthetic) tracker.syntheticTwoHands = true; // the button asks for the synthetic field
    tracker.startSynthetic();
    return;
  }
  if (await startRelay(opts)) return;
  // Nothing else to try: the retry loop owns the next attempt.
  state.camera = state.relayError ? 'error' : 'off';
  renderState();
}

function stopTracking({ manual = true, keepView = false } = {}) {
  if (manual) {
    userStopped = true;
    clearCameraRetry(); // the operator stopped it: no timer may start it again
  }
  camWasLive = false;
  tracker.stop();
  // `forget: manual` is the cause fix, not another guard. The operator's Stop really does end the
  // page's intent, but an automatic teardown (manual: false, from the stall drop at autoCamera and
  // the synthetic fallback) must keep `wanted`: it is what every re-open path tests. The default
  // `forget: true` erased it here, so one 120 s cap close became permanent — relay.js's
  // `wantReopen` timer then bailed on `!wanted` and nothing asked for the stream again.
  relay.stop({ forget: manual, why: manual ? 'operator-stop' : 'tracking-torn-down' });
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
  // A plain preview has no camera to show, so it always runs the rig locally; the pane labels it
  // as the preview, never as the OBS source. A camera preview has camera input like any page.
  if (state.trackingSource === 'camera' && canAcquire) return false; // camera only: never draw a synthetic frame
  if (trackingClaimLive()) return false; // a camera session owns the view
  // Ask the tracker, never a remembered flag: a camera attempt (and a Stop) closes the rig's frame
  // loop, and `state.synthetic` stayed true across it — the rig was then never restarted, so no
  // frames arrived, `fx.view` stopped moving and /ack (which rides on those frames) went quiet.
  if (tracker.state !== 'running' || tracker.source !== 'synthetic') tracker.startSynthetic();
  state.synthetic = true;
  state.tracking = true;
  state.cameraSource = 'synthetic';
  // Before the synthetic fill frame below, so the age reported is the last real frame's.
  noteSource('synthetic', state.error || state.relayError || 'no camera frames');
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
    noteSource(state.cameraSource, 'camera frames arriving');
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
    // No tracker session, no source: a camera that ended on its own must not leave `device` (or
    // `relay`) on /ack while the page draws nothing. Camera-only mode never reaches the synthetic
    // fallback that would rewrite it; the fallback below sets `synthetic` when it claims the view.
    state.cameraSource = 'none';
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

/**
 * The one mirror rule, stated once so the sampler and the draw cannot drift apart. Landmarks are
 * mirrored only when this page also paints the camera it mirrors: in the pane preview
 * (`?camera=1`) `paintUnderlay` draws the camera through the same setting, so the picture and the
 * landmarks agree. In the OBS source the page draws no camera pixels — the operator sees OBS's own
 * camera, which the page never touched — so flipping the landmarks there would put every effect
 * on the mirror image of the hand. The inputs are returned with the answer so a capture can
 * explain itself without reading this code.
 */
function mirrorRule(settings = state.settings, underlay = state.underlay) {
  const setting = !settings || settings.mirror !== false; // no document means mirrored
  const paintsCamera = underlay === true; // only then is there a page-drawn camera to match
  return { on: paintsCamera && setting, underlay: paintsCamera, setting };
}

// One launch detector per hand: the EMA must never mix two hands' distances. Fed on every frame,
// not on every diag sample — a 3-frame rise would fall entirely between two 10 Hz samples.
const thrusts = new Map();
const thrustNow = new Map(); // this frame's decision per hand, for the sampler to report

/**
 * Advance the thrust detector once per hand per frame. Bookkeeping only: nothing in the page acts
 * on a fire yet, it is published so a capture can show the timeline a launch would have used.
 */
function thrustStep(hands, now) {
  thrustNow.clear();
  if (!hands.length) {
    for (const t of thrusts.values()) t.reset(); // a stale average is not a baseline
    return;
  }
  for (const hh of hands) {
    const key = hh.handedness || 'unknown';
    let t = thrusts.get(key);
    if (!t) {
      t = new Thrust();
      thrusts.set(key, t);
    }
    const lm = hh.landmarks;
    // The gate needs the *signed* depth: `palmFacing`'s absolute value passes for a palm shown
    // backwards. Handedness is the only chirality cue, so the sign is corrected for it here.
    thrustNow.set(
      key,
      lm && lm.length
        ? t.push(palmArea(lm), now, facingCorrected(lm, hh.handedness))
        : t.push(0, now, 0),
    );
  }
}

function onFrame(frame) {
  // A frame is the only proof that a tracking claim is real. The relay reports `running/camera`
  // before its first frame, so the stall guard in autoCamera reads this stamp.
  state.lastFrameAt = performance.now();
  // Mirroring happens here, once: `mirrorRule` is the one statement of the rule, shared with the
  // diagnostic sampler so what a capture reports is what this line actually did.
  const mirror = mirrorRule().on;
  // Deduped once, here: every consumer downstream (classify, anchors, view.palms, diagnostics)
  // then works from the same corrected set.
  const hands = dedupeHands((frame.hands || []).map((h) => ({
    handedness: h.handedness,
    score: h.score,
    landmarks: mirror ? h.landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })) : h.landmarks,
  })));
  const centre = hands.length ? { x: hands[0].landmarks[9].x, y: hands[0].landmarks[9].y } : null;
  const swipe = motion.push(centre, frame.at);
  const result = classify(hands, { swipe });
  state.hands = hands.length;
  state.gesture = result.gesture || 'none';

  const now = frame.at;
  // Stage one of the projectile: record what the maths computes and act on nothing.
  thrustStep(hands, now);
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
  // Diagnostics read this frame; when off it is one compare, and it never touches the draw.
  diagMaybe(frame, hands, result, anchors, frame.at);
  // `camera` only while a camera track is actually live; every other frame is the synthetic rig.
  state.anchors = frame.source === 'camera' && tracker.state === 'running' && tracker.source === 'camera' ? 'camera' : 'synthetic';
  // Ambience: embers rise with any hand in frame, wires trace the skeleton itself. Both are
  // `gesture: 'any'` effects — a label the classifier never returns — so they are armed here from
  // the presence of hands instead of a beat. wires cannot fire without hands: this is its only
  // trigger, and the gate needs `hands.length`.
  if (hands.length && effectiveEffects().includes('embers') && !fx.live.has('embers') && result.gesture !== 'none') {
    fx.trigger('embers', {});
  }
  // Re-arm on inactivity, not on absence. A released effect stays in `live` while its fade ramps
  // down (fx.js deletes it only at fade < 0.01, most of a second), so `!live.has` ignored every hand
  // seen during that ramp: 23 spans in the capture, every one starting with a single dropped
  // sample. An entry that is present but inactive is as re-triggerable as a missing one. Losing the
  // hand waits `WIRES_GRACE_MS` so one dropped sample never starts the fade at all, and a hand that
  // returns clears the deadline. A real removal still reads as immediate: the capture's 6 s and
  // 7.2 s gaps showed a 1.2 s overstay was unnoticeable, so 200 ms is inside the noise.
  const wires = fx.live.get('wires');
  if (hands.length) {
    wiresGoneAt = 0;
    if (effectiveEffects().includes('wires') && (!wires || !wires.active)) fx.trigger('wires', {});
  } else if (wires && wires.active) {
    if (!wiresGoneAt) wiresGoneAt = now + WIRES_GRACE_MS;
    else if (now >= wiresGoneAt) {
      fx.release('wires');
      wiresGoneAt = 0;
    }
  }
  // A beat effect is alive exactly as long as its gesture. No hands is unambiguous — the
  // classifier cannot re-fire a gesture it cannot see — so every beat effect goes at once. A
  // gesture *change* with a hand still in frame is only a claim until it holds: wait the grace
  // beat before retiring the effect, so a single misclassified frame does not blink it off. A
  // gesture that comes back cancels the pending release; `beat` below may also take the slot in
  // this same frame, which retires the effect it replaces.
  if (!hands.length) {
    for (const id of [...beatFx.started]) releaseBeat(id);
  } else if (beatFx.id) {
    if (result.gesture === beatFx.gesture) beatFx.until = 0;
    else if (!beatFx.until) beatFx.until = now + BEAT_LINGER_MS;
    else if (now >= beatFx.until) releaseBeat(beatFx.id);
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
    // A new beat takes over: whatever beat effect was alive belongs to the previous gesture.
    if (beatFx.id && beatFx.id !== beat) releaseBeat(beatFx.id);
    if (beat === 'shoot') spawnShoot(anchors);
    else fx.trigger(beat, {});
    beatFx.id = beat;
    beatFx.gesture = fired.fire;
    beatFx.until = 0;
    beatFx.started.add(beat);
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

/**
 * This page load's identity, made once and never reused across loads. The server ignores unknown
 * fields today; the point is that a status line can say *which* of the four page sessions in an OBS
 * window is the one still alive, instead of counting acks from a ghost.
 */
const CLIENT_ID = (diag.clientId && String(diag.clientId)) || (() => {
  try {
    if (self.crypto && typeof self.crypto.randomUUID === 'function') return self.crypto.randomUUID();
  } catch {
    /* fall through to hex */
  }
  const bytes = new Uint8Array(16);
  try {
    self.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
})();
diag.setClient(CLIENT_ID);

/** One /ack in flight at a time. A request that never returns must not own a connection: with no
 *  guard and no timeout, every ack the browser failed to retire kept its socket, and six of them
 *  (the per-origin cap) wedged the page: no acks, no status, no SSE reconnect, forever. */
let ackInFlight = false;
/** When the gate was closed, so a latch nobody honours cannot outlive its own timeout unwatched. */
let ackLatchedAt = 0;

function ack(now = performance.now()) {
  // A preview never reports: the server's draw truth belongs to the OBS source, and a preview
  // that acks makes a dead source look healthy (draws/staleness are read back on /status).
  if (PREVIEW) return;
  // The gate is one request in flight, not a clock: the 500 ms throttle below paces, it never
  // retires a hung request.
  if (ackInFlight) return;
  // At most 2/s: this is a status line, not telemetry. `lastAck === 0` is "never acked", not
  // "acked at time zero": the throttle used to swallow the boot's own first ack on every load,
  // because a document always starts inside the first 500 ms.
  if (state.lastAck && now - state.lastAck < 500) return;
  state.lastAck = now;
  // The body is built BEFORE the latch is taken, inside a try. The latch used to be set above the
  // body, with the body's field reads unguarded: one throwing getter meant fetch was never called,
  // nothing ever cleared the latch, and every later tick returned at the gate — one ack, then
  // permanent silence. Now a throw frees the beat (the latch was never taken) and reports itself.
  let payload;
  try {
    // The build self-heal's own ledger: how many self-reloads this server build has cost and when
    // this document first saw the mismatch. On /status it makes the stale page a visible fact.
    const buildState = buildCheck.state();
    payload = JSON.stringify({
      // The bundle this document is running. The server compares it with its own and reports
      // `buildMatches` on /status; an old OBS source then shows as a mismatch, not as healthy.
      build: BUILD,
      // Which page load this is. Additive: the server ignores fields it does not know.
      clientId: CLIENT_ID,
      // The document identity, so /status can group the acks of a page's successor and predecessor
      // under one role instead of one ephemeral clientId each (see ROLE at the top of this file).
      role: ROLE,
      // The build self-heal's ledger, read back on /status per client. Additive, clamped there.
      reloads: buildState.reloads,
      lastReloadAt: buildState.lastReloadAt,
      staleSince: buildState.staleSince,
      // Does this document need frames? This is the relay's arm signal, carried on the beat that
      // already exists: the server holds the capture while any live page says yes and releases it
      // when none does, so a node restart is recovered by the next ack instead of by a subscription
      // a reconnect can lose. False when the settings name no camera (`cameraRelay: "off"` —
      // synthetic is correct there) and false when the operator asked for synthetic only.
      wantsFeed: canAcquire && cameraWanted(state.settings) && state.trackingSource !== 'synthetic',
      effect: state.effect,
      tracking: state.tracking,
      tracker: tracker.snapshot(),
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
      // Whether this page believes it holds a stream right now. `clients` on /status is the
      // server's count; this is the page's side of the same fact, on the same wire.
      streamAttached: relay.isLive(),
      // The mask's receipt time, so the server's status can say "mask arriving" without a frame
      // ever leaving this page. `body` also lets the pane name the body effects honestly.
      maskAt: state.bodySeen ? state.bodyAt : 0,
      body: state.bodySeen,
      // The draw truth: how many frames the loop has rendered, where its anchors came from, and
      // when the last one landed. Counters only — still no frame and no landmark leaves the page.
      draws: state.draws,
      anchors: state.anchors,
      lastDrawAt: state.lastDrawAt,
      // The paint clock itself, not just its output: `loopTicks` frozen with `lastAckAt` fresh is
      // a page whose document is not being composited (Chrome delivers no rAF to it), which is a
      // different fault from a dead page. `hidden` says whether Chrome has marked the document so.
      loopTicks: state.loopTicks,
      lastLoopAt: state.lastLoopAt,
      hidden: document.hidden,
      visibility: document.visibilityState,
      // Where a slow publish frame goes: compose, readback, NV12 conversion, upload. Numbers only.
      publishTiming: publisher.timing(),
      // How far this document got, emitted once each by the boot path: a page that stalls before
      // its first draw still names the last breadcrumb it reached.
      phases: diag.phaseList(),
    });
  } catch (err) {
    // No request started, so the latch was never taken: the 500 ms beat survives a bad field read.
    ackInFlight = false;
    diagError('ack-body', err, 'ack body');
    return;
  }
  // The worker paces itself and guards its own in-flight request, so the latch and the timeout
  // belong to the fallback path only. A frozen main thread still hands over its last payload, and
  // the worker keeps posting it: that is what makes liveness independent of the render loop.
  if (ackWorker) {
    ackWorker.postMessage({ type: 'payload', body: payload });
    return;
  }
  // Only now, with a body in hand, is the gate closed. `.finally` is the only place that frees it.
  ackInFlight = true;
  ackLatchedAt = Date.now();
  try {
    fetch('/api/handfx/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
      body: payload,
    })
      .then((res) => {
        // A failed ack is not page state, but a successful one is the liveness proof the watchdog
        // waits for: no ack for 5 s means this page's own connection is gone.
        if (res.ok) {
          state.ackOkAt = Date.now();
          state.ackFails = 0;
          watchdog.ok();
          // The page reached the server at least once. A stall after this line is a JS fault, not a
          // boot that never ran; the breadcrumb is the difference.
          diag.phase('first-ack');
        } else {
          ackFailed();
        }
        return res.ok ? res.json().catch(() => null) : null;
      })
      .then((doc) => {
        // The server resolves `default` on every read, so a ratio changed in core (or by a scene)
        // reaches the fence within one beat even though no settings frame was published to the page.
        const ratio = doc && doc.ratio;
        if ((ratio === '9:16' || ratio === '16:9') && ratio !== fx.settings.ratio) fx.setSettings({ ratio });
      })
      .catch((err) => {
        // Includes the 4 s AbortError: a request that was never retired is a failure, and the
        // wedge check reads the count, so it must not be swallowed.
        ackFailed();
        diagError('ack-fail', err, 'ack request');
      })
      .finally(() => {
        // Only a settled request frees the slot, so a hung one is replaced on its own timeout.
        ackInFlight = false;
        ackLatchedAt = 0;
      });
  } catch (err) {
    // `fetch` itself threw synchronously (a bad URL, a blocked signal): nothing is in flight.
    ackInFlight = false;
    ackLatchedAt = 0;
    ackFailed();
    diagError('ack-body', err, 'ack fetch');
  }
}

/** Count a failed or timed-out /ack. `ackFails` is what tells a wedged *network* from a wedged
 *  render loop: the loop keeps ticking through both. */
function ackFailed() {
  state.ackFails += 1;
  state.ackFailAt = Date.now();
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
  else if (state.camera === 'error') {
    // `stalled` / `restarting` is a drop the relay is still retrying; `failed` is it giving up.
    // `state.camera` alone says only "error", which would read as terminal in both cases.
    const feed = relayFeed() || {};
    if (feed.state === 'failed') bits.push(`relay gave up: ${String(feed.error || 'no frames').slice(0, 80)}`);
    else if (feed.state === 'stalled' || feed.state === 'restarting' || autoCam.timer) bits.push('camera dropped, retrying');
    else bits.push('camera error');
  }
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
  // The fence the particles feel, drawn only in debug: the OBS source stays clean, and the
  // operator can see where the wall is while tuning. Derived from the same formula the engine uses.
  const wall = fenceRectFor(fx.settings.ratio, w, h);
  if (wall) {
    debugCtx.strokeStyle = 'rgba(255,214,102,.6)';
    debugCtx.lineWidth = 1;
    debugCtx.beginPath();
    debugCtx.moveTo(wall.x + 0.5, 0);
    debugCtx.lineTo(wall.x + 0.5, h);
    debugCtx.moveTo(wall.x + wall.w - 0.5, 0);
    debugCtx.lineTo(wall.x + wall.w - 0.5, h);
    debugCtx.stroke();
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

/* ---------------------------------------------------------------- frame diagnostics (?diag=1) */

// `?diag=1` — or a `diag.start` command, which is how a capture arms an already-running source
// without reloading it — turns on a per-frame record of what this page computed and drew. Off is
// the normal case and costs one numeric compare per frame: `diagUntil` is 0, so nothing is
// sampled, nothing allocated and no timer runs. On, it only *reads*: the geometry, the anchors and
// the effect centres are the ones the frame already produced. No draw path is changed by it.
const DIAG_ON = new URLSearchParams(location.search).get('diag') === '1';
const DIAG_RATE_MS = 100; // ~10 Hz: a fifth of the render rate, and enough to see drift
const DIAG_FULL_EVERY = 5; // every 5th sample carries all 21 landmarks; the rest carry three
const DIAG_BATCH = 10; // samples per POST, about one second at 10 Hz
const DIAG_MAX_QUEUE = 400; // a server that never answers must not grow the page's memory
const DIAG_URL = '/api/handfx/diag';
const DIAG_PICK = [0, 9, 8]; // wrist, middle MCP, index tip: the three the mapping is judged on

let diagUntil = 0; // Date.now() deadline; 0 means off
let diagNextAt = 0;
let diagCount = 0;
let diagQueue = [];
let diagPosting = false;
let diagTimer = 0;
let diagSent = 0;
let diagDropped = 0;

const d4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const d2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** Page space (0..1, y down) to canvas device pixels — the shaders' own scale, read backwards. */
function diagPx(p, w, h) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !w || !h) return null;
  return { x: Math.round(p.x * w), y: Math.round(p.y * h) };
}
function diagPick(lm, full) {
  if (!Array.isArray(lm)) return null;
  const one = (i) => (lm[i] ? { x: d4(lm[i].x), y: d4(lm[i].y), z: d4(lm[i].z) } : null);
  return full ? lm.map((p) => ({ x: d4(p.x), y: d4(p.y), z: d4(p.z) })) : DIAG_PICK.map(one);
}
function diagAnchor(p) {
  return p && Number.isFinite(p.x) ? { x: d4(p.x), y: d4(p.y), r: d4(p.radius) } : null;
}

/**
 * One sample of what this frame computed. `hands` are the mirrored page-space readings the
 * classifier and the renderer both used; `view` is `fx.view` exactly as the effect layer got it.
 */
function diagSample(frame, hands, result, view, now) {
  diagCount += 1;
  const g = result && result.hands ? result.hands[0] : null;
  // This frame's thrust decision for the hand the sample describes. A launch frame is forced
  // full: the aim has to be auditable landmark by landmark on the frame it fired.
  const thrust = g ? thrustNow.get(g.handedness || 'unknown') || null : null;
  const full = diagCount % DIAG_FULL_EVERY === 1 || Boolean(thrust && thrust.fire);
  const m = mirrorRule(); // the same rule `onFrame` applied this frame, not a copy of it
  const w = fx.w || 0;
  const h = fx.h || 0;
  const video = tracker.video || null;
  const fence = fenceRectFor(fx.settings.ratio, w, h);
  const sample = {
    n: diagCount,
    ts: d2(now),
    wallAt: Date.now(),
    full,
    source: frame.source || null,
    mirror: {
      // What the overlay really did this frame, with both inputs that decided it, so a capture
      // explains itself: mirroring applies only when this page paints the camera it mirrors.
      on: m.on,
      underlay: m.underlay,
      setting: m.setting,
      applied:
        'onFrame: x = 1 - x, once, before classify and before fx.view — only when state.underlay is true (the pane preview, ?camera=1); the OBS source never mirrors',
    },
    geometry: {
      // What the relay sent, what the tracker read, what the canvas is, and what the CSS says:
      // a mismatch between these is the first thing a landmark offset shows up as.
      frame: { w: frame.width || null, h: frame.height || null },
      video: { w: video ? video.videoWidth || null : null, h: video ? video.videoHeight || null : null },
      canvas: {
        w,
        h,
        cssW: canvas.clientWidth,
        cssH: canvas.clientHeight,
        dpr: w && canvas.clientWidth ? d2(w / canvas.clientWidth) : null,
      },
      ratio: fx.settings.ratio ?? null,
      fence: fence ? { x: d4(fence.x), y: d4(fence.y), w: d4(fence.w), h: d4(fence.h) } : null,
      crop: null, // the drawing code applies no crop: page space is the whole frame
      mapping: 'page (0..1, y down) * canvas pixels; shader uv = (x * aspect, 1 - y)',
    },
    // The detector's own normalised space, unmirrored, as the worker reported it.
    landmarks: (frame.hands || []).map((hh) => ({
      handedness: hh.handedness || null,
      lm: diagPick(hh.landmarks, full),
    })),
    // The same three after every mapping this page applies, in canvas pixels.
    mapped: (hands || []).map((hh) => ({
      handedness: hh.handedness || null,
      wrist: diagPx(hh.landmarks && hh.landmarks[0], w, h),
      middleMcp: diagPx(hh.landmarks && hh.landmarks[9], w, h),
      indexTip: diagPx(hh.landmarks && hh.landmarks[8], w, h),
    })),
    anchors: view
      ? {
          anchor: diagAnchor(view.anchor),
          anchorPx: diagPx(view.anchor, w, h),
          front: diagAnchor(view.front),
          swipe: diagAnchor(view.swipe),
          palms: (view.palms || []).map((p) => ({ x: d4(p.x), y: d4(p.y), r: d4(p.radius) })),
          // `view.hands` as the effect layer receives it; all 21 landmarks only on a full sample.
          hands: (view.hands || []).map((hh) => ({
            handedness: hh.handedness || null,
            palm: hh.palm ? { x: d4(hh.palm.x), y: d4(hh.palm.y), r: d4(hh.palm.radius) } : null,
            ...(full ? { landmarks: (hh.landmarks || []).map((p) => ({ x: d4(p.x), y: d4(p.y) })) } : {}),
          })),
        }
      : null,
    effects: [...fx.live.values()].map((l) => ({
      id: l.id ?? null,
      active: l.active !== false,
      age: d2(l.age),
      fade: d4(l.fade),
      radius: d4(l.radius),
      // The page-space centre this effect's shader was last handed, and the same in canvas pixels.
      at: l.drawnAt ? { x: d4(l.drawnAt.x), y: d4(l.drawnAt.y) } : null,
      px: diagPx(l.drawnAt, w, h),
    })),
    settingsEffects: Array.isArray(fx.settings.effects) ? fx.settings.effects.slice(0, 32) : [],
    gesture: result
      ? {
          gesture: result.gesture || 'none',
          palmUp: g ? !!g.palmUp : null,
          palmFront: g ? !!g.palmFront : null,
          point: g ? !!g.point : null,
          fist: g ? !!g.fist : null,
          open: g ? d4(g.open) : null,
          count: g ? g.count ?? null : null,
          palmFacing: g && Array.isArray(g.landmarks) ? d4(palmFacing(g.landmarks)) : null,
          centre: g && g.centre ? { x: d4(g.centre.x), y: d4(g.centre.y) } : null,
          scale: g ? d4(g.scale) : null,
        }
      : null,
    // Stage one of the projectile, published on every sample: where the palm points (raw normal and
    // the mapped aim) and what the launch detector saw. `fire` is a one-shot — true on the frame it
    // fires, false otherwise — so a capture reads as a timeline rather than a latched flag.
    // `hand` rides along because the aim's depth sign is a property of the hand MediaPipe reports.
    aim:
      g && Array.isArray(g.landmarks) && g.landmarks.length >= 18
        ? (() => {
            const n = palmNormal(g.landmarks);
            const a = aimVector(g.landmarks, w, h);
            return {
              hand: g.handedness || null,
              nx: d4(n.x),
              ny: d4(n.y),
              nz: d4(n.z),
              unit: 'page (0..1, y down) → x * aspect, 1 − y; z: +1 toward the camera, −1 away',
              norm: { x: d4(a.x), y: d4(a.y), z: d4(a.z) },
              // The two inputs the mapping consumed, so an aim can be recomputed from the sample.
              aspect: w && h ? d2(w / h) : null,
              // `facing` is the absolute depth the old gate used; `zSigned` is the real signed
              // component in the aim's Left-positive convention, so the direction is auditable
              // instead of collapsed into a magnitude. The thrust gate consumes
              // `facingCorrected` (this negated for a Right hand); `hand` says which applied.
              facing: d4(palmFacing(g.landmarks)),
              zSigned: d4(palmFacingSigned(g.landmarks)),
            };
          })()
        : null,
    thrust: thrust
      ? {
          fire: thrust.fire,
          rate: d4(thrust.rate),
          ema: d4(thrust.ema),
          m: d4(thrust.m),
          // Why a frame that looked fireable did not fire: the rise count the window held, and
          // the first gate that refused ('rate', 'window', 'facing', 'cooldown'); null on a fire.
          rises: thrust.rises,
          gate: thrust.gate,
          ...(full
            ? {
                thresholds: {
                  rate: THRUST_RATE,
                  frames: THRUST_FRAMES,
                  window: THRUST_WINDOW,
                  cooldownMs: THRUST_COOLDOWN_MS,
                  facingMin: THRUST_FACING_MIN,
                },
              }
            : {}),
        }
      : null,
  };
  diagQueue.push(sample);
  if (diagQueue.length > DIAG_MAX_QUEUE) {
    diagDropped += diagQueue.length - DIAG_MAX_QUEUE;
    diagQueue.splice(0, diagQueue.length - DIAG_MAX_QUEUE);
  }
}

/** POST the queued samples. A missing endpoint or a refused request is swallowed: never a throw. */
function diagFlush() {
  try {
    if (diagUntil && Date.now() > diagUntil) diagStop('expired');
    if (diagPosting || !diagQueue.length) return;
    const batch = diagQueue.slice(0, DIAG_BATCH);
    diagQueue = diagQueue.slice(batch.length);
    diagPosting = true;
    fetch(DIAG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diag: true, clientId: CLIENT_ID, build: BUILD, samples: batch }),
    })
      .then((r) => { if (r && r.ok) diagSent += batch.length; })
      .catch(() => {})
      .finally(() => { diagPosting = false; });
  } catch {
    diagPosting = false;
  }
}

function diagStart(seconds) {
  const s = Math.max(1, Math.min(3600, Number(seconds) || 600));
  diagUntil = Date.now() + s * 1000;
  if (!diagTimer) diagTimer = setInterval(diagFlush, 1000);
  camLog(`diag: armed for ${s}s`);
}

function diagStop(why) {
  const was = Boolean(diagUntil || diagTimer);
  diagUntil = 0;
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = 0;
  if (!was) return;
  camLog(`diag: stopped (${why}), ${diagSent} sent, ${diagDropped} dropped`);
  diagFlush(); // the tail, once, without rearming
}

/** The one call the frame handler makes. Off, it is a single compare. */
function diagMaybe(frame, hands, result, view, now) {
  if (!diagUntil) return;
  if (Date.now() > diagUntil) { diagStop('expired'); return; }
  if (now < diagNextAt) return;
  diagNextAt = now + DIAG_RATE_MS;
  try {
    diagSample(frame, hands, result, view, now);
  } catch (err) {
    // Observation must never be the reason a frame is lost.
    state.diagFails += 1;
  }
}

// `?diag=1` is the page's own switch: armed from load, for an hour, so a source that was pointed
// at the diagnostic URL samples without anyone posting a command. A command can still stop it.
if (DIAG_ON) {
  diagUntil = Date.now() + 3600 * 1000;
  diagTimer = setInterval(diagFlush, 1000);
}


let bodyTickAt = 0;
/** The diagnostic readout's element: written on every loop tick, so it is as live as the paint. */
const diagEl = document.getElementById('diag');
/**
 * A phase() breadcrumb that cannot be the reason the loop stops. A partial or broken shim is
 * exactly what a harness injects, and a throw here used to strand the frame loop.
 */
function guardDiag(name) {
  try {
    diag.phase(name);
  } catch (err) {
    state.diagFails += 1;
    diagError('diag-phase', err, `phase ${name}`);
  }
}
function paintDiag() {
  if (!diagEl) return;
  try {
    const ackAge = state.ackOkAt ? Date.now() - state.ackOkAt : -1;
    const phases = diag.phaseList();
    diagEl.textContent =
      `t=${state.loopTicks} d=${state.draws} ack=${ackAge < 0 ? 'never' : ackAge} ` +
      `fails=${state.ackFails} gate=${ackInFlight ? 1 : 0} ph=${phases.length ? phases[phases.length - 1] : ''}`;
  } catch (err) {
    // The readout is narration. Losing it leaves a blank line, not a dead page.
    state.diagFails += 1;
    diagError('diag-paint', err, 'paintDiag');
  }
}
function loop(now) {
  // One frame may fail (a GL hiccup, a body bitmap, a broken effect); the loop may not. The frame
  // is what the page has instead of a sign of life, so the next one is scheduled here, first,
  // before any statement that can throw: a re-arm in a `finally` only runs if the `try` was
  // entered, and a throw in the diagnostics above it stranded the loop until the 15 s wedge
  // self-reload. Invariant: every entry schedules exactly one next frame, and nothing between the
  // entry and that line can throw.
  requestAnimationFrame(loop);
  // The paint clock, stamped before anything can throw: /ack reports both, so the server can say
  // "not ticking" without guessing.
  state.loopTicks += 1;
  state.lastLoopAt = Date.now();
  // The page's own clock, written where a screenshot can read it: loop ticks, draws, ack age,
  // failures and whether the ack gate is holding. One frame, one answer to mute-versus-dead.
  // Both are guarded: narration that throws must not be the reason the picture stops.
  if (state.loopTicks === 1) guardDiag('first-frame');
  paintDiag();
  // The body mask expires 1 s after its last message; checked twice a second, not per frame.
  if (now - bodyTickAt > 500) {
    bodyTickAt = now;
    tickBody();
  }
  // The camera picture under the effects: the same surface the tracker is reading (the relay's
  // frame canvas or the device's video element), so underlay never adds a second decode. Painted
  // even when the effects are off: the underlay is the camera, not an effect.
  // `state.synthetic` is a page-side claim, not a fact about this tick: a relay that reported
  // `running` before a frame arrived leaves it stale, and requiring it here is what kept a live
  // stream's frames off the screen. The tracker's own frame surface is the fact.
  const camSurface = state.underlay && state.tracking && tracker.state === 'running'
    ? tracker.frameSurface()
    : null;
  if (camSurface) paintUnderlay(camSurface);
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
      if (state.draws === 1) guardDiag('first-draw');
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
  // `/ack` went quiet, so `/status` showed a frozen `draws` next to a live `publish`.
  //
  // /ack is NOT called here any more. It rode this loop, and this loop only exists while Chrome
  // paints the document: an occluded OBS source delivers no rAF, so the beat went silent while
  // the page was alive, and /status said `stale` — the wrong fact, hiding the true one (nothing
  // is being drawn). The beat is the timer below; this loop only reports its own clock.
}

/**
 * The liveness beat: a timer, deliberately not the render loop.
 *
 * Chrome delivers no `requestAnimationFrame` to a document it is not compositing — a hidden tab,
 * and an OBS browser source whose layer nothing can see. Timers keep running there (measured at
 * this repo: rAF +0 in 3 s while setInterval advanced), so the page can still report honestly:
 * `draws`/`loopTicks` frozen says the loop is stopped, `lastAckAt` advancing says the page is not
 * gone. `ack()` keeps its own 2/s throttle, so a burst of event-driven calls changes nothing.
 */
const ACK_MS = 500;
if (!PREVIEW) setInterval(() => ack(), ACK_MS);

/**
 * The beat: a liveness report that cannot be starved.
 *
 * Deliberately not `fetch`, not JSON, not a websocket — an `<img>` GET. It shares none of `ack()`'s
 * machinery (no latch, no body build, no response to parse), so it keeps arriving when the ack gate
 * is stuck, when a field read throws, or when the fetch pool is contended. Reassigning `src` aborts
 * the previous request, so a hung one can never queue behind itself.
 *
 * The counters it carries are what let the node tell a *mute* page (beats fresh, acks stale: alive
 * and drawing, not talking) from a *dead* one (both stale). No frame, no landmark ever rides it.
 */
const BEAT_MS = 1000;
let beatSeq = 0;
let beatImg = null;
/** The last boot phase seen by the beat, so the block witness can name where the page got to. */
let lastPhase = '';
function beat() {
  if (PREVIEW) return;
  try {
    const phases = diag.phaseList();
    const phase = phases.length ? phases[phases.length - 1] : '';
    lastPhase = phase;
    const query =
      `c=${encodeURIComponent(CLIENT_ID)}&t=${state.loopTicks}&d=${state.draws}` +
      `&p=${encodeURIComponent(phase)}&b=${encodeURIComponent(BUILD)}&n=${(beatSeq += 1)}`;
    if (!beatImg) beatImg = new Image();
    beatImg.src = `/api/handfx/beat?${query}`;
  } catch (err) {
    diagError('boot-step', err, 'beat');
  }
  // The same 1 s timer feeds the off-thread witness, carrying the same counters the beat reports.
  // It must ride this timer and not its own: the question the worker answers is exactly "did this
  // timer stop?", so it has to watch this one.
  if (blockWatch) {
    try {
      blockWatch.postMessage({ type: 'tick', t: Date.now(), ticks: state.loopTicks, draws: state.draws, phase: lastPhase });
    } catch {
      /* a dead worker is a blind spot, not a page fault */
    }
  }
}

/**
 * The block witness: the only instrument on this page that runs off its own main thread.
 *
 * When the main thread blocks, rAF, `setInterval` and this beat all stop in the same instant, and
 * the last painted frame stays on screen — a page that cannot say what happened. A worker keeps its
 * own thread and its own `fetch`, so 5 s of silence is still reportable while the page is mute.
 *
 * Nothing here may break the overlay: a missing worker is recorded through diagError and forgotten.
 */
let blockWatch = null;
try {
  if (!PREVIEW) {
    const workerUrl = new URL('./watchdog-worker.js', import.meta.url);
    // Same content identity as the module, so a deploy cannot leave a worker behind.
    if (BUILD !== 'unknown') workerUrl.search = `?v=${encodeURIComponent(BUILD)}`;
    blockWatch = new Worker(workerUrl);
    blockWatch.onerror = (e) => diagError('watchdog-worker', new Error((e && e.message) || 'worker error'), 'block witness');
    blockWatch.postMessage({ type: 'hello', clientId: CLIENT_ID });
    // A real teardown is not a block: say goodbye on both paths, since an OBS reload may only fire
    // one of them. `bye` is idempotent on the worker side.
    const bye = () => {
      try {
        if (blockWatch) blockWatch.postMessage({ type: 'bye' });
      } catch {
        /* already gone */
      }
    };
    addEventListener('pagehide', bye);
    addEventListener('beforeunload', bye);
    // The cheap half of the socket leak: this document's two long-lived responses are closed as it
    // goes, so the successor boots with slots to spare. `persisted` is deliberately not honoured: an
    // OBS browser source is never restored from bfcache, and the server's supersede rule fires only
    // inside a handler the successor cannot reach while the predecessor holds all six sockets.
    addEventListener('pagehide', releaseSockets);
    addEventListener('beforeunload', releaseSockets);
    // A page restored from bfcache did lose its bus above; take it back. relay.js does the same for
    // the camera stream on its own `pageshow`.
    addEventListener('pageshow', (ev) => {
      if (ev && ev.persisted && !bus) connectBus();
    });
  }
} catch (err) {
  blockWatch = null;
  diagError('boot-step', err, 'block witness');
}
if (!PREVIEW) {
  beat();
  setInterval(beat, BEAT_MS);
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
  // The first ack goes out BEFORE the boot's first await. The boot's own reads queue behind the
  // bus and the camera stream on the browser's six-per-origin sockets, and a document that is
  // still queued for one produces no ack, no beat and no loop-start — indistinguishable from a
  // dead page until the camera's 120 s cap frees a slot. The ack is one short POST; the status
  // read it used to wait behind has a late refresh path (`scheduleRefresh`, the boot-step below).
  ack();
  // The render loop starts here, before the boot's settings read and never gated on it: this page's
  // job is to draw, and a fetch that is slow, refused, aborted or never answered must not cost the
  // first frames. `state.settings` already holds the default document, so the loop's own gate is
  // open from tick 1; the real document lands when it lands, through the read below and through
  // `scheduleRefresh` once the bus opens.
  diag.phase('loop-start');
  requestAnimationFrame(loop);
  try {
    const status = await loadStatus(BOOT_STATUS_MS);
    // `state-loaded` means the boot status request succeeded, so it is emitted the moment the read
    // resolves and before anything is done with the document. A document this page cannot apply
    // must not be able to hide a working fetch behind a missing breadcrumb.
    diag.phase('state-loaded');
    heard = true;
    try {
      applySettings(status);
    } catch (err) {
      // The loop already drew the defaults that `state.settings` holds. A document that cannot be
      // applied is a `boot-step` on the event ring, where the pane can show it.
      diagError('boot-step', err, 'applySettings (status)');
    }
    if (status && (!status.runtime || !status.runtime.vendored)) setBanner('MediaPipe runtime is not vendored — run the vendor copy step (modules/handfx/vendor/README.md).', 'bad');
  } catch (err) {
    // The loop is already drawing the defaults. Put them through `applySettings` anyway (the
    // renderer's own settings, the underlay, the publisher), then report the missing document on
    // the banner and on the page's event ring, so a failed boot read is never again silent.
    try {
      applySettings();
    } catch (e) {
      diagError('boot-step', e, 'applySettings (defaults)');
    }
    diagError('boot-step', err, 'boot status');
    setBanner(`Cannot read /api/handfx/status: ${err.message}`, 'bad');
  }
  // A preview listens to the bus for nothing: every command it could receive would act on the
  // preview (tracking.toggle, reload), and its status must never be mistaken for the source's.
  // Each of the three synchronous boot steps is guarded on its own: one throwing must not abort
  // boot before `loop-start`, because a page that cannot render must still be able to say why.
  if (!PREVIEW) {
    try {
      connectBus();
    } catch (err) {
      diagError('boot-step', err, 'connectBus');
    }
  }
  // The page has just heard from the server: the watchdog starts healthy rather than counting a
  // stale 0 as a failed connection in its first second. A page whose boot could not reach the
  // server is left stale on purpose, so the first tick starts recovering.
  try {
    if (heard) watchdog.ok();
  } catch (err) {
    diagError('boot-step', err, 'watchdog.ok');
  }
  try {
    renderState();
  } catch (err) {
    diagError('boot-step', err, 'renderState');
  }
  // Never a blank page, not even for one frame: unless the mode is camera-only, the synthetic rig
  // draws now and the camera attempt replaces it the moment a real track runs (onTrackerState →
  // running, source camera). In `synthetic` the camera is never asked for at all.
  try {
    ensureSyntheticAnchors();
  } catch (err) {
    diagError('boot-step', err, 'ensureSyntheticAnchors');
  }
  // The loop is already running: `loop-start` and the rAF request are issued before the boot's
  // settings read, so nothing above can leave this page without frames.
  // The load attempt, without a gesture: an OBS browser source is never clicked, so a camera only
  // opens here if this page asks for it itself (`auto` and `camera`; `synthetic` skips it).
  autoCamera().catch((err) => diagError('boot-step', err, 'autoCamera'));
  document.addEventListener('visibilitychange', () => {
    if (!canAcquire) return; // a plain preview never acquires, and never "recovers" a source it is not
    if (document.visibilityState === 'visible') {
      // Shown again: a fresh backoff, because the camera may have changed hands while hidden.
      clearCameraRetry();
      autoCam.attempts = 0;
      autoCamera().catch((err) => diagError('boot-step', err, 'autoCamera (visible)'));
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
})().catch((err) => diagError('boot-throw', err, 'boot'));
