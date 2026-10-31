// One append log, per-module prefix. Ring buffer for the UI, file append for after-the-fact.
//
// `file` overrides the log file's path; `dir` is where the dated file goes when it is not given
// (the state directory by default, or `--log-dir`).
//
// Rotating is the whole point of this file, so it is deliberately paranoid. A log line can be a
// repeating error (an EPIPE on stdout, a reconnect loop): left alone it filled 275 GB of disk in
// one afternoon. So the file is written through a byte budget that is checked on every write, not
// at boot.
//
// MAX_BYTES is a ceiling on the whole family, not on one file: the live file plus `keep` kept
// predecessors, so 8MB x (1 + 3) = 32MB by default. Rotation renames the live file to `.1` and
// shifts each older generation up one, dropping the one past `keep`. Rotation failing is not fatal
// and never recurses: the next line just tries again.

import fs from 'node:fs';
import path from 'node:path';

const RING_MAX = 500;
// Budget for one generation. The family as a whole is bounded by maxBytes * (1 + keep).
export const MAX_BYTES = 8 * 1024 * 1024;
// Previous generations kept. Zero would mean the live file is never rotated out of the way.
export const KEEP = 3;

// Size of a path, or 0 when it is missing / unreadable. Used everywhere a stat may fail.
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function createLog({ dir, file: filePath = null, console: toConsole = true, maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  const ring = [];
  let file = null;
  let size = 0;

  function rotate() {
    // Drop the oldest generation that is in the way, then shift the rest up. Each step is
    // separate so a locked file on Windows only strands that one generation; the next write
    // retries the whole chain. Never call rotation from here.
    try {
      fs.rmSync(`${file}.${keep}`, { force: true });
    } catch {
      /* nothing there, or locked and it stays one more round */
    }
    for (let i = keep - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* this generation is absent or locked: leave it, keep counting */
      }
    }
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* rename can fail on Windows when a reader holds the file: leave it, keep counting */
    }
    // The live path may or may not exist now (a failed rename left it in place), so ask the fs
    // rather than assuming zero. Whichever way it went, the counter matches the disk.
    size = sizeOf(file);
  }

  function open(target) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      file = target;
      size = sizeOf(target);
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
    keep,
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

// Bound a whole directory of logs, not just the one createLog writes.
//
// Why this exists: the launcher redirects node's stdout/stderr into the same dated file, so a
// crash and restart loop appends bytes the app never accounted for, and the launcher's own
// `launcher-YYYY-MM-DD.log` has no writer in this process to budget at all. Counting the
// directory afterwards is the only place those bytes can be seen.
//
// Newest `keep` entries survive; the rest are deleted. If the survivors still exceed maxTotal the
// oldest of them are truncated to zero rather than deleted: a gap in the history is worse than an
// empty file, and an empty file still bounds the total.
export function compactDir({ dir, prefix = 'shockbox-', maxTotal = 64 * 1024 * 1024, keep = 4, log = null } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: [], truncated: [], total: 0 };
  }

  const entries = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      // Directories are not logs, and removing/truncating one would be destructive.
      if (!st.isFile()) continue;
      entries.push({ name, path: p, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* vanished between readdir and stat: not ours to account for */
    }
  }

  // Newest first, so the survivors are the front of the list. Tie-break on name for a stable
  // order when two files land in the same millisecond.
  entries.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

  const removed = [];
  for (const entry of entries.slice(keep)) {
    try {
      fs.rmSync(entry.path, { force: true });
      removed.push(entry.name);
    } catch {
      /* locked: leave it, it will be a candidate again on the next pass */
    }
  }

  // Re-stat the survivors: something may have appended or been rotated since the first stat.
  const survivors = [];
  for (const entry of entries.slice(0, keep)) {
    const size = sizeOf(entry.path);
    if (size > 0) survivors.push({ name: entry.name, path: entry.path, size, mtime: entry.mtime });
  }
  survivors.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

  let total = survivors.reduce((sum, s) => sum + s.size, 0);
  const truncated = [];
  for (const entry of survivors) {
    if (total <= maxTotal) break;
    try {
      fs.truncateSync(entry.path, 0);
      total -= entry.size;
      truncated.push(entry.name);
    } catch {
      /* locked: the total stays over budget this round, the next pass tries again */
    }
  }

  if (log && (removed.length || truncated.length)) {
    const keptMiB = (total / (1024 * 1024)).toFixed(1);
    log.info(
      `log dir ${dir}: removed ${removed.length}, truncated ${truncated.length}, ${keptMiB} MiB kept`,
    );
  }

  return { removed, truncated, total };
}
