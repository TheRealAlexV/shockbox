// One append log, per-module prefix. Ring buffer for the UI, file append for after-the-fact.

import fs from 'node:fs';
import path from 'node:path';

const RING_MAX = 500;

export function createLog({ dir, console: toConsole = true } = {}) {
  const ring = [];
  let file = null;

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'shockbox.log');
      // Rotate once at boot if the file is over 4 MB; keeps one previous, no timers.
      try {
        const st = fs.statSync(file);
        if (st.size > 4 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet */
      }
    } catch {
      file = null;
    }
  }

  function line(scope, level, msg) {
    const at = new Date().toISOString();
    const text = `${at} ${level.padEnd(5)} [${scope}] ${msg}`;
    ring.push({ at, scope, level, msg });
    if (ring.length > RING_MAX) ring.shift();
    if (toConsole) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(text + '\n');
    if (file) {
      try {
        fs.appendFileSync(file, text + '\n');
      } catch {
        /* disk full / locked: never crash on a log line */
      }
    }
  }

  const api = {
    scope(name) {
      return {
        // A scoped logger points back at the root, so anything global (the log ring behind
        // /api/log, the file path) is reachable from any scope.
        root: api,
        info: (m) => line(name, 'info', m),
        warn: (m) => line(name, 'warn', m),
        error: (m) => line(name, 'error', m),
        debug: (m) => {
          if (process.env.SHOCKBOX_DEBUG) line(name, 'debug', m);
        },
      };
    },
    recent: (limit = RING_MAX) => ring.slice(-limit),
    file,
  };
  // The root logger is also callable as a logger (server.mjs and core use it for core lines),
  // with the same three levels the scoped loggers have.
  api.info = (m) => line('core', 'info', m);
  api.warn = (m) => line('core', 'warn', m);
  api.error = (m) => line('core', 'error', m);
  api.debug = (m) => {
    if (process.env.SHOCKBOX_DEBUG) line('core', 'debug', m);
  };
  return api;
}
