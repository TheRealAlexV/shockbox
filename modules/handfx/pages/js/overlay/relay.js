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
export function createRelay({ url = '/api/handfx/camera/stream', onFrame, onState = () => {}, timeout = ACQUIRE_TIMEOUT } = {}) {
  let ctrl = null; // AbortController of the live fetch
  let wanted = false; // the page asked for frames (so a hidden tab can resume)
  let live = false;
  let current = null; // newest ImageBitmap, closed when replaced
  let latest = null; // newest undecoded JPEG
  let decoding = false;
  let error = null;
  let frames = 0;
  let dropped = 0;
  let firstWaiter = null;
  let stallTimer = null;

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
    if (ctrl) {
      ctrl.abort();
      ctrl = null;
    }
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
    // A stall during acquisition must end `start()`'s wait now, not at its own timeout.
    if (firstWaiter) {
      const w = firstWaiter;
      firstWaiter = null;
      w(false);
    }
    if (current) {
      current.close();
      current = null;
    }
    emit('error');
  }

  function stop({ forget = true } = {}) {
    if (forget) wanted = false;
    close();
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
  }

  async function decode(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (!ctrl) {
      // The stream died while this was decoding: drawing it now would revive the frozen frame.
      bitmap.close();
      return;
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
  }

  /** Decode the newest frame, then the one that arrived while we were busy. */
  async function drain() {
    if (decoding) return;
    decoding = true;
    try {
      while (latest && ctrl) {
        const bytes = latest;
        latest = null;
        await decode(bytes);
        if (!live) {
          live = true;
          error = null;
          emit('live');
          if (firstWaiter) {
            const w = firstWaiter;
            firstWaiter = null;
            w(true);
          }
        }
      }
    } catch (err) {
      if (ctrl) fail(`relay: ${err && err.message ? err.message : err}`);
    } finally {
      decoding = false;
    }
  }

  async function read(res, ac) {
    const reader = res.body.getReader();
    const parser = new MultipartFrames();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const jpeg of parser.push(value)) {
        if (latest) dropped += 1; // the decoder was still busy: keep only the newest
        latest = jpeg;
        armStall();
        if (!decoding) void drain();
      }
    }
    // A clean EOF is the camera going away too: without this the page kept the last frame and
    // went on reporting itself live forever.
    if (!ac.signal.aborted && ctrl) fail('relay: stream ended');
  }

  async function start() {
    wanted = true;
    if (document.visibilityState === 'hidden') return false;
    if (ctrl) return live;
    const ac = new AbortController();
    ctrl = ac;
    error = null;
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        cache: 'no-store',
        headers: { accept: 'multipart/x-mixed-replace' },
      });
      if (!res.ok) throw new Error(`stream answered ${res.status}`);
      if (!res.body) throw new Error('stream carried no body');
      const type = res.headers.get('content-type') || '';
      if (!/multipart\/x-mixed-replace/i.test(type)) throw new Error(`unexpected content-type ${type || '(missing)'}`);
      // The connection is open: from here on, 3 s without a complete frame is a dead camera.
      armStall();
      // Losing the connection after the first frame is a state change, not a start failure.
      void read(res, ac).catch((err) => {
        if (ac.signal.aborted || !ctrl) return;
        fail(`relay: ${err && err.message ? err.message : err}`);
      });
      const got = await new Promise((resolve) => {
        firstWaiter = resolve;
        setTimeout(() => {
          if (firstWaiter) {
            firstWaiter = null;
            resolve(false);
          }
        }, timeout);
      });
      if (!got && error) return false; // the stall already reported through fail()
      if (!got) throw new Error(`no frame within ${Math.round(timeout / 1000)} s`);
      return true;
    } catch (err) {
      close();
      live = false;
      error = ac.signal.aborted && !err.message ? 'relay: aborted' : `relay: ${err && err.message ? err.message : err}`;
      emit('error');
      return false;
    }
  }

  // A hidden document keeps no connection open: the server would only buffer frames nobody draws.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (ctrl) {
        close();
        live = false;
        emit('idle');
      }
    } else if (wanted && !ctrl) {
      void start();
    }
  });
  // `pagehide` drops the connection but never forgets that the page wants frames: an OBS browser
  // source that is hidden and shown again (bfcache) reacquired on the visibilitychange above, but
  // `stop()` with its default `forget: true` cleared `wanted` and nothing could ever start again —
  // that is how the relay sat at 0 clients while publish still had a reader.
  window.addEventListener('pagehide', () => stop({ forget: false }));
  window.addEventListener('pageshow', () => {
    if (wanted && !ctrl && document.visibilityState !== 'hidden') void start();
  });

  return {
    start,
    stop,
    /** Frames are flowing and `onFrame` is being called. */
    isLive: () => live && Boolean(current),
    /** Why the stream is not live (string), null while it is. */
    reason: () => error,
    stats: () => ({ frames, dropped, live }),
  };
}
