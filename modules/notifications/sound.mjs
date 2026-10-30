// Sound clip store + player, owned by the notifications module and shared with the dialogs
// overlay. Core names no module, so this is not core code: both pages load
// `/mod/notifications/sound.mjs` (core's module-static fallback), and both modules' routes use
// the server half below.
//
// Server side (`createSoundDir`): where the clips live, which names are legal, `/audio/<name>`.
//   · The directory is a flag, not a constant: `--sounds <dir>` (env SHOCKBOX_SOUNDS, config
//     `soundsDir`), read in server.mjs and handed to the notifications module in `init`.
//     Nothing here knows the rig path; the default (`C:\OBS\Sounds\SoundBoard`) is server.mjs's.
//   · A missing or unreadable directory is not an error: `list()` returns [] and `resolve()`
//     returns null, so `/api/audio/list` is empty and `/audio/<name>` answers 404 with a message.
//
// Client side (`createPlayer`): one `<audio>` per clip, created only when sound is on, created
// lazily when a clip is first wanted, preloaded on settings change, played at `volume` for a
// newly seen record, and retried once after an autoplay block on the next gesture.

import fs from 'node:fs';
import path from 'node:path';

/* --------------------------------------------------------------- server */

// A name must end in a known extension and contain no path separator and no dot-segment.
// The character class is as wide as the original app's: real files carry brackets, quotes,
// apostrophes and ampersands. Traversal is still impossible — the resolved path must equal
// `<dir>/<basename>` exactly, on top of the separator and `..` checks.
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
export const AUDIO_NAME_RE = /^[A-Za-z0-9 ._\-[\]()'&+]+\.(mp3|wav|ogg|m4a)$/i;
export const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

/** The default tone names. A stale name in a saved document is replaced by one of these. */
export const DEFAULT_NOTIFY_TONE = 'iphone_16_messege_tone.mp3';
export const DEFAULT_DIALOG_TONE = 'error_CDOxCYm.mp3';
export const DEFAULT_TONES = [DEFAULT_DIALOG_TONE, DEFAULT_NOTIFY_TONE];

/**
 * `dir` may be null/empty (no flag, no config): the store is then "absent", which behaves like
 * a missing directory — empty list, every name refused, every play 404s with a message.
 */
export function createSoundDir(dir) {
  const root = typeof dir === 'string' && dir.trim() ? path.resolve(dir.trim()) : null;

  /** Clip names in the directory, sorted. `null` when the directory cannot be read. */
  function list() {
    if (!root) return null;
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isFile() && AUDIO_NAME_RE.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    } catch {
      return null;
    }
  }

  /** Absolute path for a legal, contained name, or null. Never follows a symlink out. */
  function resolve(name) {
    if (!root) return null;
    if (typeof name !== 'string' || !name || name !== name.trim()) return null;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
    if (!AUDIO_NAME_RE.test(name)) return null;
    const full = path.resolve(root, name);
    if (full !== path.join(path.resolve(root), path.basename(name))) return null;
    return full;
  }

  function describe() {
    const files = list();
    return { dir: root, available: files !== null, count: files ? files.length : 0 };
  }

  return { root, list, resolve, describe };
}

/* --------------------------------------------------------------- client */

/**
 * @param {object} opts
 * @param {(name: string) => string} [opts.urlFor]  clip name → URL
 * @param {boolean} [opts.instrument]  expose the record as `window.__pageAudio` (tests)
 */
export function createPlayer(opts = {}) {
  const urlFor = opts.urlFor || ((name) => `/audio/${encodeURIComponent(name)}`);
  const clips = new Map(); // name -> HTMLAudioElement
  const seen = new Set(); // record ids already announced
  let seeded = false;
  let soundOn = false;
  let volume = 1;
  let wanted = []; // clip names to preload
  let blocked = null; // clip name that autoplay refused
  let armed = false;
  let rec = null; // the instrument record this player publishes as `window.__pageAudio`

  const AUDIO = typeof window !== 'undefined' ? window.Audio : undefined;

  function setEnabled(on) {
    if (soundOn === (on === true)) return;
    soundOn = on === true;
    if (!soundOn) {
      // Sound turned off: drop the elements so nothing can play behind the operator's back.
      for (const el of clips.values()) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        el.removeAttribute('src');
      }
      clips.clear();
      blocked = null;
      return;
    }
    if (!AUDIO) return;
    for (const name of wanted) ensure(name);
  }

  function setVolume(v) {
    const n = Number(v);
    volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  }

  /** Which clips this page wants preloaded, in priority order. */
  function want(names) {
    wanted = Array.from(new Set((names || []).filter((n) => typeof n === 'string' && n)));
    if (!soundOn || !AUDIO) return;
    for (const name of wanted) ensure(name);
  }

  function ensure(name) {
    if (!soundOn || !AUDIO || !name) return null;
    let el = clips.get(name);
    if (el) return el;
    el = new AUDIO();
    el.preload = 'auto';
    el.setAttribute('aria-hidden', 'true');
    el.src = urlFor(name);
    clips.set(name, el);
    if (opts.instrument && typeof window !== 'undefined') {
      // The record is owned here, not by whatever `window` happens to hold: the overlay never
      // touches it, and a page that resets it (tests) never has to know the array's identity.
      if (!rec) rec = { els: [], plays: 0 };
      rec.els.push(el);
      window.__pageAudio = rec;
    }
    try {
      el.load();
    } catch {
      /* ignore */
    }
    return el;
  }

  function playClip(name) {
    if (!soundOn || !name) return null;
    const el = ensure(name);
    if (!el) return null;
    if (opts.instrument && typeof window !== 'undefined' && window.__pageAudio) window.__pageAudio.plays++;
    // Volume is read at play time, so a change applies to the next clip.
    el.volume = volume;
    try {
      el.currentTime = 0;
    } catch {
      /* ignore */
    }
    let p = null;
    try {
      p = el.play();
    } catch {
      return el;
    }
    // Autoplay blocked (no gesture yet): remember the clip and retry once on the next input.
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        blocked = name;
        arm();
      });
    }
    return el;
  }

  function arm() {
    if (armed) return;
    armed = true;
    const retry = () => {
      document.removeEventListener('pointerdown', retry, true);
      document.removeEventListener('keydown', retry, true);
      armed = false;
      const name = blocked;
      if (!name) return;
      blocked = null;
      playClip(name);
    };
    document.addEventListener('pointerdown', retry, true);
    document.addEventListener('keydown', retry, true);
  }

  /** The clip name a newly seen record should play, or null to stay silent. */
  function clipFor(record) {
    const s = record && record.sound;
    if (s === 'none') return null;
    // A record may name its own clip; otherwise the page's two preloaded slots decide.
    if (record && typeof record.tone === 'string' && record.tone) return record.tone;
    if (s === 'dialog') return wanted[0] || null;
    if (s === 'notify') return wanted[1] || wanted[0] || null;
    return wanted[0] || null;
  }

  /**
   * One sound per newly seen id. `sync(list, {seed: true})` only records the ids without
   * playing — call it for a page's first payload, so a page load (or reconnect) over existing
   * banners stays silent. Everything else plays for ids this player has never seen.
   * Returns the ids it played for (tests).
   */
  function sync(list, opts = {}) {
    const items = Array.isArray(list) ? list : [];
    const played = [];
    if (opts.seed || !seeded) {
      seeded = true;
      for (const d of items) seen.add(d.id);
      return played;
    }
    for (const d of items) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const name = clipFor(d);
      if (name) {
        played.push(d.id);
        playClip(name);
      }
    }
    // Keep the set from growing without bound on a long stream.
    if (seen.size > 800) {
      const keep = new Set(items.map((d) => d.id));
      for (const id of seen) if (!keep.has(id)) seen.delete(id);
    }
    return played;
  }

  return {
    setEnabled,
    setVolume,
    want,
    sync,
    playClip,
    ensure,
    get enabled() {
      return soundOn;
    },
    get clips() {
      return clips;
    },
    clipFor,
  };
}
