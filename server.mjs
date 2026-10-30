#!/usr/bin/env node
// ShockBox server entry point.
//
//   node server.mjs                 # normal
//   SHOCKBOX_PORT=8973 node server.mjs
//   EP_COMPAT=1 node server.mjs     # additionally serve the popups' legacy port 8787
//   node server.mjs --log-dir D     # log file in D instead of the state directory
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
// Where the process writes its own log file. The launcher redirects stdout/stderr to dated files
// next to it; this is the same stream, written straight to a file with the log ring behind
// /api/log. Defaults to the state directory, so a plain `node server.mjs` is unchanged.
const LOG_DIR = path.resolve(arg('log-dir', process.env.SHOCKBOX_LOG_DIR || cfg.logDir || STATE_DIR));
// Where the notification / alert tone clips live. Rig default; overridable for tests and for a
// checkout on another machine. Handed to the modules through the context; core does not read it.
const SOUNDS_DIR = path.resolve(arg('sounds', process.env.SHOCKBOX_SOUNDS || cfg.soundsDir || 'C:\\OBS\\Sounds\\SoundBoard'));
const PUBLIC_DIR = path.join(HERE, 'public');
const COMPAT_PORT = has('no-compat') ? 0 : Number(process.env.EP_COMPAT === '1' ? process.env.EP_COMPAT_PORT || 8787 : cfg.compatPort || 0);
const OBS_URL = cfg.obs?.url || 'ws://127.0.0.1:4455';
const OBS_PASSWORD = cfg.obs?.password || '';
const OBS_ENABLED = cfg.obs?.enabled !== false;

fs.mkdirSync(STATE_DIR, { recursive: true });
// The launcher writes stdout/stderr to `shockbox-YYYY-MM-DD.log` beside this; the app's own log
// file uses the same dated name so one day is one log, and the rotation stays as the fallback
// for a long-running day (`shockbox-YYYY-MM-DD.log.1`).
const LOG_FILE = path.join(LOG_DIR, `shockbox-${new Date().toISOString().slice(0, 10)}.log`);
const log = createLog({ dir: LOG_DIR, file: LOG_FILE });
const root = log.scope('core');

log.info(`ShockBox ${VERSION} — pid ${process.pid}, node ${process.version}`);
log.info(`state ${STATE_DIR}`);
log.info(`log ${LOG_DIR}`);
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

let registry = null;
const registryCtx = {
    sounds: SOUNDS_DIR,
    core: { version: VERSION, here: HERE, publicDir: PUBLIC_DIR, stateDir: STATE_DIR, soundsDir: SOUNDS_DIR, port: PORT, url: `http://127.0.0.1:${PORT}` },
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
};
// `notifications`: the registry itself, so a module can read another's API without core naming
// it (dialogs borrows the notifications module's sound store).
registryCtx.notifications = () => registry;
registry = await loadRegistry({
  modulesDir: path.join(HERE, 'modules'),
  stateDir: STATE_DIR,
  log: root,
  ctx: registryCtx,
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
    // Shared surfaces core answers for every module: the message pool and the pool channel,
    // plus anything a module registers at the origin (the notifications module's `/audio/<name>`).
    // Core never names the module; it asks every loaded module for its extra routes.
    extraRoutes: [
      ...poolRoutes({ pool, events, log: log.scope('pool') }),
      // Origin-level routes a module registers for itself (`/audio/<name>`). Evaluated here so a
      // module that fails cannot take the server down; `ctx.sounds` is already in the context.
      ...registry.entries
        .filter((e) => e.status === 'up' && typeof (e.api && e.api.coreExtraRoutes) === 'function')
        .flatMap((e) => {
          try {
            return e.api.coreExtraRoutes({ ...registryCtx, id: e.id, dir: e.dir, dataDir: e.dataDir, settings: e.settings, log: log.scope(e.id) }) || [];
          } catch (err) {
            log.warn(`${e.id}: coreExtraRoutes failed — ${err.message}`);
            return [];
          }
        }),
    ],
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
// An exception handler that logs is only safe while logging cannot itself throw. Both of these
// guard against a logging storm turning one failure into an infinite one: an EPIPE from a closed
// stdout used to re-enter here through `log.error` and write a stack trace per iteration.
const FATAL_WINDOW_MS = 60_000;
const FATAL_MAX = 100;
let fatal = { at: 0, count: 0 };

function onFatal(kind, err) {
  const now = Date.now();
  if (now - fatal.at > FATAL_WINDOW_MS) fatal = { at: now, count: 0 };
  fatal.at = now;
  if (++fatal.count > FATAL_MAX) {
    // Too many in a minute: stop writing and leave. A repeating uncaught error is not survivable.
    try {
      process.stderr.write(`shockbox: ${fatal.count} fatal errors in a minute, exiting\n`);
    } catch {
      /* stderr gone */
    }
    process.exit(1);
  }
  try {
    log.error(`${kind}: ${err && err.stack ? err.stack : err}`);
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (err) => {
  // EPIPE on stdout/stderr is the launcher's pipe closing, not an app fault: ignore it.
  if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) return;
  onFatal('uncaught', err);
});
process.on('unhandledRejection', (err) => onFatal('unhandled rejection', err));

main().catch((err) => {
  log.error(`startup failed: ${err.stack || err.message}`);
  process.exit(1);
});
