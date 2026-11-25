// The merged show-preview follows only the settings *document*: its iframe is
// `/wall/portrait?preview=1&agent=off`, so no bus command ever reaches it. This gate proves the
// document carries the two facts that used to be bus-only — the preset the wall should run, and
// blackout — and that the page-side rule resolves the preset name with no page online.
//
// Offline and cheap: a real server on a free port, plus the rule boot.js defines (extracted the
// way server.js reads PRESET_DIMS out of engine.js). No headless Chrome: the render page applies
// documents in WebGL, and each Chrome under SwiftShader holds a core.
//
//   node test/wall-preview-sync.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let failures = 0;
/** Report every miss instead of stopping at the first: one run says where all of it stands. */
function ok(cond, what, detail) {
  if (cond) {
    console.log(`ok   ${what}`);
  } else {
    failures += 1;
    console.log(`FAIL ${what}${detail ? ' — ' + detail : ''}`);
  }
}

async function boot(stateDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--state', stateDir], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i += 1) {
    await sleep(200);
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {
      /* starting */
    }
  }
  if (!up) {
    child.kill('SIGTERM');
    throw new Error('server did not come up');
  }
  return { base, stop: () => child.kill('SIGTERM') };
}

const json = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const patch = (base, body) =>
  json(`${base}/api/wall/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wall-preview-'));
let srv = await boot(stateDir);
const settings = async () => (await json(`${srv.base}/api/wall/render?preview=1`)).body?.settings || {};

try {
  // 1. The document the merged panel reads.
  let look = (await settings()).look || {};
  ok('blackout' in look, 'the preview document carries blackout (agent=off has no other channel)', `keys: ${Object.keys(look).length}`);
  ok('preset' in look, 'the preview document carries the preset name');

  // 2. The pane writes blackout the way it already writes palette and pattern.
  let out = (await patch(srv.base, { blackout: 1 })).body || {};
  ok(!(out.dropped || []).includes('blackout'), 'the settings schema owns blackout, so the document keeps it', JSON.stringify(out.dropped));
  const stored = out.settings?.blackout;
  ok(Number(stored && typeof stored === 'object' ? stored.value : stored) === 1, 'blackout=1 is stored');
  look = (await settings()).look || {};
  ok(Number(look.blackout) === 1, 'blackout reaches the merged panel');

  // 3. The pane's own (uncommitted) document is the same channel.
  await json(`${srv.base}/api/wall/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ look: { ...look } }),
  });
  out = (await json(`${srv.base}/api/wall/preview`)).body || {};
  ok(Number(out.settings?.look?.blackout) === 1, 'a pane document carries blackout to the panel');

  // 4. Off again: the pane reads the document, so it has a real state to invert.
  await patch(srv.base, { blackout: 0 });
  look = (await settings()).look || {};
  ok(Number(look.blackout) === 0, 'blackout turns back off in the document');
  await json(`${srv.base}/api/wall/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ look: { ...look } }),
  });
  out = (await json(`${srv.base}/api/wall/preview`)).body || {};
  ok(Number(out.settings?.look?.blackout) === 0, 'a pane document carries blackout off to the panel');

  // 5. A preset reaches the panel by name; it is the name the document holds.
  await patch(srv.base, { preset: 'arctic' });
  look = (await settings()).look || {};
  ok(look.preset === 'arctic', 'a preset change reaches the merged panel by name');

  // 6. The page-side rule boot.js uses, extracted and run (no page, no bus).
  const bootSrc = fs.readFileSync(path.join(ROOT, 'modules/wall/engine/boot.js'), 'utf8');
  const ruleSrc = /function presetToApply\(([\s\S]*?)\n {2}\}/.exec(bootSrc);
  ok(!!ruleSrc, 'boot.js defines the preview-side preset rule');
  let rule = () => '';
  if (ruleSrc) rule = vm.runInNewContext(`(function presetToApply(${ruleSrc[1]}\n})`);
  ok(rule('arctic', 'neonwave') === 'arctic', 'the document names a preset the page is not running: apply it');
  ok(rule('arctic', 'arctic') === '', 'the page already runs that preset: no re-apply');
  ok(rule('', 'arctic') === '' && rule(undefined, 'x') === '', 'a document with no name leaves the page alone');

  // 7. Applying it changes the render: the catalogue look differs from the document look.
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'modules/wall/engine/presets/presets.js'), 'utf8'), sandbox);
  const preset = (sandbox.window.LEDWALL_PRESETS || {}).arctic || null;
  const differs = preset ? Object.keys(preset).filter((k) => JSON.stringify(preset[k]) !== JSON.stringify(look[k])) : [];
  ok(differs.length >= 3, 'the named preset differs from the document look, so applying it repaints', differs.slice(0, 6).join(','));

  // 8. agent=off gates the bus, not the apply pipeline.
  const engineSrc = fs.readFileSync(path.join(ROOT, 'modules/wall/engine/engine.js'), 'utf8');
  const startAgent = /_startAgent = function \(url[\s\S]*?\n {2}\};/.exec(engineSrc);
  const offAt = startAgent ? startAgent[0].indexOf("url === 'off'") : -1;
  const clientAt = startAgent ? startAgent[0].indexOf('new AgentClient') : -1;
  ok(offAt > -1 && clientAt > -1 && offAt < clientAt, 'agent=off returns before the bus client is created');
  const applyPreset = /Instance\.prototype\.applyPreset = function[\s\S]*?\n {2}\};/.exec(engineSrc);
  ok(!!applyPreset && !/this\.agent\b/.test(applyPreset[0]), 'applyPreset reads no agent: the bus cannot gate the apply');
  const reapply = /inst\.reapplyServerLook = function[\s\S]*?\n {2}\};/.exec(bootSrc);
  const applyAt = reapply ? reapply[0].indexOf('applyLook(d)') : -1;
  const agentAt = reapply ? reapply[0].indexOf('inst.agent') : -1;
  ok(applyAt > -1 && (agentAt === -1 || applyAt < agentAt), 'reapplyServerLook applies the document before any agent bookkeeping');

  // 9. Pane wiring: the toggle writes the document and keeps both directions.
  const paneSrc = fs.readFileSync(path.join(ROOT, 'modules/wall/ui/pane.js'), 'utf8');
  const toggle = /blackoutBtn\.addEventListener\('click',[\s\S]*?\n {2}\}\);/.exec(paneSrc);
  ok(!!toggle && /patchSettings\(\{ blackout: next \}/.test(toggle[0]), 'the pane writes blackout to the document as well as commanding it');
  ok(!!toggle && /next \? 'blackout\.on' : 'blackout\.off'/.test(toggle[0]), 'the toggle has a real off path');
  ok(/doc\.look\.blackout = /.test(paneSrc), 'previewDoc() carries blackout explicitly');

  // 10. Reload: a page that reloads reads the persisted document.
  await patch(srv.base, { blackout: 1 });
  await sleep(500);
  srv.stop();
  await sleep(300);
  srv = await boot(stateDir);
  look = (await settings()).look || {};
  ok(Number(look.blackout) === 1, 'blackout survives a merged-panel reload');
} finally {
  srv.stop();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
