// obs-websocket client: the smallest thing that works, plus the operations ShockBox actually needs.
//
// Why hand-rolled: obs-websocket 5.x is a documented JSON protocol over a WebSocket with a SHA-256
// challenge handshake. Node 24 has a client WebSocket in core (`globalThis.WebSocket`), so this needs
// no dependency, which keeps the "zero deps" property of the whole server.
//
// Used for: CurrentProgramSceneChanged (ratio forcing), scene item surgery (wall gates), source URL
// updates on deploy, and screenshots in verification. Every call has a timeout; reconnect backs off.

import crypto from 'node:crypto';

const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_EVENT = 5;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;

export function createObsClient({ url = 'ws://127.0.0.1:4455', password = '', log, onEvent = null }) {
  let ws = null;
  let state = 'idle'; // idle | connecting | ready | closed
  let identified = false;
  let nextId = 0;
  const pending = new Map();
  const subs = new Set();
  let backoff = 500;
  let wantOpen = false;
  let lastScene = null;
  // Diagnostics the pane and /api/core/obs report: 'connecting' forever is not a verdict.
  let lastError = null;
  let lastErrorAt = null;
  let attempts = 0;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw string */
  }

  function noteError(message) {
    lastError = message;
    lastErrorAt = new Date().toISOString();
    attempts += 1;
  }

  function ready() {
    return identified;
  }

  function connect() {
    if (ws && (state === 'connecting' || state === 'ready')) return;
    wantOpen = true;
    state = 'connecting';
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      noteError(`connect failed: ${err.message}`);
      log.warn(`obs connect failed: ${err.message}`);
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.addEventListener('open', () => {
      /* wait for Hello */
    });
    sock.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      onMessage(msg);
    });
    sock.addEventListener('close', (ev) => {
      const wasReady = identified;
      // Close before Identify means the server refused us (bad password) or never spoke; after
      // Identify it is a dropped link. Neither is visible from the outside without this.
      if (!wasReady) noteError(`closed before identify (code ${ev?.code ?? '?'})`);
      identified = false;
      state = 'closed';
      ws = null;
      for (const [, p] of pending) p.reject(new Error('obs connection closed'));
      pending.clear();
      if (wasReady) log.warn('obs connection closed');
      if (wantOpen) scheduleReconnect();
    });
    sock.addEventListener('error', () => {
      /* close follows */
    });
  }

  function scheduleReconnect() {
    const wait = backoff;
    backoff = Math.min(backoff * 2, 10_000);
    setTimeout(() => {
      if (wantOpen && !identified) connect();
    }, wait).unref?.();
  }

  function onMessage(msg) {
    switch (msg.op) {
      case OP_HELLO:
        // A server that demands auth when we hold none can never identify us; say so once rather
        // than leaving the pane on 'connecting' for an hour.
        if (msg.d.authentication && !password) noteError('OBS requires a password; config.json obs.password is empty');
        send({
          op: OP_IDENTIFY,
          d: {
            rpcVersion: msg.d.rpcVersion,
            authentication: msg.d.authentication ? authString(password, msg.d.authentication) : undefined,
            eventSubscriptions: 0x7ff, // all non-high-volume
          },
        });
        break;
      case OP_IDENTIFIED:
        identified = true;
        state = 'ready';
        backoff = 500;
        lastError = null;
        attempts = 0;
        log.info(`obs identified (rpcVersion ${msg.d?.negotiatedRpcVersion})`);
        for (const fn of subs) {
          try {
            fn({ type: 'ready' });
          } catch {
            /* ignore */
          }
        }
        break;
      case OP_EVENT: {
        const { eventType, eventIntent, eventData } = msg.d;
        if (eventType === 'CurrentProgramSceneChanged') lastScene = eventData.sceneName;
        if (eventType === 'SceneChanged') lastScene = eventData.sceneName;
        for (const fn of subs) {
          try {
            fn({ type: 'event', eventType, eventData, eventIntent });
          } catch (err) {
            log.error(`obs event subscriber threw: ${err.message}`);
          }
        }
        if (onEvent) {
          try {
            onEvent(eventType, eventData);
          } catch (err) {
            log.error(`obs onEvent threw: ${err.message}`);
          }
        }
        break;
      }
      case OP_REQUEST_RESPONSE: {
        const p = pending.get(msg.d.requestId);
        if (!p) return;
        pending.delete(msg.d.requestId);
        clearTimeout(p.timer);
        if (msg.d.requestStatus && msg.d.requestStatus.result) p.resolve(msg.d.responseData || {});
        else p.reject(new Error(`${msg.d.requestType}: ${msg.d.requestStatus?.comment || 'failed'}`));
        break;
      }
      default:
        break;
    }
  }

  function send(obj) {
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** request('GetSceneList') → responseData; rejects on timeout (default 4 s). */
  function request(requestType, requestData = {}, timeoutMs = 4000) {
    if (!identified) return Promise.reject(new Error('obs not connected'));
    const requestId = `sb_${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${requestType}: timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(requestId, { resolve, reject, timer });
      if (!send({ op: OP_REQUEST, d: { requestType, requestId, requestData } })) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new Error(`${requestType}: socket not writable`));
      }
    });
  }

  /** subscribe(fn) with fn({type:'ready'|'event',…}); returns unsubscribe. */
  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  function close() {
    wantOpen = false;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    identified = false;
    state = 'closed';
  }

  return {
    connect,
    close,
    request,
    subscribe,
    ready,
    get state() {
      return state;
    },
    get scene() {
      return lastScene;
    },
    /**
     * Why the link is in the state it is in. `/api/core/obs` promises this (server.mjs:229-231):
     * 'closed' alone cannot tell a wrong password from a server that is not listening, and both
     * look like the app's fault from outside. Password is never echoed — only whether one is set.
     */
    diag() {
      return {
        state,
        identified,
        url,
        host,
        auth: Boolean(password),
        lastError,
        lastErrorAt,
        attempts,
        nextRetryMs: identified ? 0 : backoff,
      };
    },
    /** Convenience reads the ratio watcher and gates need. */
    async currentScene() {
      const r = await request('GetCurrentProgramScene');
      lastScene = r.currentProgramSceneName || r.sceneName;
      return lastScene;
    },
    async scenes() {
      const r = await request('GetSceneList');
      return { current: r.currentProgramSceneName, scenes: (r.scenes || []).map((s) => s.sceneName).reverse() };
    },
    /** Find a scene item id by source name. Returns null when the source is not in the scene. */
    async sceneItemOf(sceneName, sourceName) {
      try {
        const r = await request('GetSceneItemId', { sceneName, sourceName });
        return r.sceneItemId;
      } catch {
        return null;
      }
    },
    async setInputSettings(inputName, settings, overlay = true) {
      return request('SetInputSettings', { inputName, inputSettings: settings, overlay });
    },
    async getInputSettings(inputName) {
      return request('GetInputSettings', { inputName });
    },
    async setSourceUrl(inputName, url) {
      return request('SetInputSettings', { inputName, inputSettings: { url }, overlay: true });
    },
    async screenshot(sourceName, format = 'png', width = 1280) {
      const r = await request('GetSourceScreenshot', { sourceName, imageFormat: format, imageWidth: width }, 8000);
      return r.imageData;
    },
  };
}

function authString(password, auth) {
  const secret = crypto.createHash('sha256').update(password + auth.salt).digest('base64');
  return crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
}
