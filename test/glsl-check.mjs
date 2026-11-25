// Extract a shader array (`var X = [ ... ].join('\n')`) from a classic engine script and check
// the GLSL compiles, in headless Chrome, the way the wall's own page would compile it.
//
//   node test/glsl-check.mjs                      # every shader in engine, sim and grade
//   node test/glsl-check.mjs --shader=sim.js:0    # one
//
// A shader is a JS array of literals separated by `//`-comment lines. The file is loaded through
// the same `vm` sandbox the page uses (no DOM), so what is checked is the exact string the GPU
// would get — not a re-quoted copy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGINE = path.join(ROOT, 'modules/wall/engine');
const CHROME = process.env.CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error('glsl-check: no chrome/chromium found (set CHROME=)');
  process.exit(2);
}

/**
 * Load a classic script in a bare sandbox and return { name: source } for every shader array it
 * declares. The engine scripts are IIFEs that only touch `window`/`document` inside functions
 * we never call, so a stub surface is enough to reach the declarations.
 */
function shadersIn(file) {
  const code = fs.readFileSync(file, 'utf8');
  const found = {};
  // The arrays are locals inside the IIFE, so they are captured by re-reading them textually:
  // each declaration is `var NAME = [ ... ].join('\n');` with the literals interspersed with
  // `//`-comment lines. Comments are dropped; literals are concatenated in order.
  const re = /var\s+([A-Z_]+)\s*=\s*\[((?:.|\n)*?)\]\.join\('\\n'\);/g;
  let m;
  while ((m = re.exec(code))) {
    const [, name, body] = m;
    const sandbox = { console, Math, Number, isFinite, String };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    try {
      // Evaluate the array literal in isolation: the literal is the body plus the join call.
      const src = `var ${name} = [${body}].join('\\n');` + name;
      found[name] = vm.runInContext(src, sandbox);
    } catch (err) {
      found[name] = { error: err.message };
    }
  }
  return found;
}

function kindOf(name) {
  if (/VERT/.test(name)) return 'vert';
  if (/FRAG/.test(name)) return 'frag';
  return null;
}

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--shader=')) || '').slice(9);
  const files = fs.readdirSync(ENGINE).filter((f) => f.endsWith('.js'));
  const shaders = [];
  for (const f of files) {
    const found = shadersIn(path.join(ENGINE, f));
    for (const [name, src] of Object.entries(found)) {
      const kind = kindOf(name);
      if (!kind) continue;
      const id = `${f}:${name}`;
      if (only && id !== only) continue;
      shaders.push({ id, kind, src });
      if (src && typeof src === 'object' && src.error) console.log(`FAIL ${id} — array did not evaluate: ${src.error}`);
    }
  }
  if (!shaders.length) {
    console.error(`glsl-check: no shader arrays found${only ? ` matching ${only}` : ''}`);
    process.exit(2);
  }

  const port = await freePort();
  const profile = fs.mkdtempSync('/tmp/glsl-check-');
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const devtools = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await fetch(`${devtools}/json/version`);
      break;
    } catch {
      /* not up */
    }
  }
  const list = await (await fetch(`${devtools}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let n = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  const expr = `(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { error: 'no webgl2 context' };
    const shaders = ${JSON.stringify(shaders.map((s) => ({ id: s.id, kind: s.kind, src: s.src })))};
    const out = [];
    for (const s of shaders) {
      if (typeof s.src !== 'string') { out.push({ id: s.id, ok: false, log: 'array undecidable' }); continue; }
      const sh = gl.createShader(s.kind === 'vert' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
      gl.shaderSource(sh, s.src);
      gl.compileShader(sh);
      out.push({ id: s.id, ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS), log: (gl.getShaderInfoLog(sh) || '').trim() });
      gl.deleteShader(sh);
    }
    out.push({ id: 'renderer', ok: true, log: gl.getParameter(gl.VERSION) + ' / ' + gl.getParameter(gl.RENDERER) });
    return { out };
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  ws.close();
  chrome.kill('SIGKILL');
  const res = r.result?.value;
  if (!res || res.error) {
    console.error(`glsl-check: ${res ? res.error : 'no result from the page'}`);
    process.exit(1);
  }
  let failed = 0;
  for (const row of res.out) {
    if (row.id === 'renderer') {
      console.log(`     GL: ${row.log}`);
      continue;
    }
    if (!row.ok) failed += 1;
    console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.id}${row.log ? ` — ${row.log}` : ''}`);
  }
  console.log(`\n${res.out.length - 1 - failed}/${res.out.length - 1} shaders compile`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`glsl-check: ${err.stack || err.message}`);
  process.exit(1);
});
