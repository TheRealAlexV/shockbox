// One SSE hub for every module. Named channels; per-channel ring for replay with ?since=.
//
// Why one hub and not one EventSource per module: OBS CEF caps HTTP/1.1 connections per host at
// 6. The wall page alone opens one, and HandFX would open several more — a single stream that
// carries every channel keeps the count at one per page no matter how many modules exist.

const RING_MAX = 400;
const HEARTBEAT_MS = 15_000;
const CLIENT_BLOCK_MAX_MS = 20_000;
const CLIENT_BUFFER_MAX = 4 * 1024 * 1024;
// Identifies this process. Sent in every `hello` so a reconnecting page can tell
// "the server restarted" from "I missed frames".
const BOOT = `${Date.now().toString(36)}-${process.pid}`;

export function createEvents({ log }) {
  const clients = new Map();
  const rings = new Map(); // channel -> [{seq, channel, cmd, args, view}]
  const seqByChannel = new Map();
  const subs = new Map(); // "channel|view" -> Set<fn>  (in-process module subscribers)
  let clientSeq = 0;

  function ring(ch) {
    let r = rings.get(ch);
    if (!r) {
      r = [];
      rings.set(ch, r);
    }
    return r;
  }

  function nextSeq(ch) {
    const n = (seqByChannel.get(ch) || 0) + 1;
    seqByChannel.set(ch, n);
    return n;
  }

  // Two event names, on purpose:
  //   `message`      — a plain frame for legacy clients (popup overlays' `es.onmessage`);
  //   `<channel>`    — the same frame, typed, so a page with several frame kinds on one channel
  //                    (the wall: `cmd` and `state.snapshot`) can listen per kind.
  //   `reset`        — the hub dropped this client's cursor; no data, the page must resync.
  function frame(ch, rec) {
    const data = JSON.stringify(rec);
    const typed = rec.reset ? 'reset' : ch;
    return `event: message\ndata: ${data}\n\nevent: ${typed}\ndata: ${data}\n\n`;
  }

  function write(c, text) {
    if (c.dead) return false;
    try {
      if (c.res.writableLength > CLIENT_BUFFER_MAX) {
        drop(c, 'backpressure');
        return false;
      }
      c.res.write(text);
      return true;
    } catch {
      drop(c, 'write failed');
      return false;
    }
  }

  function drop(c, why) {
    if (c.dead) return;
    c.dead = true;
    clients.delete(c.id);
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
    log.info(`sse client #${c.id} ${c.channels} dropped (${why}), ${clients.size} left`);
  }

  /** Publish a command frame to one channel. view scopes delivery (wall has landscape|portrait). */
  function publish(channel, cmd, args = {}, view = null) {
    // A caller that passes a pre-built frame (`{seq, cmd, args}`) is asking for that seq to be
    // kept — the wall's own ring already numbered it. Otherwise the hub numbers it.
    const rec = args && typeof args === 'object' && args.seq !== undefined && args.cmd !== undefined
      ? { ...args, channel, view: args.view === undefined ? view : args.view }
      : { seq: nextSeq(channel), channel, cmd, args, view };
    if (rec.seq === undefined || rec.seq === null) rec.seq = nextSeq(channel);
    const r = ring(channel);
    r.push(rec);
    if (r.length > RING_MAX) r.shift();
    for (const c of clients.values()) {
      if (!c.channels.has(channel)) continue;
      if (view && c.view && c.view !== view) continue;
      write(c, frame(channel, rec));
    }
    for (const fn of subs.get(`${channel}|${view || ''}`) || []) {
      try {
        fn(rec);
      } catch (err) {
        log.error(`subscriber threw on ${channel}: ${err.message}`);
      }
    }
    for (const fn of subs.get(`${channel}|`) || []) {
      try {
        fn(rec);
      } catch (err) {
        log.error(`subscriber threw on ${channel}: ${err.message}`);
      }
    }
    return rec;
  }

  /** Publish a state-ish record (not replayable). Honours `view` exactly like publish(). */
  function emit(channel, event, data, view = null) {
    const json = JSON.stringify(data);
    // `message` too, so an onmessage client that only knows the plain frame still sees state.
    const text = `event: message\ndata: ${json}\n\nevent: ${event}\ndata: ${json}\n\n`;
    for (const c of clients.values()) {
      if (!c.channels.has(channel)) continue;
      if (view && c.view && c.view !== view) continue;
      write(c, text);
    }
    for (const fn of subs.get(`${channel}|${view || ''}`) || []) {
      try {
        fn({ event, data });
      } catch {
        /* ignore */
      }
    }
    for (const fn of subs.get(`${channel}|`) || []) {
      try {
        fn({ event, data });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Latest-only publish: the frame is NOT put in the ring. For state that is re-read on
   * connect anyway (wall settings, camera status) this stops a 30 Hz stream from filling
   * the ring and from being replayed as a burst on reconnect.
   */
  function latest(channel, cmd, args = {}, view = null) {
    const rec = { seq: seqByChannel.get(channel) || 0, channel, cmd, args, view, latest: true };
    for (const c of clients.values()) {
      if (!c.channels.has(channel)) continue;
      if (view && c.view && c.view !== view) continue;
      write(c, frame(channel, rec));
    }
    for (const fn of subs.get(`${channel}|${view || ''}`) || []) {
      try {
        fn(rec);
      } catch {
        /* ignore */
      }
    }
    return rec;
  }

  function subscribe(channel, fn, view = null) {
    const key = `${channel}|${view || ''}`;
    let set = subs.get(key);
    if (!set) {
      set = new Set();
      subs.set(key, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Attach an SSE response. `channels` is the set this client wants.
   * Replay: each channel's ring is sent from ?since= (or the whole ring, capped) before live frames.
   */
  function attach(req, res, { channels, view = null, since = null, client = null }) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 1500\n\n');
    const c = {
      id: ++clientSeq,
      res,
      channels: new Set(channels),
      view,
      remote: client || req.socket?.remoteAddress || '?',
      dead: false,
    };
    clients.set(c.id, c);
    // `boot` is the process-start token: a client from an earlier process cannot use its
    // `since` against a fresh ring (seq restarts at 1), so it is told to resync instead of
    // silently replaying nothing and believing it is current.
    const hello = { client: c.id, channels: [...c.channels], view, boot: BOOT, seqs: {} };
    for (const ch of c.channels) hello.seqs[ch] = seqByChannel.get(ch) || 0;
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    for (const ch of c.channels) {
      const r = ring(ch);
      const from = since === null || since === undefined ? null : Number(since);
      // An old `since` (greater than the newest seq we have) is a stale client from a prior
      // process: send a reset and no replay, so the page re-reads its state over HTTP.
      if (from !== null && from > (seqByChannel.get(ch) || 0)) {
        write(c, frame(ch, { reset: true, reason: 'stale-since', seq: 0 }));
        continue;
      }
      const start = from === null ? 0 : Math.max(0, r.length - Math.min(r.length, RING_MAX));
      for (let i = 0; i < r.length; i += 1) {
        const rec = r[i];
        if (from !== null && rec.seq <= from) continue;
        if (from === null && i < start) continue;
        if (rec.view && view && rec.view !== view) continue;
        if (!write(c, frame(ch, rec))) break;
      }
    }
    log.info(`sse client #${c.id} ${[...c.channels]} view=${view || '*'} from ${c.remote}`);
    req.on('close', () => drop(c, 'client closed'));
    return c;
  }

  const heartbeat = setInterval(() => {
    for (const c of [...clients.values()]) {
      if (c.res.writableLength > CLIENT_BUFFER_MAX) {
        drop(c, 'backpressure');
        continue;
      }
      try {
        c.res.write(': ping\n\n');
      } catch {
        drop(c, 'ping failed');
      }
    }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const c of [...clients.values()]) {
      if (c.res.writableLength > CLIENT_BUFFER_MAX) drop(c, 'backpressure');
      else if (c.born === undefined) c.born = now;
    }
  }, 5000);
  if (sweeper.unref) sweeper.unref();

  return {
    attach,
    publish,
    latest,
    emit,
    subscribe,
    newestSeq(ch) {
      return seqByChannel.get(ch) || 0;
    },
    get clientCount() {
      return clients.size;
    },
    clientsByChannel() {
      const out = {};
      for (const c of clients.values()) for (const ch of c.channels) out[ch] = (out[ch] || 0) + 1;
      return out;
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const c of [...clients.values()]) drop(c, 'server closing');
    },
  };
}
