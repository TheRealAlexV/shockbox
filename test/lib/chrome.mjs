// One headless-Chrome launcher for every gate that talks CDP.
//
// The gates each used to spawn Chrome with `stdio: 'ignore'` and poll a DevTools endpoint; when
// Chrome died at launch (no sandbox, no /dev/shm, a missing profile path, a muzzled crashpad
// handler) the test waited out its retry loop and threw a generic "did not expose…" — hiding the
// one line Chrome had already printed saying why. This module keeps Chrome's stderr in a ring
// buffer and spends it: a launch failure, an early exit, or a readiness timeout all throw with the
// exit code/signal and the tail of what Chrome said.
//
//   const { devtools, stop } = await launchChrome({ size: [1440, 900] });
//
// What it guarantees:
//   · binary from CHROME, then CHROME_PATH, then the /usr/bin names every gate already probed
//   · --no-sandbox only when CI is set (a runner user cannot use the setuid sandbox); never locally
//   · --disable-dev-shm-usage (Docker's /dev/shm is 64 MB and Chrome's renderer dies on it)
//   · a fresh profile per launch under os.tmpdir()
//   · readiness = /json/version answers AND a page target exists in /json/list — if no page target
//     registered, one is opened with PUT /json/new?about:blank rather than assuming the first tab
//     shows up in time
//   · timeout 30 s when CI is set, 15 s otherwise
//
// Anything a caller needs that this does not pass goes in `extraArgs`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const IN_CI = Boolean(process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0');

const PROBED = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

/** The Chrome binary every gate uses. `null` when none is installed. */
export function findChrome() {
  const given = process.env.CHROME || process.env.CHROME_PATH;
  if (given) return given;
  return PROBED.find((p) => fs.existsSync(p)) || null;
}

export const CHROME = findChrome();

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STDERR_LINES = 60;

/**
 * Start headless Chrome with the remote debugging endpoint up and one page target ready.
 *
 * @param {object} [opts]
 * @param {[number, number]} [opts.size]            [width, height] for --window-size
 * @param {string[]} [opts.extraArgs]               appended after the shared flags
 * @param {string} [opts.profilePrefix]             prefix for the temp profile dir
 * @param {number} [opts.timeoutMs]                 override the 30 s (CI) / 15 s readiness timeout
 * @returns {Promise<{devtools: string, wsUrl: string, port: number, profile: string, child: import('node:child_process').ChildProcess, stderr: () => string, stop: () => void}>}
 */
export async function launchChrome({ size = [1280, 720], extraArgs = [], profilePrefix = 'sb-chrome-', timeoutMs } = {}) {
  if (!CHROME) {
    throw new Error(`no chrome/chromium found (set CHROME= or CHROME_PATH=); probed ${PROBED.join(', ')}`);
  }
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--hide-scrollbars',
    `--window-size=${size[0]},${size[1]}`,
    ...(IN_CI ? ['--no-sandbox'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Ring buffer of Chrome's own words. stdout is read and dropped so a full pipe can never block
  // Chrome; stderr is what diagnostics come from.
  const lines = [];
  const keep = (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > STDERR_LINES * 4) lines.splice(0, lines.length - STDERR_LINES * 4);
    }
  };
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', keep);

  let exit = null; // { code, signal } once the process is gone
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      resolve();
    });
    child.on('error', (err) => {
      exit = { code: null, signal: `spawn error: ${err.message}` };
      keep(`launch failed: ${err.message}`);
      resolve();
    });
  });

  const t0 = Date.now();
  const stderrTail = (n = 40) => lines.slice(-n).join('\n') || '(chrome printed nothing)';
  const describe = () => {
    const how = exit ? `exited (code ${exit.code}, signal ${exit.signal})` : 'still running';
    const bits = [
      `chrome ${how} after ${Date.now() - t0} ms`,
      `binary: ${CHROME}`,
      `args: ${args.join(' ')}`,
      `stderr (last ${Math.min(lines.length, 40)} of ${lines.length} lines):`,
      stderrTail()
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    ];
    if (!exit && IN_CI) bits.push('CI run: --no-sandbox was passed; if Chrome is still alive, the DevTools endpoint may be bound elsewhere.');
    return bits.join('\n  ');
  };

  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (timeoutMs ?? (IN_CI ? 30_000 : 15_000));
  let version = null;

  while (Date.now() < deadline) {
    if (exit) throw new Error(`chrome did not start:\n  ${describe()}`);
    if (!version) {
      try {
        const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) version = await r.json();
      } catch {
        /* endpoint not up yet */
      }
    }
    if (version) {
      // A page target is what the gates attach to. Chrome 156's headless shell can come up before
      // its first tab is listed, so open one explicitly instead of waiting on the default tab.
      let wsUrl = null;
      try {
        const list = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) wsUrl = page.webSocketDebuggerUrl;
        else {
          const made = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
          if (made && made.webSocketDebuggerUrl) wsUrl = made.webSocketDebuggerUrl;
        }
      } catch {
        /* list raced the browser; retry on the next tick */
      }
      if (wsUrl) return { devtools: base, wsUrl, port, profile, child, stderr: stderrTail, stop };
    }
    await sleep(150);
  }

  // Timed out: give an exited process a moment to report, then say everything we know.
  await Promise.race([exited, sleep(500)]);
  stop();
  throw new Error(`chrome did not expose a page target within ${Math.round((Date.now() - t0) / 1000)} s:\n  ${describe()}`);
}
