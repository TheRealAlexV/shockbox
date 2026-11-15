// Which page clients are provably stale — pure, so it can be tested without a server.
//
// The rule the operator asked for: a document left on an old build is one that failed to reload
// (the page reloads itself when `/build` disagrees with the `?v=` it loaded with). So a client on
// build `B` proves that any *other* client on the same role, carrying a different non-empty build,
// is a leftover. It is still holding an `/events` SSE and possibly a camera-stream reader, and both
// count against the per-origin socket budget and against the camera's consumer count.
//
// What is deliberately NOT stale:
//   - a client whose build is unknown (null / empty). A page that has not reported a build is not
//     provably stale, and an old cached document may predate the build report entirely.
//   - a client with no role. Roleless rows cannot be grouped, so "same role" cannot be established
//     (these are documents cached from before `?role=` existed).
//   - a client whose role has no healthy current-build peer. A half-broken new page must never
//     evict a working old one: the reference itself must have a fresh ack and, when the caller
//     knows the server build, must be on it.
//
// The one exception is a row marked `preview: true` (the pane's iframe). It is a viewer, not a
// page: there is no continuity to preserve, so a preview on a stale build is stale whether or not a
// new preview has appeared. That needs `currentBuild` — the server's own build — and no peer at
// all. A preview never acts as a reference for anything.

/** How recent an ack must be for a client to count as a healthy reference. Mirrors PAGE_FRESH_MS. */
export const STALE_ACK_FRESH_MS = 10_000;

/** A build string as the ledger records it: trimmed, or null when the page never reported one. */
export function normalizeBuild(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The clients that a healthy successor may end.
 *
 * @param {Array<{id: string, role?: string|null, build?: string|null, lastAckAt?: number}>} clients
 * @param {number} now
 * @param {{freshMs?: number, currentBuild?: string|null, actingClientId?: string|null}} [opts]
 *   freshMs        how recent an ack must be to vouch for a role (default STALE_ACK_FRESH_MS)
 *   currentBuild   the server's own build. When given, only a client on this build can be the
 *                  reference, and a stale-build client can never become one (no ping-pong).
 *   actingClientId the client whose request triggered this pass; never returned as a victim.
 * @returns {Array<{id: string, role: string, build: string, referenceId: string,
 *                  referenceBuild: string, reason: string}>} one entry per client to end
 */
export function staleClients(clients, now, opts = {}) {
  const freshMs = Number.isFinite(opts.freshMs) ? opts.freshMs : STALE_ACK_FRESH_MS;
  const currentBuild = normalizeBuild(opts.currentBuild);
  const actingId = typeof opts.actingClientId === 'string' && opts.actingClientId ? opts.actingClientId : null;
  const at = Number.isFinite(now) ? now : Date.now();

  const rows = (Array.isArray(clients) ? clients : [])
    .map((c) => ({
      id: c && typeof c.id === 'string' && c.id ? c.id : null,
      role: c && typeof c.role === 'string' && c.role ? c.role : null,
      build: normalizeBuild(c && c.build),
      lastAckAt: Number(c && c.lastAckAt) || 0,
      preview: Boolean(c && c.preview === true),
    }))
    .filter((r) => r.id && r.role);

  // The reference per role: the freshest client that is provably healthy and provably current.
  // Previews never vouch for a role — a viewer cannot prove a page is current.
  const referenceByRole = new Map();
  for (const r of rows) {
    if (!r.build || r.preview) continue;
    if (currentBuild && r.build !== currentBuild) continue;
    const age = r.lastAckAt > 0 ? at - r.lastAckAt : Infinity;
    if (!(age >= 0 && age <= freshMs)) continue;
    const prev = referenceByRole.get(r.role);
    if (!prev || r.lastAckAt > prev.lastAckAt) referenceByRole.set(r.role, r);
  }

  const out = [];
  for (const r of rows) {
    if (actingId && r.id === actingId) continue; // never end the client this request is about
    if (!r.build) continue; // unknown build is not provably stale
    // A preview is a viewer, not a page: there is no continuity to preserve, so it needs no healthy
    // peer. Its stale verdict is a build mismatch against the server's own build, and nothing else.
    if (r.preview) {
      if (!currentBuild || r.build === currentBuild) continue;
      out.push({
        id: r.id,
        role: r.role,
        build: r.build,
        preview: true,
        referenceId: null,
        referenceBuild: currentBuild,
        reason: `preview build ${r.build} != server ${currentBuild}`,
      });
      continue;
    }
    const reference = referenceByRole.get(r.role);
    if (!reference) continue;
    if (r.id === reference.id) continue; // never end the client that just vouched for its role
    if (r.build === reference.build) continue;
    out.push({
      id: r.id,
      role: r.role,
      build: r.build,
      preview: false,
      referenceId: reference.id,
      referenceBuild: reference.build,
      reason: `build ${r.build} != ${reference.build}`,
    });
  }
  return out;
}
