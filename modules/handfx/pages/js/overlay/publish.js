// Publishes this page's own picture to the ShockBox Virtual Camera pipe, when the operator sets
// `publish` to `raw` (the camera) or `effects` (the camera with the effects burned in).
//
// Who owns what: the server owns the pipe and the geometry (it reads the same format.ini the
// virtual-camera source advertises, and reports it on /status as `publish.geometry`); this file
// only turns the page's picture into the size the server asks for and POSTs the RGBA bytes. The
// server converts to NV12 — doing it here would cost the page more than the transfer saves.
//
// Off by default and free when off: no canvas, no timer, no fetch until the mode is not `off`.
// The picture never leaves the machine, is never stored, and is dropped by the server when no
// consumer is reading the pipe.

/**
 * @param {object} opts
 * @param {() => (HTMLVideoElement|HTMLCanvasElement|null)} opts.source  what to send: the camera
 *   element (never in the DOM), or the relay's frame canvas
 * @param {() => HTMLCanvasElement|null} opts.fx    the effects canvas to burn in
 * @param {() => object} opts.settings              the page's copy of the settings document
 */
export function createPublisher({ source, fx, settings, log = () => {} }) {
  let mode = 'off';
  let geom = null; // { width, height, fps } — the server's, not ours
  let surface = null; // offscreen 2D canvas, one per geometry
  let ctx = null;
  let inflight = false;
  let last = 0;
  let timer = null; // the publish clock; see arm()
  let timerFps = 0;
  const sent = { ok: 0, failed: 0, skipped: 0 };

  /**
   * The publish clock. `setInterval`, not `requestAnimationFrame`: rAF only runs while the browser
   * paints, so an OBS browser source whose scene is hidden (or whose compositor is paused) stops
   * ticking while its `fetch` stream and its timers keep delivering — publishing froze at a fixed
   * frame count with no error anywhere. A timer survives that; a paint callback does not.
   */
  function arm() {
    const fps = mode === 'off' || !ctx ? 0 : Math.max(1, geom.fps || 30);
    if (timer && timerFps === fps) return;
    if (timer) clearInterval(timer);
    timer = null;
    timerFps = 0;
    if (!fps) return; // off: no timer, no canvas, no fetch — the same nothing as before
    timerFps = fps;
    timer = setInterval(() => tick(performance.now()), Math.round(1000 / fps));
  }

  /** Take the mode and geometry from a /status document (the only source of both). */
  function fromStatus(status) {
    const pub = status && status.publish;
    const next = pub && (pub.mode === 'raw' || pub.mode === 'effects') ? pub.mode : 'off';
    const g = pub && pub.geometry ? pub.geometry : null;
    if (next !== 'off' && (!g || !g.width || !g.height)) {
      // A publisher with no geometry has nothing to send: stay off instead of guessing a size.
      mode = 'off';
      arm();
      return;
    }
    mode = next;
    if (mode === 'off') {
      geom = null;
      surface = null;
      ctx = null;
      arm();
      return;
    }
    if (!geom || geom.width !== g.width || geom.height !== g.height || geom.fps !== g.fps) {
      geom = { width: g.width, height: g.height, fps: g.fps || 30 };
      surface = document.createElement('canvas');
      surface.width = geom.width;
      surface.height = geom.height;
      // A readback every frame: a software canvas beats a GPU canvas that has to stall to answer.
      ctx = surface.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    arm();
  }

  /**
   * Anything with a picture in it: a playing <video> (readyState and videoWidth), or a source that
   * carries its own size (a canvas, an ImageBitmap). One predicate, because the relay path hands
   * over its frame canvas and the device path its video element.
   */
  function drawable(el) {
    if (!el) return false;
    if (el.readyState !== undefined) return el.readyState >= 2 && el.videoWidth > 0;
    return el.width > 0 && el.height > 0;
  }

  /** Compose one frame. Returns false when there is no picture to send (camera not running). */
  function compose() {
    const el = source();
    if (!drawable(el)) return false;
    const { width: w, height: h } = geom;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; // the camera is opaque; the effects layer is not
    ctx.fillRect(0, 0, w, h);
    // Mirroring happens once, for the camera image: the effects canvas is already drawn in page
    // space, so mirroring it again would put the fire on the wrong hand.
    if (settings().mirror !== false) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(el, 0, 0, w, h);
    ctx.restore();
    if (mode === 'effects') {
      const fxCanvas = fx();
      if (fxCanvas && fxCanvas.width) ctx.drawImage(fxCanvas, 0, 0, w, h);
    }
    return true;
  }

  /**
   * Called from the render loop. Sends at most one frame per interval and never queues: while a
   * POST is in flight the next tick is skipped, which is what keeps a slow pipe from building a
   * backlog of stale pictures.
   */
  function tick(now) {
    if (mode === 'off' || !ctx || inflight) return;
    const period = 1000 / (geom.fps || 30);
    if (now - last < period - 2) return;
    if (!compose()) {
      sent.skipped++;
      return;
    }
    last = now;
    let data;
    try {
      data = ctx.getImageData(0, 0, geom.width, geom.height).data;
    } catch (err) {
      log('publish: readback failed', err && err.message);
      return;
    }
    inflight = true;
    fetch(`/api/handfx/frame?kind=${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
      cache: 'no-store',
      // The page is being torn down or the camera changed: a failed POST is not page state.
    })
      .then((res) => {
        if (res.ok) sent.ok++;
        else sent.failed++;
      })
      .catch(() => {
        sent.failed++;
      })
      .finally(() => {
        inflight = false;
      });
  }

  /**
   * Ask for a frame now, from whatever just received a picture. A kick is not a second clock: it
   * goes through the same `tick`, its rate limit and its one-in-flight rule, so a kick during a
   * running timer posts nothing extra, and a kick on a paused page still ships the newest frame.
   */
  function kick() {
    tick(performance.now());
  }

  return { fromStatus, tick, kick, stats: () => ({ ...sent, mode, clock: timer ? 'timer' : 'off' }) };
}
