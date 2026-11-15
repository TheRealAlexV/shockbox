// The overlay's camera, relayed.
//
// On the rig every physical camera is held by WebcamSwitcher, and Chromium hands out no usable
// `deviceId` before a successful grant, so `getUserMedia` on this page always fails with
// NotReadableError. The server therefore runs ffmpeg on the `WebcamSwitcher Virtual Camera` and
// serves the result as multipart MJPEG; the page reads that stream instead of fighting for the
// device.
//
// Frames are parsed here rather than handed to an <img>, because they have to reach a canvas (the
// tracker draws them at its own size and runs the same detect call as the device path). Only the
// newest frame is decoded: a JPEG that arrives while the decoder is busy is dropped, and every
// replaced ImageBitmap is closed, so a long session leaks no memory.
//
// Pausing is dropping the connection: the server then writes to nobody, which is also what makes
// a `pagehide` cheap. Resume is one more `fetch` — no state to repair.

const BOUNDARY = '--framebound';
const HEADERS_END = Uint8Array.of(13, 10, 13, 10);
const ACQUIRE_TIMEOUT = 10000;
/** Frames that stop arriving are a dead camera: 3 s of silence fails the stream and hands the view
 * back to the page's fallback instead of freezing on the last picture. */
const STALL_TIMEOUT = 3000;
const MAX_HEADER = 8192;

function indexOf(hay, needle, from = 0) {
  const last = hay.length - needle.length;
  outer: for (let i = from; i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * A multipart/x-mixed-replace reader that speaks this server's framing:
 *
 *   --framebound CRLF
 *   Content-Type: image/jpeg CRLF
 *   Content-Length: <N> CRLF
 *   CRLF
 *   <N bytes of JPEG> CRLF
 *
 * The framing rule: the boundary is a marker, the header block ends at the first CRLFCRLF, and
 * `Content-Length` is the only thing that says where the image ends — never a scan for the next
 * boundary, because JPEG bytes may contain anything. A part with no length is unframeable and is
 * skipped to the next marker. Anything before the first marker (a preamble) is discarded.
 */
export class MultipartFrames {
  constructor(boundary = BOUNDARY) {
    this.marker = new TextEncoder().encode(boundary);
    this.buf = new Uint8Array(0);
    this.inPart = false;
  }

  push(chunk) {
    if (!chunk || !chunk.length) return [];
    const buf = new Uint8Array(this.buf.length + chunk.length);
    buf.set(this.buf, 0);
    buf.set(chunk, this.buf.length);
    this.buf = buf;
    const out = [];
    for (;;) {
      if (!this.inPart) {
        const at = indexOf(this.buf, this.marker, 0);
        if (at < 0) {
          // Keep only as much tail as a marker split across two chunks could need.
          if (this.buf.length > this.marker.length) this.buf = this.buf.slice(this.buf.length - this.marker.length + 1);
          return out;
        }
        this.buf = this.buf.subarray(at + this.marker.length);
        this.inPart = true;
      }
      const head = indexOf(this.buf, HEADERS_END, 0);
      if (head < 0) {
        if (this.buf.length > MAX_HEADER) throw new Error('malformed part: header block never ended');
        return out;
      }
      const headers = new TextDecoder('latin1').decode(this.buf.subarray(0, head));
      const len = /content-length:\s*(\d+)/i.exec(headers);
      const start = head + HEADERS_END.length;
      if (!len) {
        // No length: this part cannot be framed. Resync on the next marker.
        this.buf = this.buf.subarray(start);
        this.inPart = false;
        continue;
      }
      const size = Number(len[1]);
      if (this.buf.length < start + size) return out; // wait for the rest of the image
      out.push(this.buf.slice(start, start + size));
      let next = start + size;
      // The CRLF that closes the part is framing, not image data.
      if (this.buf[next] === 13 && this.buf[next + 1] === 10) next += 2;
      this.buf = this.buf.subarray(next);
      this.inPart = false;
    }
  }
}

/**
 * Read the server's relayed camera. `onFrame(bitmap)` is called synchronously with the newest
 * frame (draw it now; it is closed when the next one replaces it), `onState({ state, error,
 * frames, dropped })` whenever the stream comes up or goes away.
 *
 *   const relay = createRelay({ onFrame, onState });
 *   if (await relay.start()) …   // true once a frame was decoded
 */
export function createRelay({ url = '/api/handfx/camera/stream', onFrame, onState = () => {}, onEvent = null, timeout = ACQUIRE_TIMEOUT } = {}) {
  let ctrl = null; // AbortController of the live fetch
  // Identity of the current connection. Bumped whenever one starts or ends, so a frame can carry
  // the connection that received it: `ctrl` alone cannot tell "the stream I came from is gone" from
  // "some other stream is current now", and a decode that outlives its own connection used to
  // report an attach for it. See `decode` and `drain`.
  let gen = 0;
  let wanted = false; // the page asked for frames (so a hidden tab can resume)
  let live = false;
  let current = null; // newest ImageBitmap, closed when replaced
  let latest = null; // newest undecoded JPEG
  let decoding = false;
  let error = null;
  // Set only by the benign 503: no frame yet, or the relay is off. It is a reason for `/status`,
  // never an error state — `error` is what turns the page's own view red.
  let waiting = null;
  let frames = 0;
  let dropped = 0;
  let firstWaiter = null;
  let stallTimer = null;
  let retryTimer = null; // a pending re-open (see `wantReopen`)
  let retryDelay = 0; // 0 = the next re-open is immediate
  const RETRY_BASE = 500;
  const RETRY_MAX = 15000;
  /** A stream must have lived this long before its close earns an immediate re-open. */
  const RELIVE_MIN_MS = 2000;

  let liveSince = 0;

  /**
   * Report one transition to the page's event channel (`POST /api/handfx/page-event`), which the
   * server writes to its log. The relay's console output is invisible to anything reading the node
   * log, so a feed that died and never re-opened left no trace and a phantom reload loop was read
   * into the silence. One line per transition, never per frame.
   */
  function note(transition, detail = '') {
    try {
      if (typeof onEvent === 'function') onEvent(transition, detail);
    } catch {
      /* a report must never break the stream it describes */
    }
  }

  function emit(state) {
    try {
      onState({ state, error, frames, dropped });
    } catch {
      /* the page's consumer must not break the stream */
    }
  }

  function clearStall() {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  }

  /** Re-arm the silence clock; any complete frame resets it. */
  function armStall() {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (ctrl) fail(`relay: no frame for ${Math.round(STALL_TIMEOUT / 1000)} s`);
    }, STALL_TIMEOUT);
  }

  function close() {
    clearStall();
    // The connection ends here: every frame already received from it is now stale, including one
    // that is still decoding. Bumping the generation is what makes `decode` able to see that.
    gen += 1;
    // Drop the queued frame with the connection: `drain()` would otherwise hand the old stream's
    // last JPEG to the new one, inflating `dropped` on every reconnect and painting a stale frame
    // across the gap.
    latest = null;
    if (ctrl) {
      ctrl.abort();
      ctrl = null;
    }
  }

  function cancelReopen() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  /**
   * The page's own way back to the stream. The server ends every camera stream at its max age
   * (`CAMERA_MAX_MS`), so a healthy page sees a clean EOF every two minutes *by design*; an OBS
   * browser source must not depend on an event (visibilitychange, pageshow) arriving to ask again,
   * because none does while it is on screen. This is the re-open path, and it is bounded: 0.5 s
   * doubling to 15 s while `wanted`, never a tight loop, cancelled by `stop()`.
   *
   * Without it the max-age close was the end of the feed: the clean-EOF branch got exactly one
   * `acquire()`, and one failed re-fetch (producer restarting, a 503, a reset) left `error` set
   * with nothing left to try — 0 clients, `demand` still true, and the page drawing synthetic
   * hands for the rest of the session.
   */
  function wantReopen(immediate = false) {
    if (!wanted || ctrl || retryTimer) {
      // Worth a line: a suppressed re-open is the silence that hid the dead feed.
      note('reopen-suppressed', `wanted=${wanted} ctrl=${Boolean(ctrl)} pending=${Boolean(retryTimer)}`);
      return;
    }
    let delay = 0;
    if (!immediate) {
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : RETRY_BASE, RETRY_MAX);
      delay = retryDelay;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!wanted || ctrl) return;
      void start().then((ok) => {
        if (ok) {
          retryDelay = 0;
          return;
        }
        // A failed attempt must not be the last word either: `start()` resolved false because
        // nothing decoded, and the next try backs off.
        wantReopen();
      });
    }, delay);
    note('retry-scheduled', `${delay} ms immediate=${Boolean(immediate)}`);
    if (retryTimer.unref) retryTimer.unref();
  }

  /**
   * The stream is gone — a clean EOF or a read error, they are the same event to this page. Drop
   * the connection, the held frame and the claim that anything is live, so the page stops drawing
   * a frozen picture and its fallback path can run.
   */
  function fail(message) {
    close();
    live = false;
    latest = null;
    error = message;
    note('failed', message);
    // A stall during acquisition must end `start()`'s wait now, not at its own timeout.
    if (firstWaiter) {
      const w = firstWaiter;
      firstWaiter = null;
      w.resolve(false);
    }
    if (current) {
      current.close();
      current = null;
    }
    emit('error');
  }

  function stop({ forget = true, why = 'unspecified' } = {}) {
    if (forget) wanted = false;
    note('stop', `forget=${forget} wanted=${wanted} why=${why}`);
    // A pending re-open belongs to the intent being stopped: a page that forgot the stream must not
    // be reopened by a timer it no longer owns.
    cancelReopen();
    close();
    starting = null; // a start after a stop opens a fresh connection, not the aborted one
    latest = null;
    if (current) {
      current.close();
      current = null;
    }
    if (live || error) {
      live = false;
      emit('idle');
    }
    live = false;
    // A stop that keeps `wanted` means the page still wants frames, so something must own the
    // resume. `pagehide` has `pageshow`; every other caller gets the ordinary backoff here. Without
    // this a teardown left `wanted` true with no socket and no timer, and only `start()` could ever
    // leave that state — which is how a live, drawing page sat at zero stream clients.
    if (wanted && why !== 'pagehide') wantReopen();
  }

  async function decode(bytes, conn) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    // Staleness is about *this frame's* connection, not about whether anything is current: a decode
    // can outlive its own connection (the server's max-age EOF lands inside one every two minutes)
    // and a newer connection can already own `ctrl` when it resolves. Both drop here.
    if (!ctrl || conn !== gen) {
      // The stream died while this was decoding: drawing it now would revive the frozen frame.
      bitmap.close();
      return false;
    }
    const prev = current;
    current = bitmap;
    frames += 1;
    try {
      onFrame(bitmap);
    } finally {
      // Synchronous consumer: the previous frame has been drawn, nothing else can hold it.
      if (prev) prev.close();
    }
    return true;
  }

  /** Decode the newest frame, then the one that arrived while we were busy. */
  async function drain() {
    if (decoding) return;
    decoding = true;
    let conn = -1; // the connection of the frame being decoded, for the catch below
    try {
      while (latest && ctrl) {
        const frame = latest;
        latest = null;
        conn = frame.conn;
        if (!(await decode(frame.bytes, conn))) continue;
        // Only the connection that is still current may report an attach: a frame from a closed one
        // used to set `live` here, cancel the reopen the EOF had just scheduled, and leave the page
        // claiming a feed with no socket behind it.
        if (conn === gen && !live) {
          live = true;
          error = null;
          waiting = null;
          liveSince = Date.now();
          // A frame arrived: the next drop (including the server's max-age close) reopens at once.
          retryDelay = 0;
          cancelReopen();
          emit('live');
          note('attached', `frames=${frames} dropped=${dropped}`);
          if (firstWaiter && firstWaiter.conn === conn) {
            const w = firstWaiter;
            firstWaiter = null;
            w.resolve(true);
          }
        }
      }
    } catch (err) {
      // An error from a dead connection's frame must not fail the one that is current.
      if (ctrl && conn === gen) fail(`relay: ${err && err.message ? err.message : err}`);
    } finally {
      decoding = false;
    }
  }

  async function read(res, ac, conn) {
    const reader = res.body.getReader();
    const parser = new MultipartFrames();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const jpeg of parser.push(value)) {
        if (latest) dropped += 1; // the decoder was still busy: keep only the newest
        // The frame carries the connection that received it: a decode that outlives this one must
        // not be mistaken for the current stream's (see `decode`).
        latest = { bytes: jpeg, conn };
        // The silence clock belongs to a connection too, and this was the one consumer of a frame's
        // identity that did not check it: a part from a connection that is no longer current must
        // not re-arm the clock for whichever one replaced it. Same rule as the live block below.
        if (conn === gen) armStall();
        if (!decoding) void drain();
      }
    }
    // A clean end is the server's CAMERA_MAX_MS cap expiring, not a dead camera: reconnect.
    if (!ac.signal.aborted && ctrl === ac) {
      note('closed', `clean eof, server max age; frames=${frames} wanted=${wanted}`);
      close();
      // Say the stream ended. Without this the page kept `live` true across the gap, so its own
      // state and /status claimed a relay feed while nothing was arriving, and the page was never
      // told the feed came back (`cameraLive()` re-arms the backoff on every `live`). A page-side
      // 'idle' is not an error: recovery is the re-open below, not a guess by the page.
      if (live) {
        live = false;
        emit('idle');
      }
      // The server ends every stream at its max age, so this is the healthy path back, not the end:
      // reopen at once (the socket is free and the server is up) with the retry loop behind it.
      if (wanted) wantReopen(Date.now() - liveSince > RELIVE_MIN_MS);
      else note('reopen-refused', 'wanted=false: the page was told to forget the stream');
    }
  }

  /**
   * One acquisition, and every caller shares it. A retry that lands while the previous `fetch` is
   * still opening used to see `ctrl` set and `live` false, report the stream dead, and start a
   * second connection on top of the first — which is how a retry loop ends up fighting itself.
   * `ac` is kept local so a stale acquisition cannot abort the controller of a newer one.
   */
  async function acquire() {
    const ac = new AbortController();
    ctrl = ac;
    // A new connection is a new identity: frames from the one before it are stale from here on.
    gen += 1;
    const conn = gen;
    error = null;
    // Every other bound here starts after the response exists: the first-frame wait below, the 3 s
    // stall timer. A `fetch` that never returns headers is therefore unbounded, and a hung
    // acquisition leaves `starting` set forever — nothing retries a promise that never settles. One
    // re-acquire after the max-age EOF did exactly that and the relay was silent for seven minutes.
    // `timedOut` separates this abort from the page's own (`stop()`, a re-arm), which stays silent.
    let timedOut = false;
    const acquireTimer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, ACQUIRE_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        cache: 'no-store',
        headers: { accept: 'multipart/x-mixed-replace' },
      });
      // Headers are in; the first-frame wait owns the rest of the bound from here.
      clearTimeout(acquireTimer);
      // 503 is the server's own "nothing to serve yet", not a fault: `no camera frame yet` while
      // ffmpeg warms up, and `camera relay is off` when the producer is not armed. Both are states
      // the overlay covers by drawing synthetic, so they are reported as a quiet wait and retried on
      // the ordinary backoff — surfacing them as `error` turned a normal boot into a red banner and
      // tore down a view that was working fine without the camera.
      if (res.status === 503) {
        if (ctrl === ac) close();
        live = false;
        waiting = 'relay 503: no camera frame yet (or the relay is off)';
        error = null;
        note('waiting', `${waiting} — drawing synthetic, retrying`);
        emit('idle');
        if (wanted) wantReopen();
        return false;
      }
      if (!res.ok) throw new Error(`stream answered ${res.status}`);
      if (!res.body) throw new Error('stream carried no body');
      const type = res.headers.get('content-type') || '';
      if (!/multipart\/x-mixed-replace/i.test(type)) throw new Error(`unexpected content-type ${type || '(missing)'}`);
      // The connection is open: from here on, 3 s without a complete frame is a dead camera.
      armStall();
      // Losing the connection after the first frame is a state change, not a start failure.
      void read(res, ac, conn).catch((err) => {
        if (ac.signal.aborted || !ctrl) return;
        fail(`relay: ${err && err.message ? err.message : err}`);
      });
      const got = await new Promise((resolve) => {
        // The waiter belongs to this connection: a frame from any other one must not resolve it,
        // and this acquisition's deadline must not resolve a newer acquisition's waiter.
        const waiter = { conn, resolve };
        firstWaiter = waiter;
        setTimeout(() => {
          if (firstWaiter === waiter) {
            firstWaiter = null;
            resolve(false);
          }
        }, timeout);
      });
      if (!got && error) return false; // the stall already reported through fail()
      if (!got) throw new Error(`no frame within ${Math.round(timeout / 1000)} s`);
      return true;
    } catch (err) {
      // A stop or a re-arm aborted this fetch: that is the page's intent, not a camera failure, so
      // it must not report an error the retry loop would then explain with "relay: aborted".
      if (ac.signal.aborted && !timedOut) {
        if (ctrl === ac) close();
        return false;
      }
      // A deadline abort is a failed acquisition like any other: it gets a reason and it owes the
      // feed a retry, so it must not read as the page's own abort above.
      const message = timedOut
        ? `relay: no response within ${Math.round(ACQUIRE_TIMEOUT / 1000)} s`
        : `relay: ${err && err.message ? err.message : err}`;
      if (ctrl === ac) close();
      live = false;
      error = message;
      note('failed', message);
      emit('error');
      // Nothing downstream owns the next attempt here: `start()`'s shared promise is about to clear,
      // and a caller that is not `wantReopen` would otherwise leave the feed down for good.
      if (wanted) wantReopen();
      return false;
    } finally {
      clearTimeout(acquireTimer);
    }
  }

  let starting = null;

  function start() {
    wanted = true;
    note('acquire', `wanted=true live=${live}`);
    // No visibility gate: an OBS browser source reports `hidden` whenever it is not in the
    // program, and that is exactly the page that must still open the relay — nothing here needs a
    // click, and the server stops ffmpeg by itself when the last client leaves.
    if (ctrl && live) return Promise.resolve(true);
    // A leftover controller whose stream never came up. Answering `false` here forever reconnected
    // nothing and failed nothing, so the page read "relay: no frames" until it was reloaded: tear
    // the dead stream down and acquire again.
    if (ctrl) {
      if (starting) return starting; // an acquisition is already opening: share it, never stack one
      console.log('handfx relay: stream open without a frame — re-acquiring');
      fail('relay: stream never produced a frame');
    }
    if (!starting) {
      starting = acquire().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  // A hidden document keeps its stream: an OBS browser source is hidden while its scene is not in
  // the program, and dropping the connection there is what left the relay with 0 clients. Coming
  // back only has to re-open what the page still wants.
  document.addEventListener('visibilitychange', () => {
    if (wanted && !ctrl) void start();
  });
  // `pagehide` drops the connection but never forgets that the page wants frames: an OBS browser
  // source that is hidden and shown again (bfcache) reacquired on the visibilitychange above, but
  // `stop()` with its default `forget: true` cleared `wanted` and nothing could ever start again —
  // that is how the relay sat at 0 clients while publish still had a reader.
  window.addEventListener('pagehide', () => stop({ forget: false, why: 'pagehide' }));
  window.addEventListener('pageshow', () => {
    if (wanted && !ctrl) void start();
  });

  return {
    start,
    stop,
    /** Frames are flowing and `onFrame` is being called. */
    isLive: () => Boolean(ctrl) && live && Boolean(current),
    /** Why the stream is not live (string), null while it is. `waiting` covers the benign 503. */
    reason: () => error || waiting,
    stats: () => ({ frames, dropped, live }),
  };
}
