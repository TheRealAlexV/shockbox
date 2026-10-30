// Legacy port shim: serves a small, explicit set of the popups' original paths on the old port so
// that deck actions and OBS sources keep working while they are being repointed at ShockBox.
//
// This is deliberately NOT the module's whole surface — it is the intersection the deck and OBS
// already use, listed in the module's `legacyRoutes()`. Anything else 404s, so a stale caller is
// visible instead of silently drifting.

import http from 'node:http';

export function createCompatServer({ port, routes, registry, events, log }) {
  const list = routes.map((r) => ({ ...r, re: r.re || null }));
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,accept');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    for (const r of list) {
      if (r.method && r.method !== req.method) continue;
      const m = r.re ? r.re.exec(url.pathname) : r.path === url.pathname ? [] : null;
      if (!m) continue;
      try {
        await r.handler(req, res, url, null, m.slice ? m.slice(1) : []);
      } catch (err) {
        log.error(`${req.method} ${url.pathname}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      }
      return undefined;
    }
    // Unknown path on the legacy port: say so, and name the port that does serve it.
    log.warn(`compat 404 ${req.method} ${url.pathname}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `not served on the legacy port: ${url.pathname}` }));
    return undefined;
  });
  return {
    server,
    listen(host, p) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
  };
}
