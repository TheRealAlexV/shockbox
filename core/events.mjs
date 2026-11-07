// One SSE hub for every module. Named channels; per-channel ring for replay with ?since=.
//
// Why one hub and not one EventSource per module: OBS CEF caps HTTP/1.1 connections per host at
// 6. The wall page alone opens one, and HandFX would open several more — a single stream that
// carries every channel keeps the count at one per page no matter how many modules exist.

const RING_MAX = 400;
const HEARTBEAT_MS = 15_000;
const CLIENT_BLOCK_MAX_MS = 20_000;
const CLIENT_BUFFER_MAX = 4 * 1024 * 1024;
// No server-held connection may outlive SSE_MAX_MS, so a document that vanished without closing
// anything loses its bus slot on a timer rather than never. CEF keeps a navigated-away document's
// sockets in its per-origin pool (6 slots) with the response still ESTABLISHED; our heartbeat keeps
// writing into them, so the peer always accepts bytes and no inactivity timeout can ever notice.
// 5 min = 20 heartbeats: a healthy page reconnects three times an hour (hello + ring replay, cheap)
// and a leaked slot is back in the pool long before the operator gives up on the pane.
// SHOCKBOX_STREAM_MAX_MS is the test hook that shortens it (and handfx's camera cap) for a test.
const SSE_MAX_MS = Number(process.env.SHOCKBOX_STREAM_MAX_MS) || 300_000;
// Identifies this process. Sent in every `hello` so a reconnecting page can tell
// "the server restarted" from "I missed frames".
const BOOT = `${Date.now().toString(36)}-${process.pid}`;

/**
 * Which document a request belongs to, as far as the supersede rule below cares: one path, one
 * holder. A page declares it with `?role=` (the page path it was loaded at); `/shockfx/overlay`
 * is therefore the same identity before and after a reload, which is what lets the successor end
 * the predecessor's leaked stream. Bounded and charset-restricted because it is only ever echoed
 * into a log line.
 */
export function validRole(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._/-]{1,64}$/.test(value) ? value : null;
}

/** The identity a request declares on its own URL (`?role=`), or null. */
export function roleOf(req) {
  try {
    return validRole(new URL(req.url, 'http://localhost').searchParams.get('role'));
  } catch {
    return null;
  }
}

/**
 * The identity a request *inherits* from the document that made it: the referring URL's path.
 * A document cached from before `?role=` existed still names its own path here, so a successor
 * can supersede it on the first deploy after this rule ships — not just from the second.
 */
export function refPath(req) {
  const ref = req.headers?.referer;
  if (!ref) return null;
  try {
    return validRole(new URL(ref).pathname);
  } catch {
    return null;
  }
}

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

  /**
   * The same frame for a single connection. A command is scoped to a view
   * (`text.send` resolves to `landscape`), and that scope rides in the record — so relaying
   * the record itself would tell a `view=landscape` client about a portrait send, and the
   * engine keys its replay guard on `seq`, which would then skip the same command once it
   * legitimately reached that view. The scope is transport, not content: it is stripped here.
   */
  function frameFor(c, ch, rec) {
    // Downstream (the URL/query path, the overlay) reads `rec.view`; it is kept on the wire and
    // the consumer is expected to honour it. Only a record that would otherwise be dropped is
    // rewritten, so nothing already working changes shape.
    if (rec.view === null || rec.view === undefined || !c.view || c.view === rec.view) return frame(ch, rec);
    const out = { ...rec };
    delete out.view;
    return frame(ch, out);
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
    if (c.ageTimer) clearTimeout(c.ageTimer);
    clients.delete(c.id);
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
    const age = Math.round((Date.now() - c.born) / 1000);
    log.info(`sse client #${c.id} ${[...c.channels]} dropped (${why}) after ${age} s, ${clients.size} left`);
  }

  /** Publish a command frame to one channel. view scopes delivery (wall has landscape|portrait). */
  function publish(channel, cmd, args = {}, view = null) {
    // A caller that passes a pre-built frame is asking for that frame to be kept — the wall's
    // own ring already numbered it. That is decided by what it passed THROUGH `args`, never by
    // keys on the payload itself: a `text.send` whose item happened to carry `cmd`/`seq` would
    // otherwise be mistaken for a frame and dropped into the ring with no seq at all, so it was
    // never written to any client (2026-11-01: every payload command vanished from the SSE bus
    // while bare commands like `pattern.next` still arrived).
    const isFrame = cmd === null || cmd === undefined ||
      (args && typeof args === 'object' && 'cmd' in args && 'seq' in args);
    // `view` is a DELIVERY SCOPE on the transport, never a field of the payload: the wall's own
    // ring already put `view: 'both'` inside `args`, and copying that back onto the record made
    // every client with a concrete view drop the frame (2026-11-01 — every `text.send`,
    // including a portraited one, vanished between the wall and both render pages).
    const hasViewArg = args && typeof args === 'object' && 'view' in args;
    let scopedArgs = args;
    if (hasViewArg && args.view === 'both') {
      scopedArgs = { ...args };
      delete scopedArgs.view;
    }
    const rec = isFrame && args && typeof args === 'object'
      ? { ...args, channel, view: view || null }
      : { seq: nextSeq(channel), channel, cmd, args: scopedArgs, view: view || null };
    // One assignment, logged so a frame that never reaches a client can be traced from the
    // server log rather than inferred from a blank bus.
    if (process.env.SHOCKBOX_DEBUG_EVENTS) log.info(`publish ${channel} ${JSON.stringify(rec).slice(0, 200)}`);
    if (rec.seq === undefined || rec.seq === null) rec.seq = nextSeq(channel);
    const r = ring(channel);
    r.push(rec);
    if (r.length > RING_MAX) r.shift();
    // `both` is not a page view: a record scoped to both must reach the landscape page and
    // the portrait page, or a deck press that means "everywhere" reaches nowhere.
    const scope = view && view !== 'both' ? view : null;
    for (const c of clients.values()) {
      if (!c.channels.has(channel)) continue;
      if (scope && c.view && c.view !== scope) continue;
      write(c, frameFor(c, channel, rec));
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
    // One record shape for every frame on the wire, and the typed event name is the *channel*
    // — exactly what publish() sends and what frame() documents. Typing the wire event after
    // the kind instead (`event: state.snapshot`) left every channel subscriber deaf: the admin
    // shell's bus listens per channel, so a settings push reached a page that was listening for
    // `wall` as nothing at all and the pane only caught up on its 4 s poll. The kind rides in
    // the record, where the consumer already looks for it.
    // `t` stamps the record: consumers dedupe consecutive frames on channel|seq|kind|t, so two
    // same-kind emits with no stamp collapse into one and the second is dropped outright.
    const rec = { channel, event, data, t: Date.now() };
    for (const c of clients.values()) {
      if (!c.channels.has(channel)) continue;
      if (view && c.view && c.view !== view) continue;
      write(c, frame(channel, rec));
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
    // `both` is not a page view: a record scoped to both must reach the landscape page and
    // the portrait page, or a deck press that means "everywhere" reaches nowhere.
    const scope = view && view !== 'both' ? view : null;
    for (const c of clients.values()) {
      if (!c.channels.has(channel)) continue;
      if (scope && c.view && c.view !== scope) continue;
      write(c, frameFor(c, channel, rec));
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
   * Replay: each channel's ring is sent from ?since= before live frames. No cursor, no replay.
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
      role: roleOf(req),
      ref: refPath(req),
      remote: client || req.socket?.remoteAddress || '?',
      born: Date.now(),
      ageTimer: null,
      dead: false,
    };
    clients.set(c.id, c);
    // Supersede: one document holds one bus. A predecessor whose stream was never closed keeps an
    // ESTABLISHED socket in CEF's six-per-origin pool, and the successor's own two responses then
    // starve its acks (measured: `ack request: signal timed out` with the socket count at 6). Ending
    // the older response here is what keeps a reload from wedging the page.
    //
    // Only the *same* identity is touched, and the response that just attached is never a candidate
    // (it is `c`), so a different page — or the live page itself — never loses its feed. A client
    // that declared no role is matched only by the path its document came from (`ref`), which is how
    // a document cached from before `?role=` existed is superseded on the first deploy that ships
    // this rule. A client with neither a role nor a referer is never a candidate at all.
    if (c.role) {
      for (const old of [...clients.values()]) {
        if (old !== c && (old.role === c.role || (!old.role && old.ref === c.role))) drop(old, 'superseded');
      }
    }
    // The cap: at max age the response is ended cleanly (drop calls end(), never an error status),
    // so the slot the page's vanished predecessor kept goes back to the pool. EventSource reconnects
    // by itself on a clean close (`retry: 1500` above), which is why ending is safe here.
    c.ageTimer = setTimeout(() => drop(c, 'max age'), SSE_MAX_MS);
    if (c.ageTimer.unref) c.ageTimer.unref();
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
      // No cursor means a cold client, and a cold client must replay nothing. The ring holds
      // commands, not state: a fresh page gets its state from the document (GET /api/wall/render)
      // and from live, non-replayable `state.snapshot` frames. Replaying one-shots into a brand-new
      // document re-fires them — `reload` calls location.reload() on every cold connect (an endless
      // loop until 400 commands push it out), and `preset.set` re-applies and rewrites the document.
      const start = from === null ? r.length : Math.max(0, r.length - Math.min(r.length, RING_MAX));
      for (let i = 0; i < r.length; i += 1) {
        const rec = r[i];
        if (from === null || rec.seq <= from) continue;
        if (i < start) continue;
        if (rec.view && view && rec.view !== view) continue;
        if (!write(c, frameFor(c, ch, rec))) break;
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
    for (const c of [...clients.values()]) {
      if (c.res.writableLength > CLIENT_BUFFER_MAX) drop(c, 'backpressure');
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
