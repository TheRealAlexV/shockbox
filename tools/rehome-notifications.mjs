#!/usr/bin/env node
/* Re-home the phone-banner records from the Alerts pool into the Notifications pool.
 *
 *   node tools/rehome-notifications.mjs                 # dry run: list what would move
 *   node tools/rehome-notifications.mjs --apply         # move it
 *   node tools/rehome-notifications.mjs --apply --url http://127.0.0.1:8972
 *
 * The rule (explicit and auditable, never inferred):
 *     tags include "kind-notification"  AND  current kind === "dialog"
 * `kind-notification` is the facet the import/tag pass derived for records whose source store had
 * no button row — i.e. the 30 iMessage/WhatsApp/Discord/TikTok/Instagram/Messenger banners. `kind`
 * is still "dialog" because the original import had no other way to express the pool, so this pass
 * is what separates Alerts from Notifications. `kind-dialog` marks the 63 real alerts and is never
 * selected. Anything that is not exactly EXPECTED records is a refusal, not a guess.
 *
 * Route: POST /api/pool/dialogs/messages/:id/move { to: "notifications" } — the existing move route
 * in core/pool.mjs. No new endpoint. PATCH would also accept `kind`, but move() is the route that
 * expresses "this record lives in that pool", so it is the one used.
 *
 * Two things move() does that must be corrected to keep the records as they are:
 *   - it sets random = false for the notifications pool. These banners are random: true and belong
 *     in Random sends, so `random` is restored straight after the move (PATCH accepts it).
 *   - it does not touch `buttons`. Buttons stay: they are part of the record's functionality
 *     (the notifications overlay renders them; modules/notifications/overlay/app.js).
 * Everything else — text, title, tags, type, storm, icon — is never sent in a PATCH body, so the
 * server's partial update leaves it exactly as it was.
 *
 * Exit codes: 0 ok, 1 selection refused / run failed, 2 bad arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* The audited size of the set. The source store holds 30 banners, the live pool holds 30 records
 * marked kind-notification, and both counts were read, not assumed. A different number means the
 * pool has drifted and the rule would now catch something it was not written for. */
const EXPECTED = 30;

const SRC_POOL = 'dialogs';
const DST_POOL = 'notifications';
const SELECT_TAG = 'kind-notification';
const SELECT_KIND = 'dialog';

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function usage(msg) {
  if (msg) console.error(`rehome-notifications: ${msg}`);
  console.error(`
usage: node tools/rehome-notifications.mjs [--apply | --dry-run] [options]

  --apply            move the records (default: dry run, lists them and contacts nothing)
  --dry-run          list only (default)
  --url <base>       server base URL (default ${process.env.SHOCKBOX_URL || 'http://127.0.0.1:8972'})
  --expect <n>       required size of the selected set (default ${EXPECTED})
  --state-dir <dir>  where rehome.last.json goes (default <repo>/state)
  --out <file>       write the selected records to this JSON file
  -h, --help         this text
`);
  process.exit(msg ? 2 : 0);
}

if (has('help') || argv.includes('-h')) usage();
if (flag('apply') !== undefined && flag('apply') !== true) usage('--apply takes no value');

const APPLY = has('apply') && !has('dry-run');
const BASE = String(flag('url') || process.env.SHOCKBOX_URL || 'http://127.0.0.1:8972').replace(/\/+$/, '');
const EXPECT = Number(flag('expect') || EXPECTED);
const STATE_DIR = path.resolve(String(flag('state-dir') || path.join(ROOT, 'state')));
const MARKER = path.join(STATE_DIR, 'rehome.last.json');
const OUT = flag('out') === true ? null : flag('out');

if (!Number.isInteger(EXPECT) || EXPECT < 1) usage('--expect must be a positive integer');

/* ------------------------------------------------------------------ api */

function die(msg, code = 1) {
  console.error(`rehome-notifications: ${msg}`);
  process.exit(code);
}

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    die(`${method} ${route} failed — ${err.message}. Is ShockBox running at ${BASE}?`);
  }
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* reported below if the status is bad */
  }
  if (!res.ok) die(`${method} ${route} -> ${res.status} ${raw.slice(0, 300)}`);
  return json;
}

const countsOf = (j) => (j && j.counts) || (j && j.pools ? Object.fromEntries(j.pools.map((p) => [p.id, p.count])) : {});
const normTag = (s) => String(s ?? '').trim().toLowerCase();
const normTags = (list) => {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
};
const poolCount = async (id) => ((await api('GET', `/api/pool/${id}`)).messages || []).length;

/* The selection rule, in one place, so the same predicate decides what moves, what is reported and
 * what the post-move proof checks. */
const isBanner = (m) => m.kind === SELECT_KIND && normTags(m.tags).includes(SELECT_TAG);

const snapshot = (m) => ({
  id: m.id,
  kind: m.kind,
  type: m.type,
  text: m.text,
  textStart: String(m.text || '').slice(0, 60),
  tags: normTags(m.tags),
  buttons: Array.isArray(m.buttons) ? m.buttons.map((b) => ({ label: b.label, action: b.action })) : null,
  random: m.random === true,
  storm: m.storm === true,
});

/* ------------------------------------------------------------------ run */

if (!fs.existsSync(path.join(ROOT, 'core', 'pool.mjs'))) {
  die(`not inside the ShockBox checkout (${ROOT}) — run this from /home/alex/OBS/shockbox`);
}

console.log(`mode          ${APPLY ? `apply -> ${BASE}` : 'dry run (no server is contacted)'}`);
console.log(`rule          kind === "${SELECT_KIND}" AND tags include "${SELECT_TAG}"`);
console.log(`route         POST /api/pool/${SRC_POOL}/messages/:id/move { to: "${DST_POOL}" }`);
console.log(`expect        ${EXPECT} records`);

const poolsBefore = await api('GET', '/api/pools');
const countsBefore = countsOf(poolsBefore);
const dialogBefore = await poolCount(SRC_POOL);
const notifBefore = await poolCount(DST_POOL);
const allBefore = (await api('GET', '/api/pool/all')).messages || [];

const selected = allBefore.filter(isBanner);
const notSelectedDialogs = allBefore.filter((m) => m.kind === SELECT_KIND && !isBanner(m));

console.log('');
console.log(`before        all ${countsBefore.all ?? '?'}  ${SRC_POOL} ${dialogBefore}  ${DST_POOL} ${notifBefore}`);
console.log(`selected      ${selected.length}`);
console.log(`alert pool    ${notSelectedDialogs.length} record(s) stay in ${SRC_POOL}`);

/* A run on a pool where the re-home already happened must say "nothing to move", not refuse: the
 * counts are the proof, and refusing would look like a failure on a healthy pool. So the guard is
 * stated against the DESTINATION, not the selection: selected === 0 with the destination holding
 * EXPECT records means done. Anything else that is not exactly EXPECT is drift and refuses. */
const alreadyDone = selected.length === 0 && notifBefore === EXPECT;

if (!alreadyDone && selected.length !== EXPECT) {
  console.log('');
  console.log('selection:');
  for (const m of selected) console.log(`  ${m.id.padEnd(6)} ${String(m.kind).padEnd(9)} ${String(m.type).padEnd(10)} ${String(m.text).slice(0, 50)}`);
  die(
    `selected ${selected.length} record(s) and ${DST_POOL} holds ${notifBefore}, expected exactly ${EXPECT} — refusing to move anything`,
  );
}

if (alreadyDone) {
  console.log('');
  console.log(`${DST_POOL} already holds ${notifBefore} record(s) and no ${SELECT_KIND} carries "${SELECT_TAG}"`);
  console.log(`alerts        ${notSelectedDialogs.length} record(s) in ${SRC_POOL}`);
  if (APPLY) {
    const check = allBefore.filter((m) => m.kind === 'notification' && normTags(m.tags).includes(SELECT_TAG));
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const marker = {
      at: new Date().toISOString(),
      tool: 'tools/rehome-notifications.mjs',
      url: BASE,
      rule: `kind === "${SELECT_KIND}" AND tags include "${SELECT_TAG}"`,
      run: 'noop',
      selected: 0,
      moved: 0,
      counts: { before: countsBefore, after: countsBefore },
      pools: { [SRC_POOL]: { before: dialogBefore, after: dialogBefore }, [DST_POOL]: { before: notifBefore, after: notifBefore } },
      inDestination: { total: notifBefore, banners: check.length },
    };
    fs.writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);
    console.log(`marker        ${MARKER}  (${marker.at})`);
  }
  console.log('');
  console.log(APPLY ? 'ok — nothing to move (this was a re-run)' : 'dry run — nothing to move.');
  process.exit(0);
}

console.log('');
for (const m of selected) {
  const bits = [
    `${String(m.type).padEnd(10)}`,
    `random:${m.random === true}`,
    `storm:${m.storm === true}`,
    `buttons:${Array.isArray(m.buttons) && m.buttons.length ? m.buttons.map((b) => b.label).join('/') : 'none'}`,
    `${normTags(m.tags).length} tags`,
  ];
  console.log(`  ${m.id.padEnd(6)} ${bits.join('  ')}  ${String(m.text).slice(0, 52)}`);
}

if (OUT) {
  const file = path.resolve(OUT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(selected.map(snapshot), null, 2)}\n`);
  console.log(`\nwrote         ${file} (${selected.length} records)`);
}

if (!APPLY) {
  console.log('');
  console.log(`dry run — nothing sent. Re-run with --apply (and --url <base>) to move ${selected.length} record(s).`);
  process.exit(0);
}

/* ------------------------------------------------------------------ apply */

/* Snapshot every field we must be able to prove unchanged, keyed by id. `buttons` is part of the
 * contract here: the user's call is that buttons stay, because they are functionality. */
const before = new Map(allBefore.map((m) => [m.id, snapshot(m)]));
const alertsBefore = allBefore.filter((m) => m.kind === 'dialog' && !isBanner(m)).map(snapshot);

let moved = 0;
let randomRestored = 0;
let randomAlready = 0;

for (const m of selected) {
  await api('POST', `/api/pool/${SRC_POOL}/messages/${encodeURIComponent(m.id)}/move`, { to: DST_POOL });
  moved += 1;
  /* move() forces random = false in the notifications pool. These banners are random: true, so put
   * it back. Nothing else goes in the body — the PATCH is partial and must not touch buttons/tags. */
  if (m.random === true) {
    await api('PATCH', `/api/pool/all/messages/${encodeURIComponent(m.id)}`, { random: true });
    randomRestored += 1;
  } else {
    randomAlready += 1;
  }
  console.log(`  moved  ${m.id.padEnd(6)} -> ${DST_POOL}${m.random === true ? '  (random restored)' : ''}`);
}

/* ------------------------------------------------------------------ prove */

const poolsAfter = await api('GET', '/api/pools');
const countsAfter = countsOf(poolsAfter);
const dialogAfter = await poolCount(SRC_POOL);
const notifAfter = await poolCount(DST_POOL);
const notifMessages = (await api('GET', `/api/pool/${DST_POOL}`)).messages || [];
const allAfter = (await api('GET', '/api/pool/all')).messages || [];
const afterById = new Map(allAfter.map((m) => [m.id, m]));

const problems = [];

/* 1. The moved records are in the destination pool, and only they are. */
const expectedIds = new Set(selected.map((m) => m.id));
for (const id of expectedIds) if (!notifMessages.some((m) => m.id === id)) problems.push(`${id} is not in ${DST_POOL}`);
for (const m of notifMessages) if (!expectedIds.has(m.id)) problems.push(`${m.id} appeared in ${DST_POOL} without being selected`);

/* 2. Every moved record kept its identity: kind flipped to notification, and nothing else changed. */
for (const m of selected) {
  const now = afterById.get(m.id);
  if (!now) {
    problems.push(`${m.id} disappeared`);
    continue;
  }
  const was = before.get(m.id);
  if (now.kind !== 'notification') problems.push(`${m.id} kind is ${now.kind}, expected notification`);
  if (now.text !== was.text) problems.push(`${m.id} text changed`);
  if (now.type !== was.type) problems.push(`${m.id} type changed`);
  if (JSON.stringify(normTags(now.tags)) !== JSON.stringify(was.tags)) problems.push(`${m.id} tags changed`);
  const btnsNow = JSON.stringify(Array.isArray(now.buttons) ? now.buttons.map((b) => ({ label: b.label, action: b.action })) : null);
  if (btnsNow !== JSON.stringify(was.buttons)) problems.push(`${m.id} buttons changed (${btnsNow})`);
  if ((now.random === true) !== was.random) problems.push(`${m.id} random ${was.random} -> ${now.random}`);
  if ((now.storm === true) !== was.storm) problems.push(`${m.id} storm ${was.storm} -> ${now.storm}`);
}

/* 3. The alerts did not move, and were not touched at all. */
for (const was of alertsBefore) {
  const now = afterById.get(was.id);
  if (!now) {
    problems.push(`${was.id} (alert) disappeared`);
    continue;
  }
  if (now.kind !== 'dialog') problems.push(`${was.id} (alert) kind changed to ${now.kind}`);
  if (JSON.stringify(snapshot(now)) !== JSON.stringify(was)) problems.push(`${was.id} (alert) was modified`);
}

/* 4. The pool arithmetic adds up. */
if (dialogAfter !== dialogBefore - moved) problems.push(`${SRC_POOL} ${dialogBefore} - ${moved} != ${dialogAfter}`);
if (notifAfter !== notifBefore + moved) problems.push(`${DST_POOL} ${notifBefore} + ${moved} != ${notifAfter}`);
if ((countsAfter.all ?? null) !== (countsBefore.all ?? null)) problems.push(`all changed ${countsBefore.all} -> ${countsAfter.all}`);
if ((countsAfter.wall ?? null) !== (countsBefore.wall ?? null)) problems.push(`wall changed ${countsBefore.wall} -> ${countsAfter.wall}`);
if ((countsAfter.random ?? null) !== (countsBefore.random ?? null)) problems.push(`random pool changed ${countsBefore.random} -> ${countsAfter.random}`);

const leftovers = allAfter.filter(isBanner);

const marker = {
  at: new Date().toISOString(),
  tool: 'tools/rehome-notifications.mjs',
  url: BASE,
  rule: `kind === "${SELECT_KIND}" AND tags include "${SELECT_TAG}"`,
  route: `POST /api/pool/${SRC_POOL}/messages/:id/move { to: "${DST_POOL}" }`,
  expected: EXPECT,
  selected: selected.length,
  ids: selected.map((m) => m.id),
  moved,
  randomRestored,
  counts: { before: countsBefore, after: countsAfter },
  pools: { [SRC_POOL]: { before: dialogBefore, after: dialogAfter }, [DST_POOL]: { before: notifBefore, after: notifAfter } },
  alertsUntouched: alertsBefore.length,
  leftovers: leftovers.length,
  problems,
  sample: snapshot(afterById.get(selected[0].id)),
};

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);

console.log('');
console.log(`moved         ${moved} record(s)  (random restored on ${randomRestored}${randomAlready ? `, not needed on ${randomAlready}` : ''})`);
console.log(`after         all ${countsAfter.all}  ${SRC_POOL} ${dialogAfter}  ${DST_POOL} ${notifAfter}${countsAfter.wall !== undefined ? `  wall ${countsAfter.wall}` : ''}`);
console.log(`pool check    ${SRC_POOL} ${dialogBefore} -> ${dialogAfter}, ${DST_POOL} ${notifBefore} -> ${notifAfter}`);
console.log(`alerts        ${alertsBefore.length} unchanged${problems.some((p) => p.includes('(alert)')) ? ' — NO, see problems' : ''}`);
console.log(`leftovers     ${leftovers.length} banner(s) still in ${SRC_POOL}`);
console.log(`marker        ${MARKER}  (${marker.at})`);

if (problems.length) {
  console.error('');
  for (const p of problems.slice(0, 25)) console.error(`  PROBLEM  ${p}`);
  die(`${problems.length} problem(s) — the pool is in a half-moved state, inspect before re-running`);
}
if (leftovers.length) die(`${leftovers.length} banner(s) still in ${SRC_POOL} — re-run to finish`);

console.log(moved === 0 ? '\nok — nothing to move (this was a re-run)' : '\nok');
