// One append log, per-module prefix. Ring buffer for the UI, file append for after-the-fact.
//
// `file` overrides the log file's path; `dir` is where the dated file goes when it is not given
// (the state directory by default, or `--log-dir`).
//
// Rotating is the whole point of this file, so it is deliberately paranoid. A log line can be a
// repeating error (an EPIPE on stdout, a reconnect loop): left alone it filled 275 GB of disk in
// one afternoon. So the file is written through a byte budget that is checked on every write, not
// at boot, and rotation is a rename to `.1` (one previous kept) when the budget is crossed.
// Rotation failing is not fatal and never recurses: the next line just tries again.

import fs from 'node:fs';
import path from 'node:path';

const RING_MAX = 500;
// Per-file budget. Two files of this size is the most the process will ever hold.
export const MAX_BYTES = 8 * 1024 * 1024;

export function createLog({ dir, file: filePath = null, console: toConsole = true, maxBytes = MAX_BYTES } = {}) {
  const ring = [];
  let file = null;
  let size = 0;

  function rotate() {
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* rename can fail on Windows when a reader holds the file: leave it, keep counting */
    }
    size = 0;
  }

  function open(target) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let existing = 0;
      try {
        existing = fs.statSync(target).size;
      } catch {
        /* no file yet */
      }
      file = target;
      size = existing;
      if (size > maxBytes) rotate();
    } catch {
      file = null;
      size = 0;
    }
  }

  const target = filePath || (dir ? path.join(dir, 'shockbox.log') : null);
  if (target) open(target);

  function writeFile(text) {
    if (!file) return;
    const buf = text + '\n';
    if (size + buf.length > maxBytes) rotate();
    if (!file) return;
    try {
      fs.appendFileSync(file, buf);
      size += Buffer.byteLength(buf);
    } catch {
      /* disk full / locked: never crash on a log line, never log the failure from in here */
    }
  }

  function line(scope, level, msg) {
    const at = new Date().toISOString();
    const text = `${at} ${level.padEnd(5)} [${scope}] ${msg}`;
    ring.push({ at, scope, level, msg });
    if (ring.length > RING_MAX) ring.shift();
    if (toConsole) {
      // stdout can be a closed pipe (the launcher went away). Swallow it: an uncaught EPIPE here
      // is what used to recurse through the uncaughtException handler into this same function.
      try {
        const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
        stream.write(text + '\n');
      } catch {
        /* no console */
      }
    }
    writeFile(text);
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
    get file() {
      return file;
    },
    get size() {
      return size;
    },
    maxBytes,
    rotate: () => {
      if (file) rotate();
    },
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
