// The relay's multipart frame reader, shared by tools/handfx-capture.mjs and
// tools/handfx-diag.mjs.
//
// GET /api/handfx/camera/stream is `multipart/x-mixed-replace; boundary=framebound`, each part
// carrying one JPEG and a `content-length`. The relay allows one producer and N readers, so a
// second reader is safe and costs the source nothing.
//
// relayFrames() yields one Buffer per JPEG. It never buffers a part across a chunk boundary
// incorrectly: a part split mid-header or mid-body is kept and resumed, and a part without
// content-length is skipped. Falling behind does not stall the socket forever — the caller owns
// the queue (see `depth` in the callers), because a slow reader makes the relay drop frames for
// this client, which would silently turn a 30 fps feed into a 1 fps one.

const BOUNDARY = '--framebound';

/**
 * @param {{url: string, signal?: AbortSignal, idleMs?: number, boundary?: string, onNote?: (msg: string) => void}} opts
 *   url     — the full stream URL (already includes any query)
 *   signal  — caller's abort signal; aborting ends the generator quietly
 *   idleMs  — hang up if nothing arrives for this long (the server caps a stream at 120 s)
 *   onNote  — receives non-fatal notes (bad response body, malformed part)
 */
export async function* relayFrames({ url, signal, idleMs = 125_000, boundary = BOUNDARY, onNote = () => {} }) {
  const local = new AbortController();
  const timer = setTimeout(() => local.abort(new Error(`relay idle for ${idleMs} ms`)), idleMs);
  const onStop = () => local.abort(signal.reason);
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener('abort', onStop, { once: true });
  }
  const bufBoundary = Buffer.from(boundary);
  try {
    const res = await fetch(url, {
      signal: local.signal,
      headers: { accept: 'multipart/x-mixed-replace' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    let buf = Buffer.alloc(0);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = buf.length ? Buffer.concat([buf, Buffer.from(value)]) : Buffer.from(value);

      for (;;) {
        const idx = buf.indexOf(bufBoundary);
        if (idx < 0) {
          if (buf.length > 1 << 20) buf = buf.subarray(buf.length - 1024);
          break;
        }
        const afterBoundary = idx + bufBoundary.length;
        const headEnd = buf.indexOf('\r\n\r\n', afterBoundary);
        if (headEnd < 0) {
          // Keep everything from the boundary: the part's headers are still in flight.
          if (idx > 0) buf = buf.subarray(idx);
          break;
        }
        const head = buf.subarray(afterBoundary, headEnd).toString('latin1');
        const m = /content-length:\s*(\d+)/i.exec(head);
        if (!m) { buf = buf.subarray(headEnd + 4); continue; }
        const len = Number(m[1]);
        const bodyStart = headEnd + 4;
        if (buf.length < bodyStart + len) {
          // Same rule for the body: a part split across chunks must not be skipped.
          if (idx > 0) buf = buf.subarray(idx);
          break;
        }
        const jpeg = buf.subarray(bodyStart, bodyStart + len);
        buf = buf.subarray(bodyStart + len);
        yield jpeg;
      }
    }
  } catch (err) {
    if (local.signal.aborted && signal && signal.aborted) return; // the caller stopped us
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onStop);
  }
}
