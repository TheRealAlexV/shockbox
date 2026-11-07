// The camera half of a recovery, kept out of main.js so the stub harness drives the real
// decision instead of a browser.
//
// The rule: a server restart re-arms the camera the *settings* ask for, not the camera the page
// last managed to open. A dead relay already ran `fallBackToSynthetic()` (which sets
// `camAttempted = false` and stops tracking), so keying recovery on that failure state skipped the
// camera on every restart and left the page on synthetic hands behind a Start button.

/**
 * The camera the settings ask for. `cameraRelay: off` is the operator's "this page runs without a
 * camera"; absent settings mean the defaults, and the default is on. Nothing here looks at the
 * last camera attempt, only at what the server says the page should do.
 */
export function cameraWanted(settings) {
  return !settings || settings.cameraRelay !== 'off';
}

/**
 * Re-arm after the server returns: drop the stream that can never deliver again, stop the tracker,
 * drop a camera claim no frame backs, then let `autoCamera` open the relay it already owns. The
 * caller has cleared the retry backoff first, so this attempt is immediate; if it fails, the page's
 * own bounded retry (2 s doubling to 30 s) keeps going without anyone touching the OBS source.
 *
 * `live` is a session that is starting frames right now, which is worth re-arming even when the
 * relay setting is off (a session the operator started).
 */
export async function rearmCamera({ state, relay, tracker, autoCamera, userStopped, visible }) {
  if (userStopped || !visible) return false;
  const live = Boolean(state.tracking && !state.synthetic);
  if (!live && !cameraWanted(state.settings)) return false;
  relay.stop({ forget: false, why: 'rearm' });
  tracker.stop();
  // Synthetic stays, so the view is honest: nothing is a camera until the next relay frame lands.
  if (state.cameraSource === 'relay' || state.cameraSource === 'device') state.cameraSource = 'none';
  if (state.anchors === 'camera') state.anchors = 'none';
  return autoCamera();
}
