// The stale-build rule, tested as the pure function it is — no server, no browser, no OBS.
//
// Run: node test/handfx-stale-clients.mjs
//
// What is pinned:
//   1. an old-build client on the same role is ended when a current-build client acks
//   2. a client that has not reported a build is KEPT — it is not provably stale
//   3. a current-build client alone ends nothing
//   4. a stale client is kept when no healthy current-build peer exists for its role
//   5. the acting (just-acked) client is never a victim, and a stale actor cannot evict a
//      current-build page — no ping-pong
//   6. a role-less row (a document cached before `?role=`) is never touched

import assert from 'node:assert/strict';
import { staleClients, normalizeBuild } from '../modules/handfx/stale-clients.mjs';

const NOW = 1_000_000;
const OLD = 'f6f5d7b50de5';
const NEW = '7a2d6b85ba1a';
const ROLE = '/shockfx';

const client = (id, build, extra = {}) => ({
  id,
  role: ROLE,
  build,
  lastAckAt: NOW - 200,
  ...extra,
});

const ids = (out) => out.map((v) => v.id).sort();

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

check('1. old build + new build, same role -> old ended, new kept', () => {
  // The production shape: the server knows its build, so only a client on it can be the reference.
  const out = staleClients([client('9384e388', OLD), client('bc0f6910', NEW)], NOW, { currentBuild: NEW });
  assert.deepEqual(ids(out), ['9384e388']);
  assert.equal(out[0].referenceId, 'bc0f6910');
  assert.equal(out[0].referenceBuild, NEW);
  assert.match(out[0].reason, /build f6f5d7b50de5 != 7a2d6b85ba1a/);
});

check('1b. without a server build the freshest ack is the reference', () => {
  const rows = [client('9384e388', OLD, { lastAckAt: NOW - 400 }), client('bc0f6910', NEW, { lastAckAt: NOW - 100 })];
  assert.deepEqual(ids(staleClients(rows, NOW)), ['9384e388']);
});

check('2. unknown build + new build, same role -> unknown kept', () => {
  assert.deepEqual(staleClients([client('nolbuild', null), client('bc0f6910', NEW)], NOW), []);
});

check('3. new build alone -> nothing ended', () => {
  assert.deepEqual(staleClients([client('bc0f6910', NEW)], NOW), []);
});

check('4. stale build with no healthy current peer -> nothing ended', () => {
  // Server is on NEW; the only clients are two old ones, both acking. No healthy replacement
  // exists, so the rule must not pick one stale row to kill the other. This is the human's call.
  const rows = [client('a', OLD), client('b', 'c0ffee123456')];
  assert.deepEqual(staleClients(rows, NOW, { currentBuild: NEW }), []);
});

check('5. acting client is never a victim; a stale actor cannot evict a current page', () => {
  // The old-build client acks afterward: it must not become the reference and kill the new one.
  const rows = [client('old', OLD, { lastAckAt: NOW }), client('new', NEW, { lastAckAt: NOW - 400 })];
  const out = staleClients(rows, NOW, { currentBuild: NEW, actingClientId: 'old' });
  assert.deepEqual(ids(out), []);
});

check('6. role-less row is never touched', () => {
  const rows = [client('legacy', OLD, { role: null }), client('new', NEW)];
  assert.deepEqual(ids(staleClients(rows, NOW)), []);
});

check('7. build strings are normalized before comparison', () => {
  assert.equal(normalizeBuild('  '), null);
  assert.equal(normalizeBuild(undefined), null);
  assert.equal(normalizeBuild(' 7a2d '), '7a2d');
  // A blanket of whitespace is not a build, so it is not provably stale either.
  assert.deepEqual(staleClients([client('blank', '   '), client('new', NEW)], NOW), []);
});

check('8. two old-build siblings are both ended by one current ack', () => {
  const rows = [client('old1', OLD), client('old2', 'deadbeef0000'), client('new', NEW)];
  assert.deepEqual(ids(staleClients(rows, NOW, { currentBuild: NEW })), ['old1', 'old2']);
});

// --- previews: a viewer has no continuity to preserve -------------------------------------------

check('9. stale preview with no peer -> ended (a viewer needs no replacement)', () => {
  const rows = [client('prev-old', OLD, { role: '/shockfx/preview', preview: true })];
  const out = staleClients(rows, NOW, { currentBuild: NEW });
  assert.deepEqual(ids(out), ['prev-old']);
  assert.equal(out[0].preview, true);
  assert.equal(out[0].referenceId, null);
  assert.match(out[0].reason, /preview build f6f5d7b50de5 != server 7a2d6b85ba1a/);
});

check('10. stale preview with a healthy current peer -> ended; the current one kept', () => {
  const rows = [
    client('prev-old', OLD, { role: '/shockfx/preview', preview: true }),
    client('prev-new', NEW, { role: '/shockfx/preview', preview: true }),
  ];
  assert.deepEqual(ids(staleClients(rows, NOW, { currentBuild: NEW })), ['prev-old']);
});

check('11. current-build preview beside a current-build source -> neither ended', () => {
  const rows = [client('src', NEW), client('prev', NEW, { role: '/shockfx/preview', preview: true })];
  assert.deepEqual(staleClients(rows, NOW, { currentBuild: NEW }), []);
});

check('12. a current-build preview cannot vouch for a stale source (guard rail 5 holds)', () => {
  const rows = [client('src-old', OLD), client('prev', NEW, { role: '/shockfx/preview', preview: true })];
  assert.deepEqual(staleClients(rows, NOW, { currentBuild: NEW }), []);
});

check('13. a preview with no server build is not provably stale -> kept', () => {
  const rows = [client('prev-old', OLD, { role: '/shockfx/preview', preview: true })];
  assert.deepEqual(staleClients(rows, NOW), []);
});

check('14. the acting preview itself is never the victim', () => {
  const rows = [
    client('prev-old', OLD, { role: '/shockfx/preview', preview: true }),
    client('prev-actor', NEW, { role: '/shockfx/preview', preview: true, lastAckAt: NOW }),
  ];
  assert.deepEqual(ids(staleClients(rows, NOW, { currentBuild: NEW, actingClientId: 'prev-actor' })), ['prev-old']);
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
