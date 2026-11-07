// One HTTP server: static pages, module pages, module API routes, core API, SSE.
//
// Design rules that matter:
//  - Every page we serve is `no-store`. The old file:// pages could be served from cache after a
//    deploy and hide a change; over HTTP with no-store that class of failure is gone.
//  - Core routes win over module routes. The popup contract's legacy paths (/api/state, /overlay …)
//    are mounted by the notifications and dialogs modules, and core adds /health, /api/modules.
//  - A module route that throws is reported as a 500 with its module id in the log; the server lives.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, isObj } from './id.mjs';
import { createPointer } from './stage-pointer.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.onnx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.glsl': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const BODY_LIMIT = 2 * 1024 * 1024;

export function sendJson(res, status, body) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(text);
}

export async function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `body > ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = BODY_LIMIT) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (!isObj(parsed) && !Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed;
}

// CORS preflight: the deck and the OBS pages call from a different port, and a browser probe
// (tools/shockbox-probe) calls from localhost:elsewhere. One permissive policy, one place.
function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,accept,x-requested-with');
  res.setHeader('access-control-max-age', '600');
}

/**
 * Headers a module asks a page (and the page's sibling files) to be served with — generic, so a
 * module that needs cross-origin isolation declares COOP/COEP and core never names it:
 * A page declares them in its module.json entry,
 * `"headers": {"cross-origin-embedder-policy": "require-corp"}`; they apply to the page file and
 * to its sibling files (its scripts, styles), and `GET /api/<id>/routes` reports them per page.
 * Core validates the shape and refuses what it writes itself; it never knows who asked.
 */
export function cleanHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    const value = String(rawValue ?? '');
    // A module may not override framing/CORS/body bookkeeping: those are the server's.
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    if (CORE_HEADERS.has(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

const CORE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'access-control-max-age',
  'transfer-encoding',
  'connection',
  'date',
]);

export function serveFile(res, file, { cache = 'no-store', method = 'GET', headers = null } = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    ...(cleanHeaders(headers) || {}),
    'content-type': type,
    'cache-control': cache,
    'content-length': st.size,
    'access-control-allow-origin': '*',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  // `cache` is set on writeHead above: a module can make its runtime cacheable (the hand FX
  // wasm is ~10 MB and must not be fetched per page load); `no-store` is the default.
  fs.createReadStream(file).pipe(res);
  return true;
}

// The shared shell's own files under public/: the entry document and the module graph it boots.
// The shell used to be served with no header helper at all (a module page gets its module.json
// `headers`, the shell has none), so a pane mounted in it reported crossOriginIsolated === false
// while the overlay page reported true — the pane then told the operator its own tab was not
// isolated. COOP/COEP on these two documents is what makes the pane route an isolated document.
// `require-corp` rather than `credentialless`: everything the shell loads is same-origin (its
// stylesheets, its module graph, the panes' own imports), so nothing needs a CORS-free pass and the
// stricter policy costs nothing. A third-party embed added to the shell later needs CORP and will
// fail loudly here instead of silently widening the policy.
const SHELL_ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
};
const SHELL_FILES = [/^\/$/, /^\/control\/?$/, /^\/index\.html$/, /^\/src\/.*\.(?:m?js|css)$/];

/** Headers for a request that lands in public/: the shell and its module graph are isolated. */
export function shellHeaders(p) {
  return SHELL_FILES.some((re) => re.test(p)) ? SHELL_ISOLATION : null;
}

/**
 * Serve a file through a prefix a module declared (`mountPrefix` + `mountFile` on its API). The
 * module resolves and validates the path itself — core only knows the prefix and that the module
 * owns what is under it.
 */
export function serveMountFile(res, req, file, { cache = 'no-store', headers = null } = {}) {
  return serveFile(res, file, { cache, method: req.method, headers });
}

/** Resolve a path inside root, refusing traversal and symlink escapes. */
export function safeJoin(root, rel) {
  const clean = decodeURIComponent(rel).replace(/^\/+/, '').replace(/[?#].*$/, '');
  const full = path.resolve(root, clean);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

export function createServer({ port, host, stateDir, publicDir, registry, events, obs, log, version, core = {} }) {
  // The show preview's cursor: one in-memory value, re-broadcast on the `pointer` channel.
  const pointer = createPointer({ events });
  const server = http.createServer(async (req, res) => {
    applyCors(res);
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' });
    }
    const p = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    try {
      // ---- core API -------------------------------------------------------
      if (p === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const mods = {};
        for (const m of registry.describe()) mods[m.id] = m.status;
        return sendJson(res, 200, {
          ok: true,
          service: 'shockbox',
          version,
          pid: process.pid,
          port,
          clients: events.clientCount,
          channels: events.clientsByChannel(),
          modules: mods,
          obs: { state: obs?.state || 'off', scene: obs?.scene || null },
          uptime: Math.round(process.uptime()),
        });
      }
      if (p === '/api/modules' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, modules: registry.describe() });
      }
      // Stage pointer: POST stores and re-broadcasts (SSE `event: pointer`), GET reads it back.
      // Core-owned so no module can shadow the path the preview and the overlays agreed on.
      if (p === '/api/stage/pointer') {
        if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, pointer.get());
        if (req.method === 'POST') return sendJson(res, 200, pointer.set(await readJson(req)));
        return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
      }
      const st = /^\/api\/modules\/([a-z0-9-]+)\/state$/.exec(p);
      if (st && req.method === 'GET') {
        const entry = registry.byId.get(st[1]);
        if (!entry) return sendJson(res, 404, { ok: false, error: 'no such module' });
        if (entry.status !== 'up') return sendJson(res, 503, { ok: false, error: entry.error });
        const body = typeof entry.api.state === 'function' ? entry.api.state() : {};
        return sendJson(res, 200, { ok: true, id: entry.id, state: body });
      }
      const rt = /^\/api\/modules\/([a-z0-9-]+)\/routes$/.exec(p);
      if (rt && req.method === 'GET') {
        const entry = registry.byId.get(rt[1]);
        if (!entry) return sendJson(res, 404, { ok: false, error: 'no such module' });
        return sendJson(res, 200, {
          ok: true,
          id: entry.id,
          pages: entry.pages.map((x) => ({
            route: x.route,
            title: x.title || null,
            // The response headers core is serving this page (and its siblings) with, so a
            // module can be checked for a cross-origin-isolation policy it declared.
            headers: x.headers || null,
            cache: x.cache || null,
          })),
          routes: entry.routes.map((x) => ({ method: x.method || 'ANY', path: x.path })),
        });
      }
      if (p === '/api/log' && req.method === 'GET') {
        // `log` is a scoped logger: the ring lives on the root logger it was made from.
        const src = typeof log.recent === 'function' ? log : log.root || log.parent;
        if (!src || typeof src.recent !== 'function') {
          return sendJson(res, 501, { ok: false, error: 'this logger has no ring buffer' });
        }
        return sendJson(res, 200, { ok: true, lines: src.recent(Number(url.searchParams.get('limit')) || 200) });
      }
      if (p === '/api/core/settings' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, settings: core.settings?.describe?.() || {} });
      }
      if (p === '/api/core/settings' && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) {
        const body = await readJson(req);
        const changed = core.settings.patch(body);
        return sendJson(res, 200, { ok: true, changed });
      }
      if (p === '/api/core/obs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...core.obsStatus?.() });
      }
      if (p === '/api/core/obs/scenes' && req.method === 'GET') {
        const list = await obs.scenes();
        return sendJson(res, 200, { ok: true, ...list });
      }
      // core SSE: every channel or ?channels=wall,notifications
      if (p === '/events' && req.method === 'GET') {
        // Default = every channel of every up module. A client that names channels gets only those.
        const allChannels = [];
        for (const e of registry.entries) {
          if (e.status !== 'up') continue;
          if (e.api && Array.isArray(e.api.channels)) allChannels.push(...e.api.channels);
        }
        const asked = url.searchParams.get('channels');
        const chans = (asked ? asked.split(',') : allChannels).map((c) => c.trim()).filter(Boolean);
        const since = url.searchParams.get('since');
        events.attach(req, res, {
          channels: chans,
          view: url.searchParams.get('view'),
          since: since === null ? null : Number(since),
          client: url.searchParams.get('client'),
        });
        return undefined;
      }

      // ---- module routes ---------------------------------------------------
      // Core-owned extras (the shared message pool) come first so no module can shadow them.
      if (Array.isArray(core.extraRoutes)) {
        for (const r of core.extraRoutes) {
          const methodOk = !r.method || r.method === 'any' || r.method === req.method || (req.method === 'HEAD' && r.method === 'GET') || (r.method instanceof RegExp && r.method.test(req.method));
          if (!methodOk) continue;
          let params = null;
          if (r.path instanceof RegExp) {
            const m = r.path.exec(p);
            if (m) params = m.slice(1);
          } else if (r.path === p) {
            params = [];
          }
          if (params === null) continue;
          // A raw route takes the body as bytes: a picture upload is not JSON, and parsing it as
          // JSON is how a module with an upload endpoint used to have only a 400 for an answer.
          // `rawBody: true` is the declaration; the size ceiling stays the module's own.
          const body = req.method === 'GET' || req.method === 'HEAD' ? null
            : r.rawBody
              ? await readBody(req, r.rawLimit || BODY_LIMIT).catch((e) => {
                if (e instanceof HttpError) throw e;
                throw new HttpError(400, e.message);
              })
              : await readJson(req).catch((e) => {
                if (e instanceof HttpError) throw e;
                throw new HttpError(400, e.message);
              });
          const out = await r.handler(req, res, url, body, params);
          if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
          return undefined;
        }
      }
      // A module that serves a directory of assets (a vendored runtime, a model) declares
      // `mountPrefix` and `mountFile` in its API: any GET under `/api/<id>/<prefix>` is handed to
      // `mountFile(req, res, url, filePath)` with the path after the prefix, so core needs no rule
      // about what the files are. Anything the module returns is sent as JSON, as everywhere.
      if (req.method === 'GET' || req.method === 'HEAD') {
        for (const entry of registry.entries || []) {
          if (entry.status !== 'up') continue;
          const prefix = entry.api && entry.api.mountPrefix;
          if (!prefix) continue;
          const base = `/api/${entry.id}/`;
          if (!p.startsWith(base)) continue;
          const head = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
          const rest = p.slice(base.length);
          if (rest !== head && !rest.startsWith(`${head}/`)) continue;
          const filePath = rest === head ? '' : rest.slice(head.length + 1);
          if (!filePath) continue;
          const handler = typeof entry.api.mountFile === 'function' ? entry.api.mountFile : null;
          if (!handler) continue;
          const out = await handler(req, res, url, filePath);
          if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
          return undefined;
        }
      }
      const hit = registry.match(req.method, p);
      if (hit) {
        // A module route may take its body as bytes (`rawBody: true`): a picture upload is not
        // JSON, and the size ceiling stays the module's own (the same rule as core's extra routes).
        const body = req.method === 'GET' || req.method === 'HEAD' ? null
          : hit.route.rawBody === true
            ? await readBody(req, hit.route.rawLimit || BODY_LIMIT).catch((e) => {
              if (e instanceof HttpError) throw e;
              throw new HttpError(400, e.message);
            })
            : await readJson(req).catch((e) => {
              if (e instanceof HttpError) throw e;
              throw new HttpError(400, e.message);
            });
        const out = await hit.route.handler(req, res, url, body, hit.params);
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        return undefined;
      }

      // ---- module pages ----------------------------------------------------
      const page = registry.page(p);
      if (page && (req.method === 'GET' || req.method === 'HEAD')) {
        if (
          page.page.file &&
          serveFile(res, page.page.file, { cache: page.page.cache || 'no-store', method: req.method, headers: page.page.headers })
        ) {
          return undefined;
        }
        return sendJson(res, 404, { ok: false, error: `page file missing for ${p}` });
      }
      // A page served at its own route also serves its siblings from its own directory
      // (`/notify/app.js` → `<dir>/overlay/app.js`).
      const sameDir = registry.pageDir ? registry.pageDir(p) : null;
      if (sameDir && (req.method === 'GET' || req.method === 'HEAD')) {
        const f = safeJoin(path.dirname(sameDir.page.file), sameDir.rel);
        if (f && serveFile(res, f, { cache: sameDir.page.cache || 'no-store', method: req.method, headers: sameDir.page.headers })) {
          return undefined;
        }
      }
      // A page's sibling files (its classic scripts, images) under the page's own URL.
      const sibling = registry.pageFile ? registry.pageFile(p) : null;
      if (sibling && sibling.page.staticDir && (req.method === 'GET' || req.method === 'HEAD')) {
        const f = safeJoin(sibling.page.staticDir, sibling.rel);
        if (
          f &&
          serveFile(res, f, { cache: sibling.page.cache || 'no-store', method: req.method, headers: sibling.page.headers })
        ) {
          return undefined;
        }
      }

      // ---- shell + shared static ------------------------------------------
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/' || p === '/control' || p === '/control/') {
          const shell = path.join(publicDir, 'index.html');
          if (serveFile(res, shell, { method: req.method, headers: shellHeaders('/') })) return undefined;
          // The entry document is source, served straight from public/. If it is missing the
          // checkout is incomplete — say which file and where we looked, not "run a build".
          log.error(`shell missing: ${shell} — serving 503 (incomplete checkout?)`);
          return sendText(
            res,
            503,
            `<h1>ShockBox</h1><p>The shell document is missing: <code>${shell}</code> was not found. ` +
              `It is part of the repository (public/index.html); check the checkout at <code>${publicDir}</code>.</p>`,
            'text/html; charset=utf-8',
          );
        }
        const file = safeJoin(publicDir, p);
        if (file && serveFile(res, file, { method: req.method, headers: shellHeaders(p) })) return undefined;
        // module-relative static fallback: /mod/<id>/<path> serves inside that module's dir
        const mm = /^\/mod\/([a-z0-9-]+)\/(.+)$/.exec(p);
        if (mm) {
          const entry = registry.byId.get(mm[1]);
          if (entry) {
            const f = safeJoin(entry.dir, mm[2]);
            if (f && serveFile(res, f, { method: req.method })) return undefined;
          }
        }
      }

      if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: `no route ${req.method} ${p}` });
      return sendText(res, 404, 'not found', 'text/plain; charset=utf-8');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.error(`${req.method} ${p}: ${err.stack || err.message}`);
      sendJson(res, status, { ok: false, error: err.message || String(err), status });
      return undefined;
    }
  });

  // Socket deadlines. These are the listener's guards on a half-open *request*; the caps in
  // core/events.mjs and handfx's /camera/stream bound a long-lived *response*. Set together so the
  // numbers are visible in one place, and logged at listen time.
  //   requestTimeout  — deadline for receiving one request (headers + body). It does not touch a
  //                     response already streaming: verified on this Node (24.x) with the cap at
  //                     800 ms, an endless response kept writing for 2.5 s. 300 s is Node's default
  //                     and is far beyond the largest body we accept (BODY_LIMIT = 2 MB of JSON).
  //   headersTimeout  — headers only, 20 s: CEF sends them in the request's first packet, so this is
  //                     huge headroom while a scanner or a half-open socket is dropped quickly.
  //   keepAliveTimeout— an idle kept-alive socket is answered with `Connection: close` and released
  //                     after 5 s. This reclaims a socket a vanished document left *idle*, but never
  //                     one mid-stream: the peer goes on accepting MJPEG frames, so it is never idle.
  //                     That case is exactly what the max-age caps exist for.
  //   timeout         — 0 (disabled) on purpose: an inactivity reaper would read a silent camera or a
  //                     quiet bus as death and kill a healthy stream. Lifetime is bounded by the caps,
  //                     which do not depend on traffic.
  server.requestTimeout = 300_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 0;

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  return {
    server,
    listen(h = host, pn = port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(pn, h, () => {
          server.removeListener('error', reject);
          log.info(
            `http: timeouts request=${server.requestTimeout}ms headers=${server.headersTimeout}ms ` +
              `keepAlive=${server.keepAliveTimeout}ms socket=${server.timeout}ms`,
          );
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /**
     * Drive the server's own routes from inside the process, so a background worker (the
     * scheduler) reuses the exact handler a click would reach instead of a parallel send path.
     * Resolves `{status, body}`; handlers that write framing themselves are refused rather than
     * fed a fake response, because silently returning `{}` would look like a delivered send.
     */
    async request(method, pathname, body) {
      const u = new URL(pathname, 'http://core.local');
      const p = u.pathname;
      // In-process callers get the answer back as a return value, so a handler that answers with
      // `writeHead`/`end` itself (rather than returning a value) must not crash: give the fake the
      // same shape a real ServerResponse has and capture what it wrote instead of sending it.
      const fakeRes = {
        headersSent: false,
        ended: false,
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
        getHeader(k) { return this.headers[String(k).toLowerCase()]; },
        writeHead(status, hdrs) {
          this.statusCode = status;
          if (hdrs && typeof hdrs === 'object') {
            for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v);
          }
          this.headersSent = true;
          return this;
        },
        write(chunk) { this.chunks.push(chunk); return true; },
        end(chunk) {
          if (chunk !== undefined) this.chunks.push(chunk);
          this.headersSent = true;
          this.ended = true;
          return this;
        },
        chunks: [],
      };
      const asBody = (x) => (x === undefined ? {} : x);
      const parseBody = (res) => {
        if (!res.chunks.length) return undefined;
        const text = Buffer.concat(res.chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8');
        try { return JSON.parse(text); } catch { return text; }
      };
      if (Array.isArray(core.extraRoutes)) {
        for (const r of core.extraRoutes) {
          if (r.method !== method) continue;
          let params = null;
          if (r.path instanceof RegExp) {
            const m = r.path.exec(p);
            if (m) params = m.slice(1);
          } else if (r.path === p) params = [];
          if (params === null) continue;
          const out = await r.handler({ method, url: p }, fakeRes, u, body ?? null, params);
          return { status: fakeRes.statusCode || 200, body: asBody(out !== undefined ? out : parseBody(fakeRes)) };
        }
      }
      const hit = registry.match(method, p);
      if (!hit) throw new Error(`no route for ${method} ${p}`);
      const out = await hit.route.handler({ method, url: p }, fakeRes, u, body ?? null, hit.params);
      return { status: fakeRes.statusCode || 200, body: asBody(out !== undefined ? out : parseBody(fakeRes)) };
    },
  };
}
