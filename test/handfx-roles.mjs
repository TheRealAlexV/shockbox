// The page verdict is per role.
//   node test/handfx-roles.mjs
//
// Node-only: mounts the handfx routes on an http.Server on an OS-assigned port and drives it with
// /ack calls. No browser, no camera, no timer: `Date.now` is a fake clock so the ack ordering that
// used to fool `freshestPage` can be replayed exactly.
//
// The scenario is the live `clientList` from build 40dbbce9f013: a null-role document from an
// older build, a transient `module-start` document, and the live `/shockfx` document. The live
// document is the OLDER one on purpose — freshest-ack-wins picks the boot row, and must not.

import http from 'node:http';

const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---- a settings document with the keys status()/build() read -------------------------------
const values = new Map([
  ['ratio', '16:9'],
  ['trackingSource', 'auto'],
  ['publish', 'off'],
  ['cameraRelay', 'off'],
  ['cameraRelaySource', 'none'],
  ['cameraRelayFps', 30],
  ['cameraRelaySize', '1280x720'],
  ['ffmpegPath', ''],
  ['cameraRelayCapture', ''],
  ['cameraRelayKeepWarm', false],
]);
const settings = {
  get: (k) => (values.has(k) ? values.get(k) : null),
  all: () => Object.fromEntries(values),
  describe: () => ({ ratio: { value: '16:9', default: '16:9' } }),
  subscribe: () => () => {},
  patch: () => [],
  flush: () => {},
};
const events = { publish: () => ({ seq: 1, at: clock }), emit: () => {}, subscribe: () => () => {} };
const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const ctx = { settings, events, log, core: { settings } };

const mod = (await import('../modules/handfx/server.js')).default;
const routes = mod.routes(ctx);
const routeFor = (method, path) => routes.find((r) => r.method === method && r.path === path);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = url.pathname.replace(/^\/api\/handfx/, '');
  const route = routeFor(req.method, rel);
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    let body = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {}
    Promise.resolve(route.handler(req, res, url, body)).catch((e) => {
      res.writeHead(500);
      res.end(String(e && e.stack));
    });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/handfx`;

const status = async () => (await fetch(`${base}/status`)).json();
const ack = async (body, role = null) => {
  const q = role ? `?role=${encodeURIComponent(role)}` : '';
  const res = await fetch(`${base}/ack${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ack ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json().catch(() => null);
};

/** The pre-fix rule, kept here as the control: freshest `lastAckAt` across every client. */
const oldVerdictId = (list) => {
  let best = null;
  for (const c of list) if (!best || (c.lastAckAt || 0) > (best.lastAckAt || 0)) best = c;
  return best ? best.id : null;
};

// ---- the live scenario ---------------------------------------------------------------------
const LIVE = '70d0cd31-live';
const LEGACY = '6da5df94-legacy';
const BOOT = '459847ff-boot';
const LIVE_BUILD = '40dbbce9f013';
const OLD_BUILD = '182ff4dcadbd';

clock += 0;
await ack({
  clientId: LIVE, build: LIVE_BUILD, anchors: 'camera', draws: 4918, loopTicks: 4918,
  phases: ['module-start', 'first-ack', 'first-draw'], wantsFeed: false,
}, '/shockfx');

clock += 0;
await ack({
  clientId: LEGACY, build: OLD_BUILD, anchors: 'camera', draws: 39754, loopTicks: 39754,
  phases: ['first-ack'], wantsFeed: false,
}); // no role and no Referer: a document from before ?role= existed

clock += 250; // the boot row is the FRESHEST ack of all three
await ack({
  clientId: BOOT, build: LIVE_BUILD, anchors: 'none', draws: 0, loopTicks: 0,
  phases: ['module-start'], wantsFeed: false,
}, '/shockfx');

console.log('\n1. the live array (boot row has the newest ack, live /shockfx is the older one)');
let livePayload = null;
{
  const s = await status();
  livePayload = s;
  const list = s.cameraFeed.clientList;
  ok('old rule picks the boot row (the defect)', oldVerdictId(list) === BOOT, oldVerdictId(list));
  ok('headline is /shockfx', s.pageRoles.headlineRole === '/shockfx' && s.pageRoles.headline?.role === '/shockfx');
  ok('headline row is the live document, not the boot row', s.pageRoles.headline?.clientId === LIVE, s.pageRoles.headline?.clientId);
  ok('headline build is the live document\'s', s.pageRoles.headline?.build === LIVE_BUILD);
  ok('headline says live and drawing', s.pageRoles.headline?.live === true && s.pageRoles.headline?.drawing === true);
  ok('top-level pageState follows it', s.pageState === 'live', s.pageState);
  ok('top-level clientBuild follows it', s.clientBuild === LIVE_BUILD, s.clientBuild);
  ok(
    'buildMatches/buildStale follow it',
    s.buildMatches === (LIVE_BUILD === s.build) && s.buildStale === (LIVE_BUILD !== s.build),
    `${s.clientBuild} vs server ${s.build}: ${s.buildMatches}/${s.buildStale}`,
  );
  ok('legacy row is present but not a candidate', (list.find((c) => c.id === LEGACY) || {}).candidate === false);
  ok('boot row is still a candidate (role matches)', (list.find((c) => c.id === BOOT) || {}).candidate === true);
  ok('null-role group is reported, not authoritative', (s.pageRoles.roles.find((r) => r.role === null) || {}).clientId === LEGACY);
}

// ---- the null-role row acks last: the strongest form of the old lie ------------------------
clock += 250;
await ack({ clientId: LEGACY, build: OLD_BUILD, anchors: 'camera', draws: 39755, loopTicks: 39755 });
clock += 0;

console.log('\n2. the null-role legacy row is now the FRESHEST ack of all three');
{
  const s = await status();
  const list = s.cameraFeed.clientList;
  ok('old rule picks the null-role row (the defect)', oldVerdictId(list) === LEGACY, oldVerdictId(list));
  ok('new verdict still follows live /shockfx', s.pageRoles.headline?.clientId === LIVE, s.pageRoles.headline?.clientId);
  ok('pageState stays live, on the live build', s.pageState === 'live' && s.clientBuild === LIVE_BUILD);
}

// ---- the boot row goes quiet: it ages out of its role's verdict ------------------------------
clock = 1_700_000_000_000 + 3500;
await ack({ clientId: LIVE, build: LIVE_BUILD, anchors: 'camera', draws: 4919, loopTicks: 4919, phases: ['module-start', 'first-ack', 'first-draw'] }, '/shockfx');
clock += 7500; // the live document keeps acking; the boot row's last ack is now 10.75 s old
await ack({ clientId: LIVE, build: LIVE_BUILD, anchors: 'camera', draws: 4920, loopTicks: 4920, phases: ['module-start', 'first-ack', 'first-draw'] }, '/shockfx');

console.log('\n3. the boot row has not acked for 10.75 s');
{
  const s = await status();
  const list = s.cameraFeed.clientList;
  const boot = list.find((c) => c.id === BOOT);
  ok('boot row is listed as stale', boot?.state === 'stale', boot?.state);
  ok('boot row is no longer a candidate', boot?.candidate === false);
  ok('its ack age is reported', boot?.ackAgeMs === 10_750, String(boot?.ackAgeMs));
  ok('headline is still the live document', s.pageRoles.headline?.clientId === LIVE);
}

// ---- the whole page goes silent: say so, do not pick a corpse -------------------------------
clock += 15_000;

console.log('\n4. every document has been silent for 15 s');
{
  const s = await status();
  ok('headline reports no authoritative row', s.pageRoles.headline?.state === 'absent', s.pageRoles.headline?.state);
  ok('pageState is page-dead', s.pageState === 'page-dead', s.pageState);
  ok('every row reads stale', s.cameraFeed.clientList.every((c) => c.state === 'stale' && c.candidate === false));
  ok('reported keys are unchanged', ['pageState', 'clientBuild', 'buildMatches', 'buildStale', 'reason'].every((k) => k in s));
}

console.log(`\n5. /status for the three-row scenario (live /shockfx is the older ack)\n${JSON.stringify({
  pageState: livePayload.pageState,
  stale: livePayload.stale,
  clientBuild: livePayload.clientBuild,
  buildMatches: livePayload.buildMatches,
  buildStale: livePayload.buildStale,
  reason: livePayload.reason,
  pageRoles: livePayload.pageRoles,
}, null, 2)}`);

Date.now = realNow;
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
