// The tone clips: where they live, /api/audio/list, and /audio/<name>.
//
// Shared by both modules (notifications owns the file, dialogs imports it), mounted by
// notifications. The notifications module takes the directory from its `init` context
// (`ctx.sounds`, from `--sounds`/`SHOCKBOX_SOUNDS`/config `soundsDir`); dialogs gets the same
// store off `ctx.notifications.sounds` when its init runs (notifications is order 20, dialogs
// order 30), so the directory is resolved in exactly one place.

import fs from 'node:fs';
import path from 'node:path';
import { createSoundDir, AUDIO_MIME, DEFAULT_TONES } from './sound.mjs';

export function createSounds(ctx) {
  const dir = ctx.sounds ? createSoundDir(ctx.sounds) : createSoundDir(ctx.core && ctx.core.soundsDir);

  /** `dir` names the shared root, not the module: core names no module and this route is
   *  not under a module prefix. Mode is disclosed because the list is a menu. */
  function listRoute() {
    const files = dir.list();
    return {
      ok: true,
      available: files !== null,
      dir: dir.root,
      files: files || [],
      error: files === null ? (dir.root ? `cannot read ${dir.root}` : 'no sound directory configured (--sounds <dir>)') : null,
      defaults: DEFAULT_TONES,
    };
  }

  function serve(req, res, rawName) {
    const fail = (status, error) => {
      const text = JSON.stringify({ ok: false, error });
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
      return undefined;
    };
    // The raw path is checked before any decoding/normalisation can fold `/audio/../x` away.
    if (!dir.root) return fail(404, 'no sound directory configured (--sounds <dir>)');
    let name;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return fail(403, 'forbidden');
    }
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return fail(403, 'forbidden');
    const full = dir.resolve(name);
    if (!full) return fail(404, 'not found');
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      return fail(404, `no clip ${name} in ${dir.root}`);
    }
    if (!st.isFile()) return fail(404, `no clip ${name} in ${dir.root}`);
    res.writeHead(200, {
      'content-type': AUDIO_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'public, max-age=3600',
      'accept-ranges': 'none',
      'x-accel-buffering': 'no',
    });
    if (req.method === 'HEAD') {
      res.end();
      return undefined;
    }
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return undefined;
  }

  function files() {
    return dir.list() || [];
  }

  /**
   * Is this a name the directory currently offers? A missing directory accepts only the
   * defaults and the current values (so a wrong machine cannot persist a typo, but a document
   * written on the rig still loads).
   */
  function has(name, keep = []) {
    if (typeof name !== 'string' || !name) return false;
    if (dir.resolve(name) === null) return false;
    const list = dir.list();
    if (list === null) return DEFAULT_TONES.includes(name) || keep.includes(name);
    return list.includes(name);
  }

  return { dir, listRoute, serve, files, has };
}
