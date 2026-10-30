#!/usr/bin/env node
// ShockBox server entry point.
//
//   node server.mjs                 # normal
//   SHOCKBOX_PORT=8973 node server.mjs
//   EP_COMPAT=1 node server.mjs     # additionally serve the popups' legacy port 8787
//
// Config resolution order: CLI flag > env > config.json next to this file > default.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLog } from './core/log.mjs';
import { createEvents } from './core/events.mjs';
import { loadRegistry } from './core/registry.mjs';
import { createObsClient } from './core/obs.mjs';
import { Settings } from './core/settings.mjs';
import { createPool, poolRoutes } from './core/pool.mjs';
import { createServer } from './core/server-http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function readConfig() {
  const f = path.join(HERE, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

const cfg = readConfig();
const PORT = Number(arg('port', process.env.SHOCKBOX_PORT || process.env.PORT || cfg.port || 8972));
const HOST = arg('host', process.env.SHOCKBOX_HOST || cfg.host || '127.0.0.1');
const STATE_DIR = path.resolve(arg('state', process.env.SHOCKBOX_STATE || cfg.stateDir || path.join(HERE, 'state')));
const PUBLIC_DIR = path.join(HERE, 'public');
const COMPAT_PORT = has('no-compat') ? 0 : Number(process.env.EP_COMPAT === '1' ? process.env.EP_COMPAT_PORT || 8787 : cfg.compatPort || 0);
const OBS_URL = cfg.obs?.url || 'ws://127.0.0.1:4455';
const OBS_PASSWORD = cfg.obs?.password || '';
const OBS_ENABLED = cfg.obs?.enabled !== false;

fs.mkdirSync(STATE_DIR, { recursive: true });
const log = createLog({ dir: STATE_DIR });
const root = log.scope('core');

log.info(`ShockBox ${VERSION} — pid ${process.pid}, node ${process.version}`);
log.info(`state ${STATE_DIR}`);
log.info(`public ${PUBLIC_DIR}`);

const events = createEvents({ log: log.scope('events') });

const coreSettings = new Settings({
  dir: path.join(STATE_DIR, 'core'),
  file: 'settings.json',
  log: root,
  schema: {
    // The scenes that pin the wall to 16:9 while they are live (a17). One list, core-owned: the
    // wall module reads it through ctx.settings, and /health reports it, so the pane's editor and
    // the state machine can never disagree about what is being forced.
    forceScenes: {
      type: 'array',
      items: 'string',
      default: ['Desktop', 'Theater', 'PHub', 'OnlyFans', 'CominOut'],
      label: 'Scenes that force 16:9',
      group: 'ratio',
    },
    obsEnabled: { type: 'boolean', default: OBS_ENABLED, label: 'Talk to OBS over obs-websocket', group: 'obs' },
    obsUrl: { type: 'string', default: OBS_URL, label: 'obs-websocket URL', group: 'obs' },
    compatPort: { type: 'number', default: COMPAT_PORT, min: 0, max: 65535, integer: true, label: 'Legacy popup port (0 = off)', group: 'compat' },
    publicUrl: { type: 'string', default: `http://127.0.0.1:${PORT}`, label: 'Public base URL', group: 'general' },
  },
});

// The message pool is core, not a module: notifications and alerts are two modules over one
// list (see core/pool.mjs for why). It is loaded before the registry so a module's init can
// read it, and it publishes on the `pool` channel.
const pool = createPool({
  file: path.join(STATE_DIR, 'pool.json'),
  log: log.scope('pool'),
  onChange: (reason) => {
    try {
      events.emit('pool', 'pools', { ...pool.view('all'), reason });
    } catch (err) {
      root.error(`pool broadcast: ${err.message}`);
    }
  },
});
pool.load();

const obs = createObsClient({
  url: coreSettings.get('obsUrl') || OBS_URL,
  password: OBS_PASSWORD,
  log: log.scope('obs'),
});

const registry = await loadRegistry({
  modulesDir: path.join(HERE, 'modules'),
  stateDir: STATE_DIR,
  log: root,
  ctx: {
    core: { version: VERSION, here: HERE, publicDir: PUBLIC_DIR, stateDir: STATE_DIR, port: PORT, url: `http://127.0.0.1:${PORT}` },
    events,
    obs,
    log: root,
    settings: coreSettings,
    pool,
    // Filesystem and state-file helpers for modules that keep their own documents (the wall's
    // last-known engine state). Modules never build paths themselves.
    fs,
    paths: {
      dir: (id) => path.join(STATE_DIR, id),
      stateFile: (id, name) => path.join(STATE_DIR, id, name),
    },
    // Per-module settings document, created by the registry from a manifest `settings` map.
    makeSettings: (opts) => new Settings({ log: root, ...opts }),
  },
});

const httpServer = createServer({
  port: PORT,
  host: HOST,
  stateDir: STATE_DIR,
  publicDir: PUBLIC_DIR,
  registry,
  events,
  obs,
  log: root,
  version: VERSION,
  core: {
    settings: coreSettings,
    // Shared surfaces core answers for every module: the message pool and the pool channel.
    extraRoutes: [...poolRoutes({ pool, events, log: log.scope('pool') })],
    channels: ['pool','core'],
    obsStatus: () => ({
      enabled: coreSettings.get('obsEnabled'),
      state: obs.state,
      scene: obs.scene,
      forceScenes: coreSettings.get('forceScenes'),
    }),
  },
});

async function main() {
  const addr = await httpServer.listen(HOST, PORT);
  log.info(`listening on http://${addr.address}:${addr.port}`);

  if (coreSettings.get('obsEnabled')) {
    try {
      obs.connect();
    } catch (err) {
      log.warn(`obs: ${err.message}`);
    }
  }

  // Legacy port for the popups' deck actions and OBS sources during cutover. One process, two
  // listeners — never a second scheduled task.
  const compatPort = coreSettings.get('compatPort');
  if (compatPort && compatPort !== addr.port) {
    const legacy = registry.byId.get('notifications');
    const legacyRoutes = legacy && legacy.status === 'up' ? legacy.api.legacyRoutes?.() : null;
    if (!legacyRoutes) {
      log.warn(`compat port ${compatPort} requested but no module provides legacy routes — skipped`);
    } else {
      const compat = (await import('./core/compat-port.mjs')).createCompatServer({
        port: compatPort,
        routes: legacyRoutes,
        registry,
        events,
        log: log.scope('compat'),
      });
      try {
        await compat.listen('127.0.0.1', compatPort);
        log.info(`legacy popup surface on http://127.0.0.1:${compatPort}`);
      } catch (err) {
        log.error(`legacy port ${compatPort} failed: ${err.message}`);
      }
    }
  }
}

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  log.info(`${sig} — shutting down`);
  try {
    coreSettings.flush();
    await registry.dispose();
    events.close();
    obs.close();
    await httpServer.close();
  } catch (err) {
    log.error(`shutdown: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log.error(`uncaught: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  log.error(`unhandled rejection: ${err && err.stack ? err.stack : err}`);
});

main().catch((err) => {
  log.error(`startup failed: ${err.stack || err.message}`);
  process.exit(1);
});
