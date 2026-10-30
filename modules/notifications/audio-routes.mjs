// The audio routes both popup modules use. notifications owns them (it owns the tone
// settings); dialogs imports this one function so the two modules speak one shape.
//
//   GET  /api/<id>/audio/list  → {ok, available, dir, files[], error, defaults[], key}
//                                (`available:false` + `error` when the directory cannot be read)
//   GET|POST /api/<id>/settings accepts `tone` (notifications) / `tone` (dialogs), validated
//                              against the directory via `sounds.has()`.
//
// The clip route is NOT here: it is the origin-level `/audio/<name>` (see ./audio.mjs), because
// the core static fallback would shadow any path under `/api/<id>/audio/`.

import { HttpError } from '../../core/id.mjs';

/** The list route for a module that has `mod.audio` (a createSounds instance) and `mod.sounds`. */
export function audioListRoute(mod, key = 'tone') {
  return {
    method: 'GET',
    path: '/audio/list',
    handler() {
      const out = mod.audio.listRoute();
      // A missing directory is a normal rig state, not a failure: the pane keeps a plain text
      // field and the operator sees why. Both modules answer the same shape.
      return { ...out, key };
    },
  };
}

/** Validate a `tone` in a settings patch against the live directory. */
export function checkTone(mod, body, key = 'tone') {
  if (!body || body[key] === undefined) return;
  const keep = [mod.settings.get(key)];
  if (!mod.audio.has(body[key], keep)) {
    throw new HttpError(400, `${key} must be one of: ${mod.audio.files().join(', ') || '(none — is the sound directory set?)'}`);
  }
}
