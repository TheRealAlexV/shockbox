// Registry: discover modules/, validate their manifests, mount their routes, isolate their failures.
//
// Contract (docs/ARCHITECTURE.md): the core never imports a module by name; a module never imports
// another module; all module data lives in state/<id>/; every route is namespaced; a module that
// throws on init is reported as failed and every other module stays up. Adding a feature = dropping
// a folder into modules/ and restarting. That is the whole extension mechanism.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError } from './id.mjs';

const ID_RE = /^[a-z][a-z0-9-]{1,23}$/;

/** Module ids core already answers for, or plans to. */
const RESERVED_IDS = new Set(['core', 'api', 'events', 'health', 'control', 'public', 'mod', 'static']);
/** Page routes the shell and the SSE hub own; a module page must not shadow them. */
const RESERVED_PATHS = [/^\/$/, /^\/control\/?/, /^\/health$/, /^\/events$/, /^\/api(\/|$)/, /^\/mod\//];

export async function loadRegistry({ modulesDir, stateDir, ctx, log }) {
  const entries = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    log.error(`modules dir missing: ${err.message}`);
  }
  dirs.sort();

  for (const name of dirs) {
    const dir = path.join(modulesDir, name);
    const manifestPath = path.join(dir, 'module.json');
    if (!fs.existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      entries.push({ id: name, manifest: { id: name, title: name }, status: 'failed', error: `module.json: ${err.message}`, dir });
      log.error(`module ${name}: bad module.json (${err.message})`);
      continue;
    }
    const id = manifest.id || name;
    if (!ID_RE.test(id)) {
      entries.push({ id, manifest, status: 'failed', error: `illegal id "${id}" (must match ${ID_RE})`, dir });
      log.error(`module ${name}: illegal id ${id}`);
      continue;
    }
    if (!manifest.title) manifest.title = id;
    // Reserved space belongs to core: a module claiming it would shadow the shell or the SSE
    // hub depending on sort order, which is the kind of bug that only shows up live.
    if (RESERVED_IDS.has(id)) {
      entries.push({ id, manifest, status: 'failed', error: `id "${id}" is reserved by core`, dir });
      log.error(`module ${name}: id ${id} is reserved by core`);
      continue;
    }
    const clash = (manifest.pages || []).map((p) => p.route).filter((r) => RESERVED_PATHS.some((re) => re.test(r)));
    if (clash.length) {
      entries.push({ id, manifest, status: 'failed', error: `page route(s) ${clash.join(', ')} collide with core`, dir });
      log.error(`module ${name}: page route ${clash[0]} collides with core`);
      continue;
    }
    const entry = {
      id,
      dir,
      manifest,
      status: 'loading',
      error: null,
      api: null,
      routes: [],
      dataDir: path.join(stateDir, id),
      settings: null,
    };
    try {
      fs.mkdirSync(entry.dataDir, { recursive: true });
      const mount = manifest.mount || 'server.js';
      const mod = await import(pathToFileURL(path.join(dir, mount)).href);
      const api = mod.default || mod;
      if (!api || typeof api !== 'object') throw new Error(`${mount} must default-export an object`);
      entry.api = api;
      const modLog = typeof log.scope === 'function' ? log.scope(id) : log;
      const modCtx = {
        ...ctx,
        id,
        dir,
        dataDir: entry.dataDir,
        log: modLog,
        manifest,
        settings: null,
        // data files on disk, next to the module, for the one-time adopt step
        legacyData: (rel) => path.join(dir, rel),
      };
      // A manifest `settings` map is this module's settings document. Declared here (not in
      // init) so a failing schema fails the module instead of half-configuring it.
      if (manifest.settings && typeof manifest.settings === 'object') {
        if (typeof ctx.makeSettings !== 'function') throw new Error('core did not provide makeSettings');
        modCtx.settings = ctx.makeSettings({
          dir: entry.dataDir,
          schema: manifest.settings,
          log: modLog,
          onChange: (changed, all) => {
            try {
              ctx.events?.emit(id, 'settings', { changed, settings: modCtx.settings.describe() });
            } catch {
              /* events is best-effort */
            }
          },
        });
      }
      if (typeof api.init === 'function') await api.init(modCtx);
      entry.settings = modCtx.settings;
      const routes = typeof api.routes === 'function' ? api.routes(modCtx) || [] : [];
      for (const r of routes) {
        const full = r.path.startsWith('/api') ? r.path : `/api/${id}${r.path.startsWith('/') ? '' : '/'}${r.path}`;
        entry.routes.push({ ...r, path: full, re: r.re || null });
      }
      entry.pages = (manifest.pages || []).map((p) => ({
        ...p,
        // Page routes are served verbatim (they are not under /api): /render, /overlay, /ui …
        file: p.file ? path.join(dir, p.file) : null,
        // A page that loads classic scripts relative to itself (`<script src="sim.js">`) also
        // claims its URL as a directory for those files, so no second route per file is needed.
        // `static` names the directory, relative to the module (default: the page's own).
        staticDir: p.file && !p.prefix ? (p.static ? path.join(dir, p.static) : path.dirname(path.join(dir, p.file))) : dir,
        prefix: Boolean(p.prefix),
        // Response headers this page (and its sibling files) must be served with — the shape is
        // generic: a module that needs cross-origin isolation declares COOP/COEP here and core
        // serves them without knowing which module asked. Shape-validated by the HTTP server.
        headers: p.headers && typeof p.headers === 'object' ? p.headers : null,
      }));
      entry.status = 'up';
      log.info(`module ${id} v${manifest.version || '?'} up (${entry.routes.length} routes, ${entry.pages.length} pages)`);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err && err.message ? err.message : String(err);
      try {
        if (entry.api && typeof entry.api.dispose === 'function') await entry.api.dispose();
      } catch {
        /* ignore */
      }
      log.error(`module ${id} failed to load: ${entry.error}${err && err.stack ? '\n' + err.stack.split('\n').slice(1, 4).join('\n') : ''}`);
    }
    entries.push(entry);
  }

  entries.sort((a, b) => (a.manifest.order || 100) - (b.manifest.order || 100) || a.id.localeCompare(b.id));
  const byId = new Map(entries.map((e) => [e.id, e]));

  /** Match a request against every up module's routes. Core always gets first refusal. */
  function match(method, pathname) {
    for (const entry of entries) {
      if (entry.status !== 'up') continue;
      for (const r of entry.routes) {
        if (r.method && r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
        if (r.re) {
          const m = r.re.exec(pathname);
          if (m) return { entry, route: r, params: m.slice(1) };
        } else if (r.path === pathname) {
          return { entry, route: r, params: [] };
        }
      }
    }
    return null;
  }

  function page(pathname) {
    for (const entry of entries) {
      if (entry.status !== 'up') continue;
      for (const p of entry.pages || []) {
        if (p.route === pathname) return { entry, page: p };
      }
    }
    return null;
  }

  /**
   * Resolve a page's sibling file: `/wall/render/sim.js` → the module's engine dir + `sim.js`.
   * Longest route wins so `/wall/render` never shadows a nested page. Returns null when no page
   * owns the path — the caller then falls through to the shell.
   */
  function pageFile(pathname) {
    let best = null;
    for (const entry of entries) {
      if (entry.status !== 'up') continue;
      for (const p of entry.pages || []) {
        if (!p.staticDir) continue;
        const route = p.route.replace(/\/$/, '');
        if (pathname === route || !pathname.startsWith(`${route}/`)) continue;
        const rel = pathname.slice(route.length + 1);
        if (!rel || rel.includes('..')) continue;
        // The page's own file wins over its static dir, so /wall/render and a page named after a
        // script can never shadow each other.
        if (p.file && pathname === p.route) continue;
        if (!best || p.route.length > best.page.route.length) best = { entry, page: p, rel };
      }
    }
    return best;
  }

  async function dispose() {
    for (const entry of entries) {
      try {
        if (entry.api && typeof entry.api.dispose === 'function') await entry.api.dispose();
        if (entry.settings && typeof entry.settings.flush === 'function') entry.settings.flush();
      } catch (err) {
        log.warn(`dispose ${entry.id}: ${err.message}`);
      }
    }
  }

  function describe() {
    return entries.map((e) => ({
      id: e.id,
      title: e.manifest.title,
      version: e.manifest.version || '0.0.0',
      order: e.manifest.order || 100,
      icon: e.manifest.icon || null,
      description: e.manifest.description || '',
      status: e.status,
      error: e.error,
      channels: e.api && Array.isArray(e.api.channels) ? e.api.channels : [],
      pages: (e.pages || []).map((p) => p.route),
      settings: e.settings ? e.settings.describe() : {},
      ui: e.manifest.ui || null,
    }));
  }

  return { entries, byId, match, page, pageFile, dispose, describe };
}

export function requireModule(reg, id) {
  const e = reg.byId.get(id);
  if (!e) throw new HttpError(404, `no module "${id}"`);
  if (e.status !== 'up') throw new HttpError(503, `module "${id}" is ${e.status}: ${e.error}`);
  return e;
}
